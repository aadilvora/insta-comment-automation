/**
 * Invest With Clarity - Automation & Keyword Processing Engine
 * Orchestrates comment parsing, keyword matching, campaign execution,
 * public replies, initial private replies, and post-DM sequences.
 */

const { queryOne, queryAll, execute } = require('../database/db');
const LoggerService = require('./loggerService');
const PolicyChecker = require('./policyChecker');
const CampaignService = require('./campaignService');
const metaApiClient = require('./metaApiClient');
const MetaErrors = require('./metaErrors');
const config = require('../config');

class AutomationEngine {
  /**
   * Match an incoming comment against active campaigns for a given post/reel.
   */
  static matchCampaign(postId, commentText) {
    if (!commentText || typeof commentText !== 'string') return null;

    // Fetch active campaigns targeting this post ID (or global wildcard '*')
    const campaigns = queryAll(
      `SELECT * FROM campaigns 
       WHERE status = 'ACTIVE' AND is_active = 1 AND (post_id = ? OR post_id = '*')`,
      [postId]
    );

    if (!campaigns || campaigns.length === 0) {
      return null;
    }

    const cleanComment = commentText.trim().toLowerCase();

    for (const campaign of campaigns) {
      let keywords = [];
      try {
        keywords = JSON.parse(campaign.keywords);
      } catch (e) {
        keywords = campaign.keywords.split(',').map(k => k.trim());
      }

      for (const rawKw of keywords) {
        const kw = rawKw.trim().toLowerCase();
        if (!kw) continue;

        if (campaign.match_type === 'exact') {
          // Exact match comparison
          if (cleanComment === kw) {
            return { campaign, matchedKeyword: kw };
          }
        } else {
          // Contains match using word-boundary-aware check or substring
          const regex = new RegExp(`\\b${this.escapeRegex(kw)}\\b`, 'i');
          if (regex.test(cleanComment) || cleanComment.includes(kw)) {
            return { campaign, matchedKeyword: kw };
          }
        }
      }
    }

    return null;
  }

