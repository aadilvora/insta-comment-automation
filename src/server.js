/**
 * Invest With Clarity - Main Application Server
 * Official Meta-Compliant Instagram Comment-to-DM Automation System.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { initDatabase, queryOne, execute } = require('./database/db');
const webhookRoutes = require('./routes/webhookRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const testRoutes = require('./routes/testRoutes');
const postRoutes = require('./routes/postRoutes');
const templateRoutes = require('./routes/templateRoutes');
const LoggerService = require('./services/loggerService');
const PollingService = require('./services/pollingService');

const app = express();

// Initialize SQLite database
initDatabase();

// Middleware
app.use(cors());

// Raw body parser for Meta webhook signature verification
app.use(
  express.json({
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  })
);
app.use(express.urlencoded({ extended: true }));

// Serve Frontend Dashboard Assets
app.use(express.static(path.resolve(__dirname, '../public')));

// Mount Routes
app.use('/webhook', webhookRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/test', testRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/templates', templateRoutes);

// Root fallback to dashboard
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
    return next();
  }
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Seed one example campaign on a brand-new database.
// It is created as a DRAFT on purpose: a fresh install must never start
// messaging real commenters before you have reviewed the wording.
function seedSampleCampaigns() {
  const count = queryOne('SELECT COUNT(*) as count FROM campaigns')?.count || 0;
  if (count === 0) {
    const handle = config.brand.handle;
    const suffix = config.disclaimer ? '\n\n' + config.disclaimer : '';

    execute(
      `INSERT INTO campaigns (
        name, post_id, keywords, match_type, public_reply_enabled,
        public_reply_text, initial_private_reply_text, follow_up_enabled,
        follow_up_text, follower_reminder_text, report_text, is_active, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT')`,
      [
        'Example campaign',
        'REPLACE_WITH_YOUR_POST_ID',
        JSON.stringify(['GUIDE', 'INFO']),
        'contains',
        1,
        'Thanks @{{username}}! Check your DMs.',
        `Hi {{first_name}}! Thanks for commenting. Follow @${handle} and reply DONE to get the link.`,
        1,
        'Here is the link you asked for: https://example.com/your-resource' + suffix,
        `Hey {{first_name}}! It looks like you have not followed @${handle} yet. Tap the profile to follow, then reply DONE.`,
        'Here is the link you asked for: https://example.com/your-resource' + suffix
      ]
    );

    console.log('[Server] Example campaign seeded as a DRAFT. Edit it in the dashboard before starting it.');
  }
}

seedSampleCampaigns();

// Start Server
const server = app.listen(config.port, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 ${config.brand.name} - Instagram Automation Running`);
  console.log(`📡 Local Server URL: ${config.appBaseUrl}`);
  console.log(`🔗 Webhook URL:      ${config.appBaseUrl}/webhook`);
  console.log(`📊 Dashboard:        ${config.appBaseUrl}`);
  console.log(`🛡️  Meta Graph API:   ${config.meta.apiVersion}`);
  console.log(`======================================================\n`);

  LoggerService.log({
    action: 'SERVER_STARTUP',
    status: 'SUCCESS',
    details: { port: config.port, env: config.nodeEnv }
  });

  // Start checking Instagram directly for new comments. Webhooks remain the
  // fast path when they are working; this is what keeps replies flowing when
  // they are not.
  PollingService.start();
});

module.exports = { app, server };
