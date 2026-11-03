/**
 * Invest With Clarity - Campaign Lifecycle Service
 * Owns the campaign status model and every transition between states.
 *
 * Status model:
 *   DRAFT   - saved but never activated. Sends nothing.
 *   ACTIVE  - the only state that sends anything.
 *   PAUSED  - temporarily halted. Queued-but-unsent actions are dropped.
 *   STOPPED - halted for good. Can be restarted if the campaign still validates.
 *   ERROR   - automation hit a failure that needs the creator's attention.
 *
 * `is_active` is kept in sync with `status` (1 only for ACTIVE) so the existing
 * automation engine keeps working unchanged.
 */

const { queryOne, queryAll, execute } = require('../database/db');
const LoggerService = require('./loggerService');

const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'STOPPED', 'ERROR'];

// Which transitions the dashboard is allowed to request.
const ALLOWED_TRANSITIONS = {
  DRAFT: ['ACTIVE', 'STOPPED'],
  ACTIVE: ['PAUSED', 'STOPPED', 'ERROR'],
  PAUSED: ['ACTIVE', 'STOPPED'],
  STOPPED: ['ACTIVE', 'DRAFT'],
  ERROR: ['ACTIVE', 'PAUSED', 'STOPPED', 'DRAFT']
};

class CampaignService {
  static get STATUSES() {
    return STATUSES;
  }

