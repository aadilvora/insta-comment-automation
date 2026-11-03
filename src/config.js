/**
 * Configuration & environment loader.
 * Every account-specific value comes from .env - nothing is hardcoded.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',

  // Meta App Credentials
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    apiVersion: process.env.META_API_VERSION || 'v21.0',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    accessToken: process.env.META_ACCESS_TOKEN || '',
    instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    graphApiBaseUrl: 'https://graph.facebook.com'
  },

  // Operational Safeguards
  safeguards: {
    requestDelayMs: parseInt(process.env.API_REQUEST_DELAY_MS, 10) || 1500,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
    emergencyStop: process.env.EMERGENCY_STOP === 'true',
    maxCommentAgeDays: 7, // Meta strict private reply window
    // How many times one comment may be re-attempted after a retryable failure.
    // Only applies to transient/rate-limit outcomes; a refusal is never retried.
    maxCommentAttempts: parseInt(process.env.MAX_COMMENT_ATTEMPTS, 10) || 3
  },

  // Your account, used in the dashboard header and in seeded example wording.
  brand: {
    name: process.env.BRAND_NAME || 'Instagram Automation',
    handle: process.env.INSTAGRAM_HANDLE || 'your_handle'
  },

  // Appended to outbound messages. Leave DISCLAIMER_TEXT empty to append nothing.
  disclaimer: process.env.DISCLAIMER_TEXT || ''
};

module.exports = config;
