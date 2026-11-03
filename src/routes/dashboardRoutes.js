/**
 * Invest With Clarity - Dashboard, Analytics & System Control Routes
 */

const express = require('express');
const router = express.Router();
const LoggerService = require('../services/loggerService');
const StatsService = require('../services/statsService');
const {
  queryAll,
  queryOne,
  getSetting,
  setSetting,
  isEmergencyStopActive,
  isAutomationPaused
} = require('../database/db');
const metaApiClient = require('../services/metaApiClient');
const queueService = require('../services/queueService');
const PollingService = require('../services/pollingService');
const HealthService = require('../services/healthService');
const config = require('../config');

// GET the main overview: headline numbers + chart series, all range-filtered
router.get('/overview', (req, res) => {
  try {
    const range = req.query.range || 'all';
    res.json({
      success: true,
      overview: StatsService.getOverview(range),
      series: StatsService.getDailySeries(range === 'all' ? '30d' : range),
      delivery: StatsService.getDeliveryBreakdown(null, range),
      failureReasons: StatsService.getFailureReasons(null, range),
      ranges: Object.entries(StatsService.RANGES).map(([key, v]) => ({ key, label: v.label }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy stats endpoint, kept working for anything still calling it
router.get('/stats', (req, res) => {
  try {
    res.json({ success: true, stats: LoggerService.getActivityStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET activity logs with search, filters and a date range
router.get('/logs', (req, res) => {
  try {
    const { limit = 200, campaignId, action, status, search, range = 'all' } = req.query;

    let sql = 'SELECT * FROM activity_logs WHERE 1=1';
    const params = [];

    if (campaignId && campaignId !== 'ALL') {
      sql += ' AND campaign_id = ?';
      params.push(parseInt(campaignId, 10));
    }
    if (action && action !== 'ALL') {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (status && status !== 'ALL') {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (search) {
      const term = `%${String(search).toLowerCase()}%`;
      sql += ' AND (LOWER(details) LIKE ? OR LOWER(action) LIKE ? OR LOWER(COALESCE(user_id, \'\')) LIKE ?)';
      params.push(term, term, term);
    }

    sql += StatsService.rangeClause('timestamp', range);
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const logs = queryAll(sql, params);

    // Distinct action names so the filter dropdown reflects reality
    const actions = queryAll('SELECT DISTINCT action FROM activity_logs ORDER BY action').map(r => r.action);

    res.json({ success: true, logs, actions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET system status (connection, kill switches, queue depth)
router.get('/system-status', async (req, res) => {
  try {
    const metaCheck = await metaApiClient.verifyConnection();

    res.json({
      success: true,
      status: {
        emergencyStop: isEmergencyStopActive(),
        automationPaused: isAutomationPaused(),
        rateDelay: parseInt(getSetting('request_delay_ms', '1500'), 10),
        queueLength: queueService.getQueueLength(),
        polling: PollingService.status(),
        metaStatus: metaCheck,
        account: {
          instagramAccountId: config.meta.instagramAccountId || null,
          facebookPageId: config.meta.facebookPageId || null,
          apiVersion: config.meta.apiVersion,
          webhookUrl: `${config.appBaseUrl}/webhook`,
          tokenConfigured: Boolean(config.meta.accessToken),
          appSecretConfigured: Boolean(config.meta.appSecret)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Emergency stop. Accepts an explicit { active: true|false }; with no body it
 * toggles. Turning it on also clears the outbound queue, so nothing already
 * waiting in line can still reach Meta.
 */
router.post('/emergency-stop', (req, res) => {
  try {
    const current = isEmergencyStopActive();
    const next = typeof req.body?.active === 'boolean' ? req.body.active : !current;

    setSetting('emergency_stop', next ? 'true' : 'false');

    let queuedDropped = 0;
    if (next) {
      queuedDropped = queueService.flush('EMERGENCY_STOP_ACTIVE');
    }

    LoggerService.log({
      action: 'EMERGENCY_STOP_TOGGLED',
      status: next ? 'WARNING' : 'SUCCESS',
      details: { emergencyStop: next, queuedDropped }
    });

    res.json({ success: true, emergencyStop: next, queuedDropped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Global pause across every campaign
router.post('/pause', (req, res) => {
  try {
    const current = isAutomationPaused();
    const next = typeof req.body?.active === 'boolean' ? req.body.active : !current;

    setSetting('automation_paused', next ? 'true' : 'false');

    let queuedDropped = 0;
    if (next) {
      queuedDropped = queueService.flush('AUTOMATION_PAUSED');
    }

    LoggerService.log({
      action: 'AUTOMATION_PAUSE_TOGGLED',
      status: 'SUCCESS',
      details: { paused: next, queuedDropped }
    });

    res.json({ success: true, automationPaused: next, queuedDropped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// What can this account actually deliver right now, and why not.
router.get('/health', async (req, res) => {
  try {
    res.json({ success: true, health: await HealthService.check() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comment polling: the fallback that makes replies work without webhooks.
router.get('/polling', (req, res) => {
  res.json({ success: true, polling: PollingService.status() });
});

router.post('/polling', (req, res) => {
  try {
    if (typeof req.body?.enabled === 'boolean') PollingService.setEnabled(req.body.enabled);
    if (req.body?.intervalSeconds) PollingService.setInterval(req.body.intervalSeconds);

    LoggerService.log({
      action: 'COMMENT_POLL_SETTINGS_CHANGED',
      status: 'SUCCESS',
      details: PollingService.status()
    });

    res.json({ success: true, polling: PollingService.status() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run one cycle now, without waiting for the timer.
router.post('/polling/run', async (req, res) => {
  try {
    const result = await PollingService.runOnce({ manual: true });
    res.json({ success: true, result, polling: PollingService.status() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/rate-delay', (req, res) => {
  try {
    const ms = parseInt(req.body?.delayMs, 10) || 1500;
    setSetting('request_delay_ms', String(ms));
    queueService.setDelay(ms);
    res.json({ success: true, requestDelayMs: ms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// All stored settings, for the Settings page
router.get('/settings', (req, res) => {
  try {
    const rows = queryAll('SELECT key, value, updated_at FROM system_settings ORDER BY key');
    res.json({
      success: true,
      settings: rows,
      disclaimer: config.disclaimer,
      maxCommentAgeDays: config.safeguards.maxCommentAgeDays
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/settings', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) {
      return res.status(400).json({ success: false, error: 'A setting key is required.' });
    }

    setSetting(key, value);

    LoggerService.log({
      action: 'SETTING_UPDATED',
      status: 'SUCCESS',
      details: { key }
    });

    res.json({ success: true, key, value: getSetting(key) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Conversation threads, for the analytics page
router.get('/threads', (req, res) => {
  try {
    const threads = queryAll(
      `SELECT t.*, c.name as campaign_name
         FROM user_threads t
         LEFT JOIN campaigns c ON c.id = t.current_campaign_id
        ORDER BY t.updated_at DESC
        LIMIT 200`
    );
    res.json({ success: true, threads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