  /**
   * A campaign must be complete enough to actually run before it can go ACTIVE.
   * Returns { valid, errors[] } so the dashboard can show exactly what's missing.
   */
  static validateForActivation(campaign) {
    const errors = [];

    if (!campaign) {
      return { valid: false, errors: ['Campaign not found'] };
    }
    if (!campaign.name || !campaign.name.trim()) {
      errors.push('Campaign name is required');
    }
    if (!campaign.post_id || !campaign.post_id.trim()) {
      errors.push('An Instagram post or Reel must be selected');
    }

    const keywords = this.parseKeywords(campaign.keywords);
    if (keywords.length === 0) {
      errors.push('At least one trigger keyword is required');
    }

    if (!campaign.initial_private_reply_text || !campaign.initial_private_reply_text.trim()) {
      errors.push('An initial private message is required');
    }
    if (campaign.public_reply_enabled && !String(campaign.public_reply_text || '').trim()) {
      errors.push('Public reply is enabled but the reply text is empty');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Move a campaign to a new status, recording the change in history.
   * Refuses transitions that are not allowed, and refuses activation of a
   * campaign that would not actually be able to run.
   */
  static transition(campaignId, toStatus, { reason = null, force = false } = {}) {
    const upper = String(toStatus || '').toUpperCase();

    if (!STATUSES.includes(upper)) {
      return { success: false, error: `Unknown status "${toStatus}"`, code: 'INVALID_STATUS' };
    }

    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return { success: false, error: 'Campaign not found', code: 'NOT_FOUND' };
    }

    const fromStatus = campaign.status || 'DRAFT';

    if (fromStatus === upper) {
      return { success: true, campaign, unchanged: true };
    }

    if (!force && !(ALLOWED_TRANSITIONS[fromStatus] || []).includes(upper)) {
      return {
        success: false,
        code: 'INVALID_TRANSITION',
        error: `Cannot move a ${fromStatus} campaign to ${upper}`
      };
    }

    // Going live demands a campaign that can actually run.
    if (upper === 'ACTIVE') {
      const check = this.validateForActivation(campaign);
      if (!check.valid) {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          error: 'Campaign is not ready to run',
          errors: check.errors
        };
      }
    }

    const isActive = upper === 'ACTIVE' ? 1 : 0;

    execute(
      `UPDATE campaigns
         SET status = ?, is_active = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [upper, isActive, upper === 'ERROR' ? reason : null, campaignId]
    );

    execute(
      `INSERT INTO campaign_status_history (campaign_id, from_status, to_status, reason)
       VALUES (?, ?, ?, ?)`,
      [campaignId, fromStatus, upper, reason]
    );

    LoggerService.log({
      campaignId,
      postId: campaign.post_id,
      action: `CAMPAIGN_${upper}`,
      status: upper === 'ERROR' ? 'FAILURE' : 'SUCCESS',
      details: { from: fromStatus, to: upper, reason, name: campaign.name }
    });

    return {
      success: true,
      campaign: queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]),
      from: fromStatus,
      to: upper
    };
  }

  /**
   * Mark a campaign as errored from inside the automation engine.
   */
  static markError(campaignId, reason) {
    if (!campaignId) return null;
    return this.transition(campaignId, 'ERROR', { reason, force: true });
  }

  /**
   * Record that a campaign did something, for "sort by latest activity".
   */
  static touchActivity(campaignId) {
    if (!campaignId) return;
    try {
      execute('UPDATE campaigns SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [campaignId]);
    } catch (err) {
      // Activity timestamps are cosmetic; never let them break a send.
      console.error('[CampaignService] touchActivity failed:', err.message);
    }
  }

  /**
   * Copy a campaign as a fresh DRAFT so the creator can reuse its wording.
   */
  static duplicate(campaignId, newName = null) {
    const source = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!source) {
      return { success: false, error: 'Campaign not found', code: 'NOT_FOUND' };
    }

    const name = newName || `${source.name} (Copy)`;

    execute(
      `INSERT INTO campaigns (
        name, post_id, keywords, match_type, public_reply_enabled,
        public_reply_text, initial_private_reply_text, follow_up_enabled,
        follow_up_text, follower_reminder_text, report_text, is_active, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT')`,
      [
        name,
        source.post_id,
        source.keywords,
        source.match_type,
        source.public_reply_enabled,
        source.public_reply_text,
        source.initial_private_reply_text,
        source.follow_up_enabled,
        source.follow_up_text,
        source.follower_reminder_text,
        source.report_text
      ]
    );

    const created = queryOne('SELECT * FROM campaigns ORDER BY id DESC LIMIT 1');

    execute(
      `INSERT INTO campaign_status_history (campaign_id, from_status, to_status, reason)
       VALUES (?, NULL, 'DRAFT', ?)`,
      [created.id, `Duplicated from campaign #${campaignId}`]
    );

    LoggerService.log({
      campaignId: created.id,
      action: 'CAMPAIGN_DUPLICATED',
      status: 'SUCCESS',
      details: { source: campaignId, name }
    });

    return { success: true, campaign: created };
  }

  /**
   * Status history for a campaign, newest first.
   */
  /**
   * Clear one campaign's delivery records so it behaves like a fresh campaign.
   *
   * What this CAN do: wipe our own bookkeeping — processed comments, sent-message
   * rows and conversation threads — so the dashboard counts return to zero and a
   * comment this system has already seen is treated as new again.
   *
   * What this CANNOT do: reset Meta. The one-private-reply-per-comment rule lives
   * on Meta's side, keyed to the comment ID. Re-processing the SAME comment after
   * a reset will still be refused by Meta. A NEW comment from the same person is
   * a new comment ID and is replied to normally — which already worked before any
   * reset, because deduplication is per comment, not per person.
   *
   * The activity log is deliberately NOT cleared. It is the audit trail of what
   * was actually sent to real people, and a record of outbound messaging should
   * not be erasable from a dashboard button. A summary of what was removed is
   * written to it instead.
   */
  static resetData(campaignId, { reason = 'Reset from dashboard' } = {}) {
    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return { success: false, error: 'Campaign not found' };
    }

    // Count first; the rows are about to be gone and the audit entry needs them.
    const counts = {
      processedComments: queryOne(
        'SELECT COUNT(*) as count FROM processed_comments WHERE matched_campaign_id = ?',
        [campaignId]
      )?.count || 0,
      outboundMessages: queryOne(
        'SELECT COUNT(*) as count FROM outbound_messages WHERE campaign_id = ?',
        [campaignId]
      )?.count || 0,
      sentMessages: queryOne(
        "SELECT COUNT(*) as count FROM outbound_messages WHERE campaign_id = ? AND status = 'sent'",
        [campaignId]
      )?.count || 0,
      threads: queryOne(
        'SELECT COUNT(*) as count FROM user_threads WHERE current_campaign_id = ?',
        [campaignId]
      )?.count || 0
    };

    // Anything still queued for this campaign must go too, or a message from
    // before the reset could land afterwards and reopen a thread we just cleared.
    const queueService = require('./queueService');
    const queuedDropped = queueService.flushCampaign(campaignId, 'CAMPAIGN_DATA_RESET');

    execute('DELETE FROM processed_comments WHERE matched_campaign_id = ?', [campaignId]);
    execute('DELETE FROM outbound_messages WHERE campaign_id = ?', [campaignId]);
    execute('DELETE FROM user_threads WHERE current_campaign_id = ?', [campaignId]);
    execute('UPDATE campaigns SET last_error = NULL, last_activity_at = NULL WHERE id = ?', [campaignId]);

    LoggerService.log({
      campaignId,
      action: 'CAMPAIGN_DATA_RESET',
      status: 'WARNING',
      details: {
        campaign: campaign.name,
        reason,
        removed: counts,
        queuedDropped,
        note:
          'Dashboard records cleared. Meta still enforces one private reply per comment ID, ' +
          'so a comment already replied to cannot be replied to again. A new comment can.'
      }
    });

    return { success: true, campaign: campaign.name, removed: counts, queuedDropped };
  }

  static getStatusHistory(campaignId, limit = 50) {
    return queryAll(
      `SELECT * FROM campaign_status_history
        WHERE campaign_id = ?
        ORDER BY id DESC
        LIMIT ?`,
      [campaignId, limit]
    );
  }

  /**
   * Keywords are stored as a JSON array but older rows may hold a plain
   * comma-separated string. Accept both and always hand back an array.
   */
  static parseKeywords(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(k => String(k).trim()).filter(Boolean);

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(k => String(k).trim()).filter(Boolean);
      }
    } catch (e) {
      // fall through to comma-separated handling
    }

    return String(raw).split(',').map(k => k.trim()).filter(Boolean);
  }

  /**
   * Normalise whatever the dashboard sends into the stored JSON array form.
   */
  static serializeKeywords(raw) {
    return JSON.stringify(this.parseKeywords(raw));
  }

  /**
   * True only when this campaign is allowed to send right now.
   */
  static canSend(campaignId) {
    const campaign = queryOne('SELECT status FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return { allowed: false, reason: 'CAMPAIGN_NOT_FOUND' };
    }
    if (campaign.status !== 'ACTIVE') {
      return { allowed: false, reason: `CAMPAIGN_${campaign.status}` };
    }
    return { allowed: true };
  }
}

module.exports = CampaignService;
