/**
 * Invest With Clarity - Campaign Management Routes
 * Create, edit, save-as-draft, start, pause, resume, stop, duplicate and
 * inspect campaigns. Every write persists to SQLite immediately so nothing is
 * lost when the app restarts.
 */

const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute } = require('../database/db');
const LoggerService = require('../services/loggerService');
const CampaignService = require('../services/campaignService');
const StatsService = require('../services/statsService');
const queueService = require('../services/queueService');

/**
 * Attach the cached post and scoped stats to a campaign row.
 */
function decorate(campaign, range = 'all') {
  const post = queryOne('SELECT * FROM instagram_posts WHERE post_id = ?', [campaign.post_id]);
  return {
    ...campaign,
    keywordList: CampaignService.parseKeywords(campaign.keywords),
    post: post || null,
    stats: StatsService.getCampaignStats(campaign.id, range)
  };
}

// LIST campaigns with search, filter and sort
router.get('/', (req, res) => {
  try {
    const { search, status, post_id, sort = 'recent', range = 'all' } = req.query;

    let sql = 'SELECT * FROM campaigns WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND LOWER(name) LIKE ?';
      params.push(`%${String(search).toLowerCase()}%`);
    }
    if (status && status !== 'ALL') {
      sql += ' AND status = ?';
      params.push(String(status).toUpperCase());
    }
    if (post_id && post_id !== 'ALL') {
      sql += ' AND post_id = ?';
      params.push(post_id);
    }

    // "most comments" needs the stats, so it is sorted after decoration.
    if (sort === 'name') {
      sql += ' ORDER BY name COLLATE NOCASE ASC';
    } else if (sort === 'oldest') {
      sql += ' ORDER BY id ASC';
    } else if (sort === 'activity') {
      sql += ' ORDER BY COALESCE(last_activity_at, updated_at) DESC';
    } else {
      sql += ' ORDER BY updated_at DESC, id DESC';
    }

    let campaigns = queryAll(sql, params).map(c => decorate(c, range));

    if (sort === 'comments') {
      campaigns.sort((a, b) => b.stats.keywordMatches - a.stats.keywordMatches);
    }

    res.json({ success: true, campaigns, count: campaigns.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET one campaign
router.get('/:id', (req, res) => {
  try {
    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    res.json({
      success: true,
      campaign: decorate(campaign, req.query.range || 'all'),
      validation: CampaignService.validateForActivation(campaign)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET stats for one campaign only
router.get('/:id/stats', (req, res) => {
  try {
    const stats = StatsService.getCampaignStats(req.params.id, req.query.range || 'all');
    if (!stats) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    res.json({
      success: true,
      stats,
      series: StatsService.getDailySeries(req.query.range || '30d', req.params.id),
      delivery: StatsService.getDeliveryBreakdown(req.params.id, req.query.range || 'all')
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET activity for one campaign only (searchable + filterable)
router.get('/:id/activity', (req, res) => {
  try {
    const { action, status, search, limit = 200, range = 'all' } = req.query;

    let sql = 'SELECT * FROM activity_logs WHERE campaign_id = ?';
    const params = [req.params.id];

    if (action && action !== 'ALL') {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (status && status !== 'ALL') {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (LOWER(details) LIKE ? OR LOWER(action) LIKE ?)';
      const term = `%${String(search).toLowerCase()}%`;
      params.push(term, term);
    }

    sql += StatsService.rangeClause('timestamp', range);
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const logs = queryAll(sql, params);

    // The comment-level view: who commented, what matched, what was sent.
    const comments = queryAll(
      `SELECT * FROM processed_comments
        WHERE matched_campaign_id = ?
        ORDER BY id DESC LIMIT 200`,
      [req.params.id]
    );

    const messages = queryAll(
      `SELECT * FROM outbound_messages
        WHERE campaign_id = ?
        ORDER BY id DESC LIMIT 200`,
      [req.params.id]
    );

    res.json({ success: true, logs, comments, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET status history
router.get('/:id/history', (req, res) => {
  try {
    res.json({ success: true, history: CampaignService.getStatusHistory(req.params.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// CREATE campaign (defaults to DRAFT so work can be saved before going live)
router.post('/', (req, res) => {
  try {
    const {
      name,
      post_id,
      keywords,
      match_type = 'contains',
      public_reply_enabled = 1,
      public_reply_text = '',
      initial_private_reply_text = '',
      follow_up_enabled = 1,
      follow_up_text = '',
      follower_reminder_text = '',
      report_text = '',
      status = 'DRAFT'
    } = req.body;

    if (!name || !post_id) {
      return res.status(400).json({
        success: false,
        error: 'A campaign name and an Instagram post are required.'
      });
    }

    const requested = String(status).toUpperCase();
    const finalStatus = CampaignService.STATUSES.includes(requested) ? requested : 'DRAFT';

    // Always insert as DRAFT, then transition, so activation runs its validation.
    execute(
      `INSERT INTO campaigns (
        name, post_id, keywords, match_type, public_reply_enabled,
        public_reply_text, initial_private_reply_text, follow_up_enabled,
        follow_up_text, follower_reminder_text, report_text, is_active, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT')`,
      [
        name,
        post_id,
        CampaignService.serializeKeywords(keywords),
        match_type,
        public_reply_enabled ? 1 : 0,
        public_reply_text,
        initial_private_reply_text,
        follow_up_enabled ? 1 : 0,
        follow_up_text,
        follower_reminder_text,
        report_text
      ]
    );

    const created = queryOne('SELECT * FROM campaigns ORDER BY id DESC LIMIT 1');

    execute(
      `INSERT INTO campaign_status_history (campaign_id, from_status, to_status, reason)
       VALUES (?, NULL, 'DRAFT', 'Campaign created')`,
      [created.id]
    );

    LoggerService.log({
      campaignId: created.id,
      postId: post_id,
      action: 'CAMPAIGN_CREATED',
      status: 'SUCCESS',
      details: { name, post_id }
    });

    if (finalStatus === 'ACTIVE') {
      const result = CampaignService.transition(created.id, 'ACTIVE', { reason: 'Activated on creation' });
      if (!result.success) {
        // The campaign is saved as a draft; tell the creator why it isn't live.
        return res.status(201).json({
          success: true,
          campaign: decorate(queryOne('SELECT * FROM campaigns WHERE id = ?', [created.id])),
          activationFailed: true,
          error: result.error,
          errors: result.errors || []
        });
      }
    }

    res.status(201).json({
      success: true,
      campaign: decorate(queryOne('SELECT * FROM campaigns WHERE id = ?', [created.id]))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UPDATE campaign — saves edits without ever changing its running status
router.put('/:id', (req, res) => {
  try {
    const campaignId = req.params.id;
    const existing = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    const {
      name = existing.name,
      post_id = existing.post_id,
      keywords = existing.keywords,
      match_type = existing.match_type,
      public_reply_enabled = existing.public_reply_enabled,
      public_reply_text = existing.public_reply_text,
      initial_private_reply_text = existing.initial_private_reply_text,
      follow_up_enabled = existing.follow_up_enabled,
      follow_up_text = existing.follow_up_text,
      follower_reminder_text = existing.follower_reminder_text,
      report_text = existing.report_text
    } = req.body;

    execute(
      `UPDATE campaigns SET
        name = ?, post_id = ?, keywords = ?, match_type = ?,
        public_reply_enabled = ?, public_reply_text = ?,
        initial_private_reply_text = ?, follow_up_enabled = ?,
        follow_up_text = ?, follower_reminder_text = ?,
        report_text = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name,
        post_id,
        CampaignService.serializeKeywords(keywords),
        match_type,
        public_reply_enabled ? 1 : 0,
        public_reply_text,
        initial_private_reply_text,
        follow_up_enabled ? 1 : 0,
        follow_up_text,
        follower_reminder_text,
        report_text,
        campaignId
      ]
    );

    LoggerService.log({
      campaignId,
      action: 'CAMPAIGN_UPDATED',
      status: 'SUCCESS',
      details: { name }
    });

    const updated = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);

    res.json({
      success: true,
      campaign: decorate(updated),
      validation: CampaignService.validateForActivation(updated)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH only the message bodies — "save message edits independently"
router.patch('/:id/messages', (req, res) => {
  try {
    const campaignId = req.params.id;
    const existing = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    const fields = [
      'public_reply_text',
      'initial_private_reply_text',
      'follow_up_text',
      'follower_reminder_text',
      'report_text'
    ];

    const sets = [];
    const params = [];

    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sets.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'public_reply_enabled')) {
      sets.push('public_reply_enabled = ?');
      params.push(req.body.public_reply_enabled ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'follow_up_enabled')) {
      sets.push('follow_up_enabled = ?');
      params.push(req.body.follow_up_enabled ? 1 : 0);
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'No message fields supplied.' });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(campaignId);

    execute(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, params);

    LoggerService.log({
      campaignId,
      action: 'CAMPAIGN_MESSAGES_UPDATED',
      status: 'SUCCESS',
      details: { fields: sets.length - 1 }
    });

    res.json({
      success: true,
      campaign: decorate(queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Status transitions. Pausing and stopping also clear anything this campaign
 * still has sitting in the outbound queue.
 */
function applyTransition(req, res, toStatus, reason) {
  try {
    const result = CampaignService.transition(req.params.id, toStatus, {
      reason: req.body?.reason || reason
    });

    if (!result.success) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(code).json(result);
    }

    let queuedDropped = 0;
    if (toStatus !== 'ACTIVE') {
      queuedDropped = queueService.flushCampaign(req.params.id, `CAMPAIGN_${toStatus}`);
    }

    res.json({
      success: true,
      campaign: decorate(result.campaign),
      from: result.from,
      to: result.to,
      queuedDropped
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

router.post('/:id/start', (req, res) => applyTransition(req, res, 'ACTIVE', 'Started from dashboard'));
router.post('/:id/activate', (req, res) => applyTransition(req, res, 'ACTIVE', 'Activated from dashboard'));
router.post('/:id/resume', (req, res) => applyTransition(req, res, 'ACTIVE', 'Resumed from dashboard'));
router.post('/:id/pause', (req, res) => applyTransition(req, res, 'PAUSED', 'Paused from dashboard'));
router.post('/:id/stop', (req, res) => applyTransition(req, res, 'STOPPED', 'Stopped from dashboard'));
router.post('/:id/draft', (req, res) => applyTransition(req, res, 'DRAFT', 'Returned to draft'));

// Generic transition endpoint
router.post('/:id/status', (req, res) => {
  const target = String(req.body?.status || '').toUpperCase();
  return applyTransition(req, res, target, req.body?.reason || 'Status changed from dashboard');
});

// Legacy toggle kept so older clients keep working
router.post('/:id/toggle', (req, res) => {
  const campaign = queryOne('SELECT status FROM campaigns WHERE id = ?', [req.params.id]);
  if (!campaign) {
    return res.status(404).json({ success: false, error: 'Campaign not found' });
  }
  const target = campaign.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
  return applyTransition(req, res, target, 'Toggled from dashboard');
});

// DUPLICATE campaign
/**
 * Reset one campaign's data so it counts from zero again.
 * Clears our records only — Meta's one-reply-per-comment rule is unaffected.
 */
/**
 * Switch how a campaign delivers: everything in the first DM, or a follow-up
 * after the person replies. The follow-up needs an open messaging window and
 * therefore a webhook subscription; the first DM needs neither.
 */
router.post('/:id/delivery-mode', (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!['one_shot', 'two_step'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'mode must be "one_shot" or "two_step"'
      });
    }

    const id = parseInt(req.params.id, 10);
    const campaign = queryOne('SELECT id, name FROM campaigns WHERE id = ?', [id]);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    execute('UPDATE campaigns SET delivery_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mode, id]);

    LoggerService.log({
      campaignId: id,
      action: 'DELIVERY_MODE_CHANGED',
      status: 'SUCCESS',
      details: {
        campaign: campaign.name,
        mode,
        note: mode === 'one_shot'
          ? 'The report now goes out inside the first DM. No messaging window needed.'
          : 'The report is sent after the person replies. Requires the messages webhook subscription.'
      }
    });

    res.json({ success: true, id, mode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/reset', (req, res) => {
  try {
    const result = CampaignService.resetData(parseInt(req.params.id, 10), {
      reason: req.body?.reason || 'Reset from dashboard'
    });

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/duplicate', (req, res) => {
  try {
    const result = CampaignService.duplicate(req.params.id, req.body?.name);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.status(201).json({ success: true, campaign: decorate(result.campaign) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE campaign
router.delete('/:id', (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    queueService.flushCampaign(campaignId, 'CAMPAIGN_DELETED');
    execute('DELETE FROM campaigns WHERE id = ?', [campaignId]);

    LoggerService.log({
      campaignId,
      action: 'CAMPAIGN_DELETED',
      status: 'SUCCESS',
      details: { id: campaignId, name: campaign.name }
    });

    res.json({ success: true, message: 'Campaign deleted. Its history has been kept.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
