/**
 * Invest With Clarity - Statistics Service
 * Every number shown on the dashboard is computed here, straight from SQLite.
 *
 * Two rules this file exists to enforce:
 *  1. Stats are always scoped. A campaign's numbers only ever count rows whose
 *     campaign_id is that campaign; a Reel's numbers only count rows for that
 *     post_id. Nothing is ever summed across Reels by accident.
 *  2. Meta outcomes are reported honestly and separately: sent, failed, and
 *     blocked-by-policy are three different things and never collapsed into one.
 */

const { queryOne, queryAll } = require('../database/db');

const RANGES = {
  today: { label: 'Today', days: 0 },
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  all: { label: 'All time', days: null }
};

class StatsService {
  static get RANGES() {
    return RANGES;
  }

  /**
   * Build a SQL fragment restricting `column` to the requested range.
   * Returns '' for all-time so the query stays unfiltered.
   * Timestamps are written with CURRENT_TIMESTAMP (UTC), and date('now') is also
   * UTC, so the two always line up.
   */
  static rangeClause(column, range = 'all') {
    const key = RANGES[range] ? range : 'all';

    if (key === 'all') return '';
    if (key === 'today') return ` AND date(${column}) = date('now')`;
    return ` AND ${column} >= datetime('now', '-${RANGES[key].days} days')`;
  }

  static count(sql, params = []) {
    const row = queryOne(sql, params);
    return (row && row.count) || 0;
  }

  /**
   * Account-wide overview for the main dashboard (section A).
   */
  static getOverview(range = 'all') {
    const cmt = this.rangeClause('processed_at', range);
    const out = this.rangeClause('sent_at', range);

    const totalComments = this.count(
      `SELECT COUNT(*) as count FROM processed_comments WHERE 1=1${cmt}`
    );

    // "Processed" = the automation reached a decision: it either matched a campaign
    // or was explicitly ruled out. A row still sitting at 'pending' is not counted,
    // so this figure stays honest if processing ever becomes asynchronous.
    const processedComments = this.count(
      `SELECT COUNT(*) as count FROM processed_comments
        WHERE (matched_campaign_id IS NOT NULL
               OR public_reply_status <> 'pending'
               OR private_reply_status <> 'pending')${cmt}`
    );

    const matchedComments = this.count(
      `SELECT COUNT(*) as count FROM processed_comments
        WHERE matched_campaign_id IS NOT NULL${cmt}`
    );

    const publicReplies = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE message_type = 'public_reply' AND status = 'sent'${out}`
    );

    const privateMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE message_type IN ('private_reply', 'follow_up', 'report', 'reminder')
          AND status = 'sent'${out}`
    );

