/**
 * Invest With Clarity - Messaging Policy & Compliance Enforcer
 * Enforces Meta's official platform restrictions, rate limits, and safety rules:
 * 1. Single private reply per comment rule.
 * 2. 7-day comment eligibility window.
 * 3. 24-hour standard messaging window for subsequent DMs.
 * 4. Transparent handling of follower verification (Meta does NOT support follower checking at comment time).
 * 5. Immediate emergency stop enforcement.
 */

const { queryOne, isEmergencyStopActive, isAutomationPaused } = require('../database/db');
const config = require('../config');
const LoggerService = require('./loggerService');

class PolicyChecker {
  /**
   * Verify if a comment is eligible for an initial private reply.
   * Rules:
   * - Max 1 private reply per comment ID.
   * - Comment must be less than 7 calendar days old.
   */
  static canSendPrivateReply(commentId, commentTimestamp = null) {
    if (this.isEmergencyStopActive()) {
      return { allowed: false, reason: 'EMERGENCY_STOP_ACTIVE' };
    }

    if (this.isAutomationPaused()) {
      return { allowed: false, reason: 'AUTOMATION_PAUSED' };
    }

    // 1. Check if comment ID has already received a private reply
    const existing = queryOne(
      "SELECT id FROM outbound_messages WHERE comment_id = ? AND message_type = 'private_reply' AND status = 'sent'",
      [commentId]
    );

    if (existing) {
      return {
        allowed: false,
        reason: 'SINGLE_REPLY_RULE_VIOLATION',
        details: 'Meta permits only ONE private reply per comment ID. A private reply was already sent.'
      };
    }

    // 2. Check 7-day age restriction
    if (commentTimestamp) {
      const commentDate = new Date(commentTimestamp);
      const now = new Date();
      const diffDays = (now - commentDate) / (1000 * 60 * 60 * 24);

      if (diffDays > 7) {
        return {
          allowed: false,
          reason: 'COMMENT_EXPIRED',
          details: `Comment is ${diffDays.toFixed(1)} days old. Meta restricts private replies to within 7 days.`
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Verify if a user thread is inside the official 24-hour standard messaging window.
   * Rules:
   * - Outside the 24-hour window from the user's last inbound message, subsequent DMs are blocked.
   */
  static isMessagingWindowOpen(userId) {
    if (this.isEmergencyStopActive()) {
      return { allowed: false, reason: 'EMERGENCY_STOP_ACTIVE' };
    }

    const thread = queryOne(
      'SELECT last_inbound_time, messaging_window_expires_at FROM user_threads WHERE user_id = ?',
      [userId]
    );

    if (!thread || !thread.last_inbound_time) {
      return {
        allowed: false,
        reason: 'NO_INBOUND_CONVERSATION',
        details: 'User has not yet initiated or replied in DM. Cannot send freeform follow-up message.'
      };
    }

    const expiresAt = new Date(thread.messaging_window_expires_at);
    const now = new Date();

    if (now > expiresAt) {
      return {
        allowed: false,
        reason: '24_HOUR_WINDOW_EXPIRED',
        details: 'The official 24-hour messaging window has elapsed. Outbound messaging is prohibited by Meta policy.'
      };
    }

    return { allowed: true, expiresAt: thread.messaging_window_expires_at };
  }

  /**
   * Decide whether an incoming comment event should be processed.
   *
   * A row in processed_comments used to mean "never touch this again". That made
   * every failure permanent: one Meta rate limit, one temporary outage, and that
   * commenter could never be reached, because the retry was treated as a duplicate.
   *
   * A comment is finished only when both sides reached a settled state. If the
   * private reply failed for a reason worth retrying, and we are under the attempt
   * ceiling, it is reprocessed instead of being silently dropped.
   */
  static getCommentState(commentId) {
    const row = queryOne(
      `SELECT id, public_reply_status, private_reply_status, error_category, attempts
         FROM processed_comments WHERE comment_id = ?`,
      [commentId]
    );

    if (!row) return { seen: false, shouldProcess: true, attempts: 0 };

    const settled = new Set(['sent', 'disabled', 'blocked_by_policy']);
    const privateSettled = settled.has(row.private_reply_status);
    const publicSettled = settled.has(row.public_reply_status);

    // Categories where trying again cannot change the outcome. Retrying these
    // would be pointless traffic against Meta and, for USER_UNAVAILABLE, would
    // mean repeatedly messaging someone who has chosen not to receive them.
    const terminal = new Set([
      'USER_UNAVAILABLE', 'WINDOW_CLOSED', 'DUPLICATE', 'CONFIG', 'TARGET_NOT_FOUND'
    ]);

    const attempts = row.attempts || 0;
    const maxAttempts = config.safeguards.maxCommentAttempts || 3;

    const retryable =
      !privateSettled &&
      !terminal.has(row.error_category) &&
      attempts < maxAttempts;

    return {
      seen: true,
      shouldProcess: retryable || !publicSettled,
      retryingPrivateReply: retryable,
      attempts,
      row
    };
  }

  /**
   * Back-compatible wrapper. True only when the comment is genuinely finished.
   */
  static isCommentDuplicate(commentId) {
    return !this.getCommentState(commentId).shouldProcess;
  }

  /**
   * Evaluate Follower Verification feasibility according to Meta API rules:
   * - AT COMMENT TIME: Not supported by Meta. Returns compliant guidance.
   * - POST-DM INTERACTION: Supported via is_user_follow_business if user has opened a thread.
   */
  static evaluateFollowerVerification(stage = 'comment_time') {
    if (stage === 'comment_time') {
      return {
        supported: false,
        classification: 'NOT_SUPPORTED',
        guidance: 'Meta does not expose follower checks at comment time. Do not attempt scraping or unofficial APIs. Deliver the initial DM asking the user to follow.'
      };
    }

    return {
      supported: true,
      classification: 'SUPPORTED_WITH_CONDITIONS',
      endpoint: 'GET /{IGSID}?fields=name,username,is_user_follow_business',
      guidance: 'Queryable only after the user replies in DM. If restricted (e.g. EU ePrivacy) or error, fallback gracefully.'
    };
  }

  static isEmergencyStopActive() {
    return isEmergencyStopActive();
  }

  static isAutomationPaused() {
    return isAutomationPaused();
  }
}

module.exports = PolicyChecker;