  /**
   * Process an incoming comment event from Instagram Webhook.
   *
   * Order matters. The public reply and the private reply are two different Meta
   * endpoints with two different rule sets, and the public reply has neither the
   * one-per-comment limit nor the 7-day limit. They are therefore attempted
   * independently: a commenter who cannot be DMed still gets their public reply.
   */
  static async processComment(commentEvent) {
    const {
      id: commentId,
      text: commentText = '',
      from = {},
      media = {},
      created_time: createdTime
    } = commentEvent;

    const postId = media.id || 'unknown_post';
    // Instagram omits `from` on some comment webhooks. That is a payload shape,
    // not a reason to drop the comment: the public reply only needs the comment id.
    const userId = from.id || `anon_${commentId}`;
    const username = from.username || 'Investor';

    LoggerService.log({
      postId,
      commentId,
      userId,
      action: 'WEBHOOK_RECEIVED',
      status: 'SUCCESS',
      details: { text: commentText, username, hasSender: Boolean(from.id) }
    });

    // 1. Deduplication. Only a settled comment is skipped; one that failed for a
    //    retryable reason is allowed through again.
    const state = PolicyChecker.getCommentState(commentId);
    if (!state.shouldProcess) {
      LoggerService.log({
        postId,
        commentId,
        userId,
        action: 'COMMENT_DEDUPLICATION',
        status: 'SKIPPED',
        details: {
          message: 'Comment already handled. Deduplicating event.',
          privateReplyStatus: state.row?.private_reply_status,
          errorCategory: state.row?.error_category || null,
          attempts: state.attempts
        }
      });
      return { skipped: true, reason: 'DUPLICATE_COMMENT' };
    }

    if (state.seen) {
      LoggerService.log({
        postId,
        commentId,
        userId,
        action: 'COMMENT_RETRY',
        status: 'WARNING',
        details: {
          message: 'Re-attempting a comment whose previous delivery failed for a retryable reason.',
          previousCategory: state.row?.error_category || null,
          attempt: state.attempts + 1
        }
      });
    }

    // 2. Emergency stop or automation paused check
    if (PolicyChecker.isEmergencyStopActive()) {
      LoggerService.log({
        postId,
        commentId,
        userId,
        action: 'EMERGENCY_STOP',
        status: 'WARNING',
        details: 'Emergency stop is active. Halting all outbound comment processing.'
      });
      return { skipped: true, reason: 'EMERGENCY_STOP_ACTIVE' };
    }

    if (PolicyChecker.isAutomationPaused()) {
      return { skipped: true, reason: 'AUTOMATION_PAUSED' };
    }

    // 3. Campaign Matching
    const matchResult = this.matchCampaign(postId, commentText);
    const commentTime = createdTime
      ? new Date(createdTime * 1000).toISOString()
      : new Date().toISOString();

    if (!matchResult) {
      this.saveComment({
        commentId, postId, userId, username, commentText, commentTime,
        campaignId: null,
        publicReplyStatus: 'disabled',
        privateReplyStatus: 'disabled',
        attempts: state.attempts
      });

      LoggerService.log({
        postId,
        commentId,
        userId,
        action: 'NO_CAMPAIGN_MATCH',
        status: 'SKIPPED',
        details: { comment: commentText }
      });
      return { matched: false };
    }

    const { campaign, matchedKeyword } = matchResult;

    LoggerService.log({
      campaignId: campaign.id,
      postId,
      commentId,
      userId,
      action: 'KEYWORD_MATCH',
      status: 'SUCCESS',
      details: { campaign: campaign.name, matchedKeyword, commentText }
    });

    // 4. PUBLIC REPLY — attempted first and on its own terms.
    //    Meta places no per-comment or 7-day limit on a comment reply, so a
    //    private-reply restriction must never suppress it.
    let publicReplyStatus = 'disabled';
    let publicReplyId = null;

    if (campaign.public_reply_enabled && campaign.public_reply_text) {
      const publicText = this.interpolate(campaign.public_reply_text, {
        username,
        first_name: username
      });

      try {
        const replyRes = await metaApiClient.replyToComment(commentId, publicText, {
          campaignId: campaign.id,
          userId,
          commentId
        });
        publicReplyStatus = 'sent';
        publicReplyId = replyRes?.id || null;

        execute(
          `INSERT INTO outbound_messages (user_id, comment_id, campaign_id, message_type, message_content, meta_message_id, status)
           VALUES (?, ?, ?, 'public_reply', ?, ?, 'sent')`,
          [userId, commentId, campaign.id, publicText, publicReplyId]
        );

        LoggerService.log({
          campaignId: campaign.id,
          postId,
          commentId,
          userId,
          action: 'PUBLIC_REPLY_SENT',
          status: 'SUCCESS',
          details: { text: publicText }
        });
      } catch (err) {
        const blocked = err.code === 'BLOCKED_BY_POLICY';
        const verdict = blocked ? null : MetaErrors.classify(err);
        publicReplyStatus = blocked ? 'blocked_by_policy' : 'failed';

        execute(
          `INSERT INTO outbound_messages (user_id, comment_id, campaign_id, message_type, message_content, status, error_message, error_category)
           VALUES (?, ?, ?, 'public_reply', ?, ?, ?, ?)`,
          [userId, commentId, campaign.id, publicText, publicReplyStatus, err.message, verdict?.category || null]
        );

        LoggerService.log({
          campaignId: campaign.id,
          postId,
          commentId,
          userId,
          action: blocked ? 'PUBLIC_REPLY_BLOCKED' : 'PUBLIC_REPLY_ERROR',
          status: blocked ? 'WARNING' : 'FAILURE',
          details: {
            error: err.message,
            reason: err.reason || null,
            category: verdict?.category || null,
            blame: verdict?.blame || null,
            explanation: verdict?.explanation || err.reason || null,
            willRetry: Boolean(verdict?.retryable)
          }
        });
      }
    }

    // 5. PRIVATE REPLY — its own eligibility gate, evaluated after the public
    //    reply has already had its chance.
    let privateReplyStatus = 'pending';
    let privateReplyId = null;
    let errorCategory = null;

    const policyResult = PolicyChecker.canSendPrivateReply(
      commentId,
      createdTime ? new Date(createdTime * 1000) : new Date()
    );

    if (!policyResult.allowed) {
      privateReplyStatus = 'blocked_by_policy';
      errorCategory = policyResult.reason;

      LoggerService.log({
        campaignId: campaign.id,
        postId,
        commentId,
        userId,
        action: 'PRIVATE_REPLY_BLOCKED',
        status: 'WARNING',
        details: policyResult
      });
    } else {
      // one_shot puts everything in this single message. The follow-up path
      // needs an open messaging window, and a window only exists if the app is
      // subscribed to the account's messages webhook; a private reply to a
      // comment needs no window, so this is the delivery that always works.
      const oneShot = campaign.delivery_mode === 'one_shot';
      const body = oneShot
        ? [campaign.initial_private_reply_text, campaign.report_text]
            .filter(t => t && t.trim())
            .join('\n\n')
        : campaign.initial_private_reply_text;

      const privateText = this.interpolate(body, {
        username,
        first_name: username
      });

      try {
        const dmRes = await metaApiClient.sendPrivateReply(commentId, privateText, {
          campaignId: campaign.id,
          userId,
          commentId
        });
        privateReplyStatus = 'sent';
        privateReplyId = dmRes?.message_id || null;

        execute(
          `INSERT INTO outbound_messages (user_id, comment_id, campaign_id, message_type, message_content, meta_message_id, status)
           VALUES (?, ?, ?, 'private_reply', ?, ?, 'sent')`,
          [userId, commentId, campaign.id, privateText, privateReplyId]
        );

        if (oneShot) {
          // The report genuinely went out, in the same message. Recording it
          // keeps "reports delivered" truthful instead of permanently zero.
          execute(
            `INSERT INTO outbound_messages (user_id, comment_id, campaign_id, message_type, message_content, meta_message_id, status)
             VALUES (?, ?, ?, 'report', ?, ?, 'sent')`,
            [userId, commentId, campaign.id, campaign.report_text || privateText, privateReplyId]
          );
        }

        // Meta delivers a private reply into the person's Message Requests folder.
        // Nothing further may be sent until they accept and write back — that is
        // what opens the 24-hour window. Record the wait explicitly.
        execute(
          `INSERT INTO user_threads (user_id, username, first_name, current_campaign_id, conversation_stage, dm_state, dm_state_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending_acceptance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET
             current_campaign_id = excluded.current_campaign_id,
             conversation_stage = excluded.conversation_stage,
             dm_state = CASE WHEN user_threads.dm_state = 'accepted' THEN 'accepted'
                             ELSE 'pending_acceptance' END,
             dm_state_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
          [userId, username, username, campaign.id, oneShot ? 'report_delivered' : 'awaiting_reply']
        );

        LoggerService.log({
          campaignId: campaign.id,
          postId,
          commentId,
          userId,
          action: oneShot ? 'REPORT_DELIVERED' : 'PRIVATE_REPLY_SENT',
          status: 'SUCCESS',
          details: {
            text: privateText,
            messageId: privateReplyId,
            note: 'Delivered to the person\'s Message Requests. The follow-up can only be sent once they accept and reply.'
          }
        });
      } catch (err) {
        const blocked = err.code === 'BLOCKED_BY_POLICY';
        const verdict = blocked ? null : MetaErrors.classify(err);
        privateReplyStatus = blocked ? 'blocked_by_policy' : 'failed';
        errorCategory = blocked ? err.reason : verdict.category;

        execute(
          `INSERT INTO outbound_messages (user_id, comment_id, campaign_id, message_type, message_content, status, error_message, error_category)
           VALUES (?, ?, ?, 'private_reply', ?, ?, ?, ?)`,
          [userId, commentId, campaign.id, privateText, privateReplyStatus, err.message, errorCategory]
        );

        LoggerService.log({
          campaignId: campaign.id,
          postId,
          commentId,
          userId,
          action: blocked ? 'PRIVATE_REPLY_BLOCKED' : 'PRIVATE_REPLY_ERROR',
          status: blocked ? 'WARNING' : 'FAILURE',
          details: {
            error: err.message,
            category: errorCategory,
            blame: verdict?.blame || null,
            explanation: verdict?.explanation || err.reason || null,
            willRetry: Boolean(verdict?.retryable)
          }
        });
      }
    }

    // 6. Record the outcome. An upsert, so a retry updates the existing row
    //    instead of failing on the UNIQUE comment_id constraint.
    this.saveComment({
      commentId, postId, userId, username, commentText, commentTime,
      campaignId: campaign.id,
      publicReplyStatus,
      publicReplyId,
      privateReplyStatus,
      privateReplyId,
      errorCategory,
      attempts: state.attempts
    });

    CampaignService.touchActivity(campaign.id);

    return {
      success: true,
      campaignId: campaign.id,
      publicReplyStatus,
      privateReplyStatus,
      errorCategory
    };
  }

  /**
   * Upsert a comment's outcome. processed_comments.comment_id is UNIQUE, so a
   * plain INSERT threw on every retry and lost the result.
   */
  static saveComment({
    commentId, postId, userId, username, commentText, commentTime,
    campaignId = null, publicReplyStatus = 'pending', publicReplyId = null,
    privateReplyStatus = 'pending', privateReplyId = null,
    errorCategory = null, attempts = 0
  }) {
    execute(
      `INSERT INTO processed_comments (
         comment_id, post_id, user_id, username, comment_text, comment_time,
         matched_campaign_id, public_reply_status, public_reply_id,
         private_reply_status, private_reply_id, error_reason, error_category,
         attempts, last_attempt_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(comment_id) DO UPDATE SET
         matched_campaign_id = excluded.matched_campaign_id,
         public_reply_status = CASE WHEN processed_comments.public_reply_status = 'sent'
                                    THEN 'sent' ELSE excluded.public_reply_status END,
         public_reply_id     = COALESCE(excluded.public_reply_id, processed_comments.public_reply_id),
         private_reply_status = CASE WHEN processed_comments.private_reply_status = 'sent'
                                     THEN 'sent' ELSE excluded.private_reply_status END,
         private_reply_id    = COALESCE(excluded.private_reply_id, processed_comments.private_reply_id),
         error_reason        = excluded.error_reason,
         error_category      = excluded.error_category,
         attempts            = excluded.attempts,
         last_attempt_at     = CURRENT_TIMESTAMP`,
      [
        commentId, postId, userId, username, commentText, commentTime,
        campaignId, publicReplyStatus, publicReplyId,
        privateReplyStatus, privateReplyId, errorCategory, errorCategory,
        attempts + 1
      ]
    );
  }

  /**
   * Process Inbound DM from User (Workflow B & Workflow C).
   * Triggered when a user replies to our initial private reply.
   */
  static async processInboundMessage(messageEvent) {
    const { sender = {}, message = {}, timestamp } = messageEvent;
    const userId = sender.id;
    const userMessageText = message.text || '';

    if (!userId) return { skipped: true, reason: 'NO_SENDER_ID' };

    LoggerService.log({
      userId,
      action: 'INBOUND_DM_RECEIVED',
      status: 'SUCCESS',
      details: { text: userMessageText }
    });

    // 1. Opt-out check ("STOP", "UNSUBSCRIBE")
    const cleanMsg = userMessageText.trim().toUpperCase();
    if (cleanMsg === 'STOP' || cleanMsg === 'UNSUBSCRIBE') {
      execute(
        `UPDATE user_threads SET conversation_stage = 'opted_out', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId]
      );

      const optOutResponse = 'You have been unsubscribed from automated messages from Invest With Clarity. Reply START anytime to resume.';
      try {
        await metaApiClient.sendDirectMessage(userId, optOutResponse, { userId });
      } catch (err) {
        LoggerService.log({
          userId,
          action: 'OPT_OUT_CONFIRMATION_FAILED',
          status: 'WARNING',
          details: { error: err.message }
        });
      }

      LoggerService.log({
        userId,
        action: 'USER_OPTED_OUT',
        status: 'SUCCESS',
        details: { user: userId }
      });
      return { optedOut: true };
    }

    // 2. Open / Refresh the 24-Hour Messaging Window
    const inboundDate = timestamp ? new Date(timestamp) : new Date();
    const windowExpiresAt = new Date(inboundDate.getTime() + 24 * 60 * 60 * 1000);

    // An inbound message is proof the person accepted the message request: Meta
    // only delivers it to us once they have. That acceptance is what opens the
    // 24-hour window, so it is recorded here rather than inferred later.
    execute(
      `INSERT INTO user_threads (user_id, last_inbound_time, messaging_window_expires_at, dm_state, dm_state_at, updated_at)
       VALUES (?, ?, ?, 'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         last_inbound_time = excluded.last_inbound_time,
         messaging_window_expires_at = excluded.messaging_window_expires_at,
         dm_state = 'accepted',
         dm_state_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, inboundDate.toISOString(), windowExpiresAt.toISOString()]
    );

    const justAccepted = queryOne(
      "SELECT 1 AS yes FROM user_threads WHERE user_id = ? AND dm_state = 'accepted'",
      [userId]
    );
    if (justAccepted) {
      LoggerService.log({
        userId,
        action: 'DM_REQUEST_ACCEPTED',
        status: 'SUCCESS',
        details: { message: 'Person accepted the message request. The 24-hour window is open.' }
      });
    }

    // 3. Fetch active thread & campaign
    const thread = queryOne('SELECT * FROM user_threads WHERE user_id = ?', [userId]);
    if (!thread || !thread.current_campaign_id) {
      return { skipped: true, reason: 'NO_ACTIVE_CAMPAIGN_THREAD' };
    }

    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [thread.current_campaign_id]);
    if (!campaign) {
      return { skipped: true, reason: 'CAMPAIGN_DELETED' };
    }
    if (campaign.status !== 'ACTIVE') {
      LoggerService.log({
        campaignId: campaign.id,
        userId,
        action: 'FOLLOW_UP_SKIPPED',
        status: 'SKIPPED',
        details: { reason: `Campaign is ${campaign.status}`, campaign: campaign.name }
      });
      return { skipped: true, reason: `CAMPAIGN_${campaign.status}` };
    }

    // 4. Verify 24-Hour Window Policy
    const windowCheck = PolicyChecker.isMessagingWindowOpen(userId);
    if (!windowCheck.allowed) {
      LoggerService.log({
        campaignId: campaign.id,
        userId,
        action: 'BLOCKED_POLICY',
        status: 'WARNING',
        details: windowCheck
      });
      return { blocked: true, reason: windowCheck.reason };
    }

    // 5. Follower verification.
    //
    // GET /{IGSID}?fields=is_user_follow_business is the only official way to
    // ask, and it answers one of three ways:
    //   true   - they follow
    //   false  - they do not
    //   null   - Meta will not say. In practice this is (#230) "User consent is
    //            required to access user profile", which an app without Advanced
    //            Access gets for every user. It is NOT the same as "false".
    //
    // The old code treated the unverifiable case as following, so a failed check
    // silently delivered the report to everyone and the follow gate did nothing.
    // It is now tracked as unknown and handled explicitly.
    const check = await this.verifyFollower(userId);
    const isFollowing = check.following === true;
    const unverifiable = check.following === null;

    execute(
      `UPDATE user_threads
          SET is_following = ?, follower_checked_at = CURRENT_TIMESTAMP
        WHERE user_id = ?`,
      [check.following === null ? null : (check.following ? 1 : 0), userId]
    );

    // A reply that arrives after we asked them to follow is their answer to that
    // request. Re-checking here is what makes "I followed you now" work; the old
    // code returned REMINDER_ALREADY_SENT_ONCE and the person was stuck forever.
    const answeringReminder = thread.conversation_stage === 'reminder_sent';

    // When Meta will not confirm, the only options are to take the person at
    // their word or to deliver to nobody. Meta's own guidance for this case is
    // self-declaration, so a reply after the reminder is accepted as one. The
    // thread records that it was never actually verified.
    const deliverOnDeclaration = unverifiable && answeringReminder;

    const fallbackApplied = unverifiable;

    // 6. Deliver appropriate message
    if (isFollowing || deliverOnDeclaration || (unverifiable && !campaign.follower_reminder_text)) {
      // Deliver the configured report
      const reportMsg = this.interpolate(campaign.report_text || campaign.follow_up_text, {
        username: thread.username || 'Investor',
        first_name: thread.first_name || 'Investor'
      });

      let messageId;
      try {
        const sendRes = await metaApiClient.sendDirectMessage(userId, reportMsg, {
          campaignId: campaign.id,
          userId
        });
        messageId = sendRes?.message_id || 'mock_report_id';
      } catch (err) {
        const blocked = err.code === 'BLOCKED_BY_POLICY';

        execute(
          `INSERT INTO outbound_messages (user_id, campaign_id, message_type, message_content, status, error_message)
           VALUES (?, ?, 'report', ?, ?, ?)`,
          [userId, campaign.id, reportMsg, blocked ? 'blocked_by_policy' : 'failed', err.message]
        );

        LoggerService.log({
          campaignId: campaign.id,
          userId,
          action: blocked ? 'REPORT_BLOCKED' : 'REPORT_FAILED',
          status: blocked ? 'WARNING' : 'FAILURE',
          details: { error: err.message, reason: err.reason || null }
        });

        return { delivered: false, blocked, reason: err.reason || 'SEND_FAILED' };
      }

      execute(
        `INSERT INTO outbound_messages (user_id, campaign_id, message_type, message_content, meta_message_id, status)
         VALUES (?, ?, 'report', ?, ?, 'sent')`,
        [userId, campaign.id, reportMsg, messageId]
      );

      CampaignService.touchActivity(campaign.id);

      execute(
        `UPDATE user_threads SET conversation_stage = 'report_delivered', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId]
      );

      LoggerService.log({
        campaignId: campaign.id,
        userId,
        action: 'REPORT_DELIVERED',
        status: 'SUCCESS',
        details: { text: reportMsg, fallbackApplied }
      });

      return { delivered: true, type: 'report' };
    } else {
      // Ask them to follow. Sent at most once per thread: repeating it every
      // time someone writes back would be nagging, and Meta treats that as spam.
      if (!answeringReminder && campaign.follower_reminder_text) {
        const reminderMsg = this.interpolate(campaign.follower_reminder_text, {
          username: thread.username || 'Investor',
          first_name: thread.first_name || 'Investor'
        });

        let messageId;
        try {
          const sendRes = await metaApiClient.sendDirectMessage(userId, reminderMsg, {
            campaignId: campaign.id,
            userId
          });
          messageId = sendRes?.message_id || 'mock_reminder_id';
        } catch (err) {
          const blocked = err.code === 'BLOCKED_BY_POLICY';

          execute(
            `INSERT INTO outbound_messages (user_id, campaign_id, message_type, message_content, status, error_message)
             VALUES (?, ?, 'reminder', ?, ?, ?)`,
            [userId, campaign.id, reminderMsg, blocked ? 'blocked_by_policy' : 'failed', err.message]
          );

          LoggerService.log({
            campaignId: campaign.id,
            userId,
            action: blocked ? 'REMINDER_BLOCKED' : 'REMINDER_FAILED',
            status: blocked ? 'WARNING' : 'FAILURE',
            details: { error: err.message, reason: err.reason || null }
          });

          return { delivered: false, blocked, reason: err.reason || 'SEND_FAILED' };
        }

        execute(
          `INSERT INTO outbound_messages (user_id, campaign_id, message_type, message_content, meta_message_id, status)
           VALUES (?, ?, 'reminder', ?, ?, 'sent')`,
          [userId, campaign.id, reminderMsg, messageId]
        );

        CampaignService.touchActivity(campaign.id);

        execute(
          `UPDATE user_threads SET conversation_stage = 'reminder_sent', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
          [userId]
        );

        LoggerService.log({
          campaignId: campaign.id,
          userId,
          action: 'REMINDER_SENT',
          status: 'SUCCESS',
          details: { text: reminderMsg }
        });

        return { delivered: true, type: 'reminder' };
      }

      // Reached only when they replied after the reminder AND Meta positively
      // says they still do not follow. Not an error, and not a dead end: the
      // next reply re-checks, so following and writing again delivers the report.
      LoggerService.log({
        campaignId: campaign.id,
        userId,
        action: 'STILL_NOT_FOLLOWING',
        status: 'SKIPPED',
        details: {
          message: 'Replied after the follow request but Meta still reports them as not following.',
          willRetryOnNextReply: true
        }
      });
      return { delivered: false, reason: 'STILL_NOT_FOLLOWING' };
    }
  }

  /**
   * Ask Meta whether this person follows the business.
   * Returns { following: true | false | null, reason }.
   *
   * `null` means Meta declined to answer, which is not a "no". Error #230
   * ("User consent is required to access user profile") is returned for every
   * user until the app holds Advanced Access, so on a Development-mode app this
   * is the normal result rather than an exception.
   */
  static async verifyFollower(userId) {
    try {
      const profile = await metaApiClient.getUserProfile(userId);

      if (profile.is_user_follow_business === true) {
        return { following: true, reason: 'META_CONFIRMED' };
      }
      if (profile.is_user_follow_business === false) {
        return { following: false, reason: 'META_CONFIRMED' };
      }
      return {
        following: null,
        reason: profile.fallback_applied ? 'META_WILL_NOT_SAY' : 'FIELD_ABSENT'
      };
    } catch (err) {
      return { following: null, reason: 'LOOKUP_FAILED', error: err.message };
    }
  }

  /**
   * Safely interpolate template variables.
   */
  static interpolate(template, vars = {}) {
    if (!template) return '';
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      return vars[key] !== undefined && vars[key] !== null ? vars[key] : match;
    });
  }

  static escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = AutomationEngine;
