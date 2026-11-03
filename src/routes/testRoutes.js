/**
 * Invest With Clarity - Local Testing & Simulation Routes
 * Allows the creator to simulate comments and messages in a local sandbox
 * without requiring live Meta webhook calls or exposing production accounts.
 */

const express = require('express');
const config = require('../config');
const router = express.Router();
const AutomationEngine = require('../services/automationEngine');
const metaApiClient = require('../services/metaApiClient');

// Simulate a comment event
router.post('/simulate-comment', async (req, res) => {
  try {
    const {
      postId = 'post_jio_ipo_001',
      commentText = 'Need the Jio IPO report please',
      username = 'test_investor',
      commentId = `test_c_${Date.now()}`,
      mock = true
    } = req.body;

    // Synthetic comment IDs do not exist on Instagram, so live Meta calls will fail.
    if (!mock && (commentId.startsWith('test_c_') || postId.startsWith('post_'))) {
      return res.status(400).json({
        success: false,
        error: 'Synthetic test IDs (test_c_...) do not exist on Instagram. Leave "Actually call Meta" unchecked to test safely in the sandbox, or test with a real comment on your Reel.'
      });
    }

    // Simulated comment IDs don't exist on Meta, so the sandbox mocks the API by
    // default. Send { "mock": false } to drive a real call instead.
    const wasMock = metaApiClient.mockMode;
    if (mock || !metaApiClient.accessToken) {
      metaApiClient.mockMode = true;
    }

    const commentEvent = {
      id: commentId,
      text: commentText,
      from: {
        id: `user_${username}`,
        username: username
      },
      media: {
        id: postId
      },
      created_time: Math.floor(Date.now() / 1000)
    };

    const result = await AutomationEngine.processComment(commentEvent);
    metaApiClient.mockMode = wasMock;

    res.json({ success: true, simulation: commentEvent, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simulate an inbound DM reply from user
router.post('/simulate-dm', async (req, res) => {
  try {
    const {
      username = 'test_investor',
      messageText = 'DONE',
      mock = true
    } = req.body;

    const wasMock = metaApiClient.mockMode;
    if (mock || !metaApiClient.accessToken) {
      metaApiClient.mockMode = true;
    }

    const messagingEvent = {
      sender: {
        id: `user_${username}`
      },
      recipient: {
        id: config.brand.handle
      },
      timestamp: Date.now(),
      message: {
        mid: `mid_${Date.now()}`,
        text: messageText
      }
    };

    const result = await AutomationEngine.processInboundMessage(messagingEvent);
    metaApiClient.mockMode = wasMock;

    res.json({ success: true, simulation: messagingEvent, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