    const successfulMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'sent'${out}`
    );

    const failedMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'failed'${out}`
    );

    const blockedByPolicy = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'blocked_by_policy'${out}`
    );

    const uniqueCommenters = this.count(
      `SELECT COUNT(DISTINCT user_id) as count FROM processed_comments WHERE 1=1${cmt}`
    );

    // A private reply that Meta accepted sits in the person's Message Requests
    // until they tap Accept. That is a normal waiting state, not a failure, and
    // it is the reason a report can look "not sent" while nothing is broken.
    const awaitingAcceptance = this.count(
      `SELECT COUNT(*) as count FROM user_threads WHERE dm_state = 'pending_acceptance'`
    );

    const acceptedThreads = this.count(
      `SELECT COUNT(*) as count FROM user_threads WHERE dm_state = 'accepted'`
    );

    // Comments where Instagram itself refused delivery because of the person's
    // own privacy settings. Counted separately so it never reads as our bug.
    const declinedByRecipient = this.count(
      `SELECT COUNT(*) as count FROM processed_comments
        WHERE error_category = 'USER_UNAVAILABLE'${cmt}`
    );

    const needsAttention = this.count(
      `SELECT COUNT(*) as count FROM processed_comments
        WHERE error_category IN ('CONFIG', 'TARGET_NOT_FOUND')${cmt}`
    );

    // Campaign counts are live state, never range-filtered.
    const byStatus = {};
    for (const row of queryAll('SELECT status, COUNT(*) as count FROM campaigns GROUP BY status')) {
      byStatus[row.status || 'DRAFT'] = row.count;
    }

    return {
      range,
      rangeLabel: (RANGES[range] || RANGES.all).label,
      totalComments,
      processedComments,
      matchedComments,
      publicReplies,
      privateMessages,
      successfulMessages,
      failedMessages,
      blockedByPolicy,
      uniqueCommenters,
      awaitingAcceptance,
      acceptedThreads,
      declinedByRecipient,
      needsAttention,
      campaigns: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        active: byStatus.ACTIVE || 0,
        paused: byStatus.PAUSED || 0,
        draft: byStatus.DRAFT || 0,
        stopped: byStatus.STOPPED || 0,
        error: byStatus.ERROR || 0
      }
    };
  }

  /**
   * Stats for exactly one campaign. Nothing here crosses campaign boundaries.
   */
  static getCampaignStats(campaignId, range = 'all') {
    const cmt = this.rangeClause('processed_at', range);
    const out = this.rangeClause('sent_at', range);

    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) return null;

    // Comments on this campaign's post, whether or not they matched a keyword.
    const commentsReceived = this.count(
      `SELECT COUNT(*) as count FROM processed_comments WHERE post_id = ?${cmt}`,
      [campaign.post_id]
    );

    const keywordMatches = this.count(
      `SELECT COUNT(*) as count FROM processed_comments WHERE matched_campaign_id = ?${cmt}`,
      [campaignId]
    );

    const uniqueCommenters = this.count(
      `SELECT COUNT(DISTINCT user_id) as count FROM processed_comments
        WHERE matched_campaign_id = ?${cmt}`,
      [campaignId]
    );

    const publicReplies = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND message_type = 'public_reply' AND status = 'sent'${out}`,
      [campaignId]
    );

    const privateReplies = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND message_type = 'private_reply' AND status = 'sent'${out}`,
      [campaignId]
    );

    const followUps = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND message_type IN ('follow_up', 'report', 'reminder')
          AND status = 'sent'${out}`,
      [campaignId]
    );

    const successfulMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND status = 'sent'${out}`,
      [campaignId]
    );

    const failedMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND status = 'failed'${out}`,
      [campaignId]
    );

    const blockedByPolicy = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE campaign_id = ? AND status = 'blocked_by_policy'${out}`,
      [campaignId]
    );

    const duplicatesIgnored = this.count(
      `SELECT COUNT(*) as count FROM activity_logs
        WHERE campaign_id = ? AND action = 'COMMENT_DEDUPLICATION'
        ${this.rangeClause('timestamp', range)}`,
      [campaignId]
    );

    const policyBlocked = this.count(
      `SELECT COUNT(*) as count FROM activity_logs
        WHERE campaign_id = ? AND action = 'BLOCKED_POLICY'
        ${this.rangeClause('timestamp', range)}`,
      [campaignId]
    );

    return {
      campaignId: Number(campaignId),
      range,
      commentsReceived,
      keywordMatches,
      uniqueCommenters,
      publicReplies,
      privateReplies,
      followUps,
      successfulMessages,
      failedMessages,
      blockedByPolicy,
      duplicatesIgnored,
      policyBlocked
    };
  }

  /**
   * Stats for one Instagram post/Reel, summed across any campaigns on that post.
   */
  static getPostStats(postId, range = 'all') {
    const cmt = this.rangeClause('processed_at', range);
    const out = this.rangeClause('sent_at', range);

    const commentsReceived = this.count(
      `SELECT COUNT(*) as count FROM processed_comments WHERE post_id = ?${cmt}`,
      [postId]
    );

    const keywordMatches = this.count(
      `SELECT COUNT(*) as count FROM processed_comments
        WHERE post_id = ? AND matched_campaign_id IS NOT NULL${cmt}`,
      [postId]
    );

    // Instagram's own comments_count includes replies to comments and our own
    // account's replies, so it is NOT comparable with what the automation sees.
    // Reporting the difference as "not handled" invented a shortfall that did not
    // exist: on 2026-11-01 a card claimed a missing comment that was in fact the
    // creator's own reply to someone else.
    //
    // The honest figure is what GET /{media-id}/comments actually exposes, minus
    // our own comments, and that is only known after a comment sync has run.
    const post = queryOne(
      `SELECT comments_count, api_comment_count, eligible_comment_count, last_comment_sync_at
         FROM instagram_posts WHERE post_id = ?`,
      [postId]
    );

    const commentsOnInstagram = post?.comments_count ?? null;
    const eligibleOnInstagram = post?.eligible_comment_count ?? null;
    const lastCommentSyncAt = post?.last_comment_sync_at ?? null;

    // Scope outbound messages to the Reel they were actually sent FOR.
    //
    // This used to read `campaign_id IN (SELECT id FROM campaigns WHERE post_id = ?)`,
    // which scopes by the campaign's CURRENT target. Re-point a campaign at a new
    // Reel and every message it ever sent moved onto that Reel's card — a card
    // could show "3 delivered" against 0 comments, because those three were sent
    // for a different post entirely. Statistics must never cross Reels.
    //
    // A message belongs to this Reel when its comment is on this Reel. Follow-ups
    // and reports carry no comment_id, so they are tied through the person who
    // commented here, for the same campaign.
    const scope = `(
      comment_id IN (SELECT comment_id FROM processed_comments WHERE post_id = ?)
      OR (comment_id IS NULL AND user_id IN (
            SELECT user_id FROM processed_comments WHERE post_id = ?
          ) AND campaign_id IN (SELECT id FROM campaigns WHERE post_id = ?))
    )`;

    const publicReplies = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE ${scope} AND message_type = 'public_reply' AND status = 'sent'${out}`,
      [postId, postId, postId]
    );

    const privateReplies = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE ${scope} AND message_type IN ('private_reply','follow_up','report','reminder')
          AND status = 'sent'${out}`,
      [postId, postId, postId]
    );

    const successfulMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages WHERE ${scope} AND status = 'sent'${out}`,
      [postId, postId, postId]
    );

    const failedMessages = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages WHERE ${scope} AND status = 'failed'${out}`,
      [postId, postId, postId]
    );

    const blockedByPolicy = this.count(
      `SELECT COUNT(*) as count FROM outbound_messages
        WHERE ${scope} AND status = 'blocked_by_policy'${out}`,
      [postId, postId, postId]
    );

    return {
      postId,
      range,
      commentsOnInstagram,
      eligibleOnInstagram,
      lastCommentSyncAt,
      commentsReceived,
      // Only claimed once a sync has actually looked. Without that we know how
      // many we handled, but not how many were there to handle.
      unprocessedComments:
        eligibleOnInstagram === null ? null : Math.max(0, eligibleOnInstagram - commentsReceived),
      keywordMatches,
      publicReplies,
      privateReplies,
      successfulMessages,
      failedMessages,
      blockedByPolicy
    };
  }

  /**
   * Daily comment/message counts for the overview chart.
   */
  static getDailySeries(range = '30d', campaignId = null) {
    const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 30;

    const campaignFilterComments = campaignId ? ' AND matched_campaign_id = ?' : '';
    const campaignFilterOutbound = campaignId ? ' AND campaign_id = ?' : '';
    const commentParams = campaignId ? [campaignId] : [];

    const comments = queryAll(
      `SELECT date(processed_at) as day, COUNT(*) as count
         FROM processed_comments
        WHERE processed_at >= datetime('now', '-${days} days')${campaignFilterComments}
        GROUP BY day ORDER BY day`,
      commentParams
    );

    const messages = queryAll(
      `SELECT date(sent_at) as day, COUNT(*) as count
         FROM outbound_messages
        WHERE sent_at >= datetime('now', '-${days} days')
          AND status = 'sent'${campaignFilterOutbound}
        GROUP BY day ORDER BY day`,
      commentParams
    );

    // Fill every day in the window so the chart has no gaps.
    const byDay = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      byDay.set(d, { day: d, comments: 0, messages: 0 });
    }
    for (const row of comments) {
      if (byDay.has(row.day)) byDay.get(row.day).comments = row.count;
    }
    for (const row of messages) {
      if (byDay.has(row.day)) byDay.get(row.day).messages = row.count;
    }

    return Array.from(byDay.values());
  }

  /**
   * Breakdown of how outbound attempts ended, for the delivery panel.
   */
  static getFailureReasons(campaignId = null, range = 'all') {
    const cmt = this.rangeClause('processed_at', range);
    const filter = campaignId ? ' AND matched_campaign_id = ?' : '';
    const params = campaignId ? [campaignId] : [];

    return queryAll(
      `SELECT error_category, COUNT(*) as count
         FROM processed_comments
        WHERE error_category IS NOT NULL${filter}${cmt}
        GROUP BY error_category
        ORDER BY count DESC`,
      params
    );
  }

  static getDeliveryBreakdown(campaignId = null, range = 'all') {
    const out = this.rangeClause('sent_at', range);
    const filter = campaignId ? ' AND campaign_id = ?' : '';
    const params = campaignId ? [campaignId] : [];

    return queryAll(
      `SELECT message_type, status, COUNT(*) as count
         FROM outbound_messages
        WHERE 1=1${filter}${out}
        GROUP BY message_type, status
        ORDER BY message_type`,
      params
    );
  }
}

module.exports = StatsService;
