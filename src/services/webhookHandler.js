/**
 * Invest With Clarity - Webhook Receiver & Cryptographic Signature Verifier
 * Implements HMAC-SHA256 signature verification according to official Meta specs.
 */

const crypto = require('node:crypto');
const config = require('../config');
const LoggerService = require('./loggerService');
const AutomationEngine = require('./automationEngine');

class WebhookHandler {
  /**
   * Verify Meta HMAC-SHA256 signature from X-Hub-Signature-256 header.
   */
  static verifySignature(rawBody, signatureHeader, appSecret = config.meta.appSecret) {
    if (!signatureHeader) {
      return { valid: false, reason: 'MISSING_SIGNATURE_HEADER' };
    }

    if (!appSecret) {
      // In development if no secret is set yet, log a warning
      if (config.nodeEnv === 'development') {
        return { valid: true, warning: 'DEVELOPMENT_SECRET_BYPASS' };
      }
      return { valid: false, reason: 'APP_SECRET_NOT_CONFIGURED' };
    }

    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      return { valid: false, reason: 'INVALID_SIGNATURE_FORMAT' };
    }

    const expectedSignature = parts[1];
    const computedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(computedSignature, 'hex')
    );

    return { valid: isValid };
  }

  /**
   * Handle Webhook Verification Challenge (GET /webhook)
   */
  static handleVerification(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
      LoggerService.log({
        action: 'WEBHOOK_VERIFY_CHALLENGE',
        status: 'SUCCESS',
        details: 'Meta Webhook URL verified successfully.'
      });
      return res.status(200).send(challenge);
    }

    LoggerService.log({
      action: 'WEBHOOK_VERIFY_CHALLENGE',
      status: 'FAILURE',
      details: 'Verify token mismatch or invalid subscription mode.'
    });
    return res.status(403).send('Forbidden');
  }

  /**
   * Handle Inbound Webhook Events (POST /webhook)
   */
  static async handleEvent(req, res) {
    const body = req.body;

    // Fast HTTP 200 response to satisfy Meta's 20-second timeout window
    res.status(200).send('EVENT_RECEIVED');

    if (body.object !== 'instagram' && body.object !== 'page') {
      return;
    }

    const entries = body.entry || [];

    for (const entry of entries) {
      // 1. Process Instagram Comments Webhook Changes
      if (entry.changes && Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (change.field === 'comments') {
            const commentValue = change.value;
            // Run processing asynchronously
            AutomationEngine.processComment(commentValue).catch(err => {
              console.error('[WebhookHandler] Comment processing error:', err);
            });
          }
        }
      }

      // 2. Process Instagram Direct Messages Webhook Events
      if (entry.messaging && Array.isArray(entry.messaging)) {
        for (const messagingEvent of entry.messaging) {
          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            // Run processing asynchronously
            AutomationEngine.processInboundMessage(messagingEvent).catch(err => {
              console.error('[WebhookHandler] Messaging processing error:', err);
            });
          }
        }
      }
    }
  }
}

module.exports = WebhookHandler;
