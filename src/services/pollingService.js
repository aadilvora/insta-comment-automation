/**
 * Invest With Clarity - Comment Poller
 *
 * Webhooks are the fast path, but they only work when BOTH of these hold:
 *   - the public callback URL is reachable (an ngrok tunnel, a real host), and
 *   - the Meta app is subscribed to this Instagram account's `comments` field.
 *
 * When either lapses, Meta drops the delivery silently and the comment is gone
 * forever: nothing retries, nothing appears in the dashboard, and the person
 * waits for a reply that will never come. That is the single most common way
 * this system looks "broken" while every line of its own code is working.
 *
 * This poller removes that dependency. It asks Instagram directly, on a timer,
 * what comments exist on the Reels that active campaigns target, and runs
 * anything new through the ordinary automation path. Webhooks still work and
 * are still faster; whichever sees a comment first handles it, and the per
 * comment deduplication means it is never answered twice.
 */

const CommentSync = require('./commentSyncService');
const MessageSync = require('./messageSyncService');
const LoggerService = require('./loggerService');
const { getSetting, setSetting, isEmergencyStopActive, isAutomationPaused } = require('../database/db');

const DEFAULTS = {
  enabled: true,
  intervalSeconds: 60
};

// Instagram rate limits are per hour, so a floor stops a mistyped setting from
// burning the account's quota in minutes.
const MIN_INTERVAL_SECONDS = 30;

let timer = null;
let running = false;
let lastRun = null;
let lastResult = null;
let consecutiveErrors = 0;

function isEnabled() {
  const raw = getSetting('comment_polling_enabled', String(DEFAULTS.enabled));
  return raw === 'true' || raw === true;
}

function intervalSeconds() {
  const raw = parseInt(getSetting('comment_poll_interval_s', String(DEFAULTS.intervalSeconds)), 10);
  return Math.max(MIN_INTERVAL_SECONDS, Number.isFinite(raw) ? raw : DEFAULTS.intervalSeconds);
}

/**
 * One polling cycle. Never throws: a failed cycle must not kill the timer, or
 * one network blip would silently end polling for the rest of the process.
 */
async function runOnce({ manual = false } = {}) {
  if (running) {
    return { skipped: true, reason: 'ALREADY_RUNNING' };
  }

  // The kill switches gate the poller itself, not just the sends it causes.
  // Polling while stopped would still write processed_comments rows and make
  // it look as though the automation acted during a halt.
  if (isEmergencyStopActive()) {
    return { skipped: true, reason: 'EMERGENCY_STOP_ACTIVE' };
  }
  if (isAutomationPaused()) {
    return { skipped: true, reason: 'AUTOMATION_PAUSED' };
  }

  running = true;
  try {
    const result = await CommentSync.syncActiveCampaignPosts({ dryRun: false, limit: 25 });

    // Inbound DMs are the second half of the flow. Without them a person who
    // replies "DONE" is never heard, the follow-up never sends, and the
    // conversation dies after the first message.
    let messages = null;
    try {
      messages = await MessageSync.syncMessages({ limit: 25 });
      result.messages = messages;
    } catch (err) {
      // A conversation-read failure must not discard the comment results that
      // already succeeded in this cycle.
      result.messagesError = err.message;
    }

    lastRun = new Date().toISOString();
    lastResult = result;
    consecutiveErrors = 0;

    // Only log a cycle that did something. A quiet poller writing a row a minute
    // would bury the real activity it exists to surface.
    if (result.totalProcessed > 0 || (messages && messages.processed > 0)) {
      LoggerService.log({
        action: 'COMMENT_POLL_FOUND',
        status: 'SUCCESS',
        details: {
          comments: result.totalProcessed,
          messages: messages ? messages.processed : 0,
          posts: result.posts,
          trigger: manual ? 'manual' : 'timer'
        }
      });
    }

    return result;
  } catch (err) {
    consecutiveErrors += 1;
    lastRun = new Date().toISOString();

    // Log the first failure and then every tenth, so a sustained outage leaves
    // a trail without flooding the activity log.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      LoggerService.log({
        action: 'COMMENT_POLL_ERROR',
        status: 'FAILURE',
        details: { error: err.message, consecutiveErrors }
      });
    }

    return { error: err.message, consecutiveErrors };
  } finally {
    running = false;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);

  timer = setTimeout(async () => {
    if (isEnabled()) {
      await runOnce();
    }
    schedule();
  }, intervalSeconds() * 1000);

  // A pending poll must never hold the process open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
}

function start() {
  if (!isEnabled()) {
    console.log('[Poller] Comment polling is disabled in settings.');
    return;
  }

  schedule();
  console.log(`[Poller] Checking Instagram for new comments every ${intervalSeconds()}s.`);

  LoggerService.log({
    action: 'COMMENT_POLL_STARTED',
    status: 'SUCCESS',
    details: {
      intervalSeconds: intervalSeconds(),
      note: 'Comments are fetched directly from Instagram, so replies work even without webhooks.'
    }
  });
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function setEnabled(enabled) {
  setSetting('comment_polling_enabled', enabled ? 'true' : 'false');
  stop();
  if (enabled) start();
  return isEnabled();
}

function setInterval_(seconds) {
  const value = Math.max(MIN_INTERVAL_SECONDS, parseInt(seconds, 10) || DEFAULTS.intervalSeconds);
  setSetting('comment_poll_interval_s', String(value));
  if (isEnabled()) { stop(); start(); }
  return value;
}

function status() {
  return {
    enabled: isEnabled(),
    intervalSeconds: intervalSeconds(),
    minIntervalSeconds: MIN_INTERVAL_SECONDS,
    running,
    lastRun,
    consecutiveErrors,
    lastResult: lastResult
      ? {
          posts: lastResult.posts,
          totalProcessed: lastResult.totalProcessed,
          totalFetched: lastResult.totalFetched,
          messagesProcessed: lastResult.messages ? lastResult.messages.processed : null,
          messagesError: lastResult.messagesError || null
        }
      : null
  };
}

module.exports = { start, stop, runOnce, setEnabled, setInterval: setInterval_, status, isEnabled, intervalSeconds };
