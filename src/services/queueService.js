/**
 * Invest With Clarity - Throttled Job Queue Service
 * Ensures outbound Meta API calls are queued and spaced out (e.g. 1500ms jitter)
 * to respect rate limits and avoid anti-spam triggers.
 */

const config = require('../config');
const LoggerService = require('./loggerService');
const { queryOne, isEmergencyStopActive, isAutomationPaused } = require('../database/db');
const metaErrors = require('./metaErrors');

/**
 * Meta compliance: a pause or stop must prevent outbound actions that are
 * already queued but not yet sent. The queue is the last gate before any API
 * call, so the check lives here and is re-evaluated at send time, not at
 * enqueue time.
 */
function evaluateGate(metadata = {}) {
  if (isEmergencyStopActive()) {
    return { allowed: false, reason: 'EMERGENCY_STOP_ACTIVE' };
  }
  if (isAutomationPaused()) {
    return { allowed: false, reason: 'AUTOMATION_PAUSED' };
  }

  if (metadata.campaignId) {
    const campaign = queryOne('SELECT status FROM campaigns WHERE id = ?', [metadata.campaignId]);
    if (!campaign) {
      return { allowed: false, reason: 'CAMPAIGN_NOT_FOUND' };
    }
    if (campaign.status !== 'ACTIVE') {
      return { allowed: false, reason: `CAMPAIGN_${campaign.status}` };
    }
  }

  return { allowed: true };
}

class QueueService {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.requestDelayMs = config.safeguards.requestDelayMs || 1500;
  }

  /**
   * Enqueue an async task to be executed sequentially.
   * @param {Function} taskFn - Function returning a promise
   * @param {Object} metadata - Context details for logging
   * @returns {Promise}
   */
  enqueue(taskFn, metadata = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        taskFn,
        metadata,
        resolve,
        reject,
        retries: 0
      });

      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();

    // Re-check the gate immediately before sending. A campaign paused while this
    // item was waiting in line must not go out.
    const gate = evaluateGate(item.metadata);
    if (!gate.allowed) {
      LoggerService.log({
        campaignId: item.metadata.campaignId || null,
        userId: item.metadata.userId || null,
        commentId: item.metadata.commentId || null,
        action: 'QUEUED_ACTION_BLOCKED',
        status: 'WARNING',
        details: {
          reason: gate.reason,
          message: 'Queued outbound action was dropped before sending.',
          metadata: item.metadata
        }
      });

      const blockErr = new Error(`Outbound action blocked: ${gate.reason}`);
      blockErr.code = 'BLOCKED_BY_POLICY';
      blockErr.reason = gate.reason;
      item.reject(blockErr);

      this.isProcessing = false;
      this.processNext();
      return;
    }

    try {
      const result = await item.taskFn();
      item.resolve(result);
    } catch (err) {
      // Meta answers HTTP 400 for its own rate limits and outages, so the HTTP
      // status alone cannot decide this. metaErrors reads error.code/subcode.
      const verdict = metaErrors.classify(err);
      err.category = verdict.category;
      err.retryable = verdict.retryable;
      err.explanation = verdict.explanation;
      err.blame = verdict.blame;

      if (verdict.retryable && item.retries < (config.safeguards.maxRetries || 3)) {
        item.retries += 1;
        const backoffMs = Math.pow(2, item.retries) * 1000 + Math.random() * 500;

        LoggerService.log({
          campaignId: item.metadata.campaignId || null,
          userId: item.metadata.userId || null,
          commentId: item.metadata.commentId || null,
          action: 'QUEUE_RETRY',
          status: 'WARNING',
          details: {
            message: `${verdict.category}: retrying in ${Math.round(backoffMs)}ms (attempt ${item.retries})`,
            category: verdict.category,
            error: err.message,
            metadata: item.metadata
          }
        });

        // Delay and re-queue at the front
        await this.delay(backoffMs);
        this.queue.unshift(item);
      } else {
        item.reject(err);
      }
    } finally {
      // Add standard inter-request delay to throttle API requests
      await this.delay(this.requestDelayMs);
      this.isProcessing = false;
      this.processNext();
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  setDelay(ms) {
    this.requestDelayMs = Math.max(500, ms);
  }

  getQueueLength() {
    return this.queue.length;
  }

  /**
   * Drop everything still waiting. Used by the global emergency stop so that
   * nothing already queued can reach Meta after the switch is thrown.
   */
  flush(reason = 'FLUSHED') {
    const dropped = this.queue.length;
    const items = this.queue.splice(0, this.queue.length);

    for (const item of items) {
      const err = new Error(`Outbound action cancelled: ${reason}`);
      err.code = 'BLOCKED_BY_POLICY';
      err.reason = reason;
      item.reject(err);
    }

    if (dropped > 0) {
      LoggerService.log({
        action: 'QUEUE_FLUSHED',
        status: 'WARNING',
        details: { dropped, reason }
      });
    }

    return dropped;
  }

  /**
   * Drop only the queued actions belonging to one campaign.
   */
  flushCampaign(campaignId, reason = 'CAMPAIGN_HALTED') {
    const keep = [];
    let dropped = 0;

    for (const item of this.queue) {
      if (String(item.metadata.campaignId) === String(campaignId)) {
        const err = new Error(`Outbound action cancelled: ${reason}`);
        err.code = 'BLOCKED_BY_POLICY';
        err.reason = reason;
        item.reject(err);
        dropped += 1;
      } else {
        keep.push(item);
      }
    }

    this.queue = keep;

    if (dropped > 0) {
      LoggerService.log({
        campaignId,
        action: 'QUEUE_CAMPAIGN_FLUSHED',
        status: 'WARNING',
        details: { dropped, reason }
      });
    }

    return dropped;
  }
}

const defaultQueue = new QueueService();
module.exports = defaultQueue;
