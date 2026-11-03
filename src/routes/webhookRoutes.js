/**
 * Invest With Clarity - Webhook Routes
 */

const express = require('express');
const router = express.Router();
const WebhookHandler = require('../services/webhookHandler');

// Webhook Verification (Meta handshake)
router.get('/', (req, res) => {
  return WebhookHandler.handleVerification(req, res);
});

// Inbound Webhook Events
router.post('/', (req, res) => {
  // Signature check
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  const sigCheck = WebhookHandler.verifySignature(rawBody, signature);
  if (!sigCheck.valid) {
    console.warn('[WebhookRoute] Invalid webhook signature detected. Reason:', sigCheck.reason);
    return res.status(403).send('Invalid signature');
  }

  return WebhookHandler.handleEvent(req, res);
});

module.exports = router;
