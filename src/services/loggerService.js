/**
 * Invest With Clarity - Activity Logger Service
 * Persists auditable event logs to SQLite and console.
 * Strictly sanitizes secrets and tokens from logs.
 */

const { execute, queryAll, queryOne } = require('../database/db');

class LoggerService {
  /**
   * Log an activity event to SQLite database.
   */
  static log({
    campaignId = null,
    postId = null,
    commentId = null,
    userId = null,
    action,
    status, // 'SUCCESS', 'FAILURE', 'SKIPPED', 'WARNING'
    details = {}
  }) {
    const detailsStr = typeof details === 'string' ? details : JSON.stringify(this.sanitize(details));

    try {
      execute(
        `INSERT INTO activity_logs (campaign_id, post_id, comment_id, user_id, action, status, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [campaignId, postId, commentId, userId, action, status, detailsStr]
      );
    } catch (err) {
      console.error('[LoggerService] Database log error:', err.message);
    }

    // Console output for local observability
    const color = status === 'SUCCESS' ? '\x1b[32m' : status === 'FAILURE' ? '\x1b[31m' : '\x1b[33m';
    console.log(`${color}[${new Date().toISOString()}] [${action}] [${status}]\x1b[0m ${detailsStr}`);
  }

  /**
   * Sanitize objects to never leak access tokens or app secrets.
   */
  static sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const key of Object.keys(sanitized)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('authorization')
      ) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof sanitized[key] === 'object') {
        sanitized[key] = this.sanitize(sanitized[key]);
      }
    }
    return sanitized;
  }

  /**
   * Retrieve recent logs with optional filters and pagination.
   */
  static getRecentLogs({ limit = 50, campaignId = null, action = null, status = null } = {}) {
    let sql = 'SELECT * FROM activity_logs WHERE 1=1';
    const params = [];

    if (campaignId) {
      sql += ' AND campaign_id = ?';
      params.push(campaignId);
    }
    if (action) {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    return queryAll(sql, params);
  }

  /**
   * Get activity summary metrics for the dashboard.
   */
  static getActivityStats() {
    const totalComments = queryOne('SELECT COUNT(*) as count FROM processed_comments')?.count || 0;
    const matchedComments = queryOne('SELECT COUNT(*) as count FROM processed_comments WHERE matched_campaign_id IS NOT NULL')?.count || 0;
    const publicRepliesSent = queryOne("SELECT COUNT(*) as count FROM outbound_messages WHERE message_type = 'public_reply' AND status = 'sent'")?.count || 0;
    const privateRepliesSent = queryOne("SELECT COUNT(*) as count FROM outbound_messages WHERE message_type = 'private_reply' AND status = 'sent'")?.count || 0;
    const successfulDeliveries = queryOne("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'sent'")?.count || 0;
    const failedDeliveries = queryOne("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'failed'")?.count || 0;
    const blockedByPolicy = queryOne("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'blocked_by_policy'")?.count || 0;
    const duplicateIgnored = queryOne("SELECT COUNT(*) as count FROM processed_comments WHERE private_reply_status = 'already_replied'")?.count || 0;

    return {
      totalComments,
      matchedComments,
      publicRepliesSent,
      privateRepliesSent,
      successfulDeliveries,
      failedDeliveries,
      blockedByPolicy,
      duplicateIgnored
    };
  }
}

module.exports = LoggerService;
