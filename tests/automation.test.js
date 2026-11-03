/**
 * Invest With Clarity - Automation & Keyword Matching Test Suite
 */

const assert = require('node:assert');
const path = require('path');
const { initDatabase, execute, queryOne, setSetting } = require('../src/database/db');
const AutomationEngine = require('../src/services/automationEngine');
const metaApiClient = require('../src/services/metaApiClient');

// Setup in-memory / temporary test database
initDatabase(path.resolve(__dirname, '../test_automation.db'));
metaApiClient.mockMode = true;

async function runTests() {
  console.log('\n--- Running Automation & Keyword Engine Tests ---');

  // Clear test tables
  execute('DELETE FROM processed_comments');
  execute('DELETE FROM outbound_messages');
  execute('DELETE FROM campaigns');
  execute('DELETE FROM user_threads');
  setSetting('emergency_stop', 'false');
  setSetting('automation_paused', 'false');

  // Test 1: Setup Multiple Distinct Campaigns
  execute(
    `INSERT INTO campaigns (name, post_id, keywords, match_type, public_reply_enabled, public_reply_text, initial_private_reply_text, report_text, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'Jio IPO Campaign',
      'post_jio_001',
      JSON.stringify(['JIO', 'IPO', 'REPORT']),
      'contains',
      1,
      'Public reply for Jio @{{username}}',
      'Private DM for Jio {{first_name}}',
      'Here is your Jio IPO report: https://example.com/report-a',
      1
    ]
  );

  execute(
    `INSERT INTO campaigns (name, post_id, keywords, match_type, public_reply_enabled, public_reply_text, initial_private_reply_text, report_text, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'BLS Polymers Campaign',
      'post_bls_002',
      JSON.stringify(['BLS', 'POLYMERS']),
      'contains',
      1,
      'Public reply for BLS @{{username}}',
      'Private DM for BLS {{first_name}}',
      'Here is your BLS report: https://example.com/report-b',
      1
    ]
  );

  // Test 2: Valid Keyword Match on Jio Post
  console.log('Test 1: Valid keyword match on specific post...');
  const jioMatch = AutomationEngine.matchCampaign('post_jio_001', 'Can I get the Jio IPO report?');
  assert.ok(jioMatch, 'Should match Jio campaign');
  assert.strictEqual(jioMatch.campaign.name, 'Jio IPO Campaign');
  console.log('✓ Passed: Correct post-to-campaign mapping.');

  // Test 3: Cross-post isolation (BLS keywords on Jio post should NOT match BLS campaign)
  console.log('Test 2: Cross-post campaign isolation...');
  const crossMatch = AutomationEngine.matchCampaign('post_jio_001', 'Tell me about BLS polymers');
  assert.strictEqual(crossMatch, null, 'Should NOT match BLS campaign when commenting on Jio post');
  console.log('✓ Passed: Campaigns strictly isolated by post ID.');

  // Test 4: Invalid keyword comment
  console.log('Test 3: Invalid keyword on Jio post...');
  const invalidMatch = AutomationEngine.matchCampaign('post_jio_001', 'Nice video bro!');
  assert.strictEqual(invalidMatch, null, 'Should return null for non-matching comment');
  console.log('✓ Passed: Non-keyword comments correctly ignored.');

  // Test 5: Process Comment Execution (Public reply + Initial private reply)
  console.log('Test 4: Full comment processing execution...');
  const commentEvent1 = {
    id: 'c_test_001',
    text: 'Send IPO report',
    from: { id: 'u_1001', username: 'investor_raj' },
    media: { id: 'post_jio_001' },
    created_time: Math.floor(Date.now() / 1000)
  };

  const processResult1 = await AutomationEngine.processComment(commentEvent1);
  assert.strictEqual(processResult1.success, true);
  assert.strictEqual(processResult1.publicReplyStatus, 'sent');
  assert.strictEqual(processResult1.privateReplyStatus, 'sent');

  // Verify DB entries
  const savedComment = queryOne('SELECT * FROM processed_comments WHERE comment_id = ?', ['c_test_001']);
  assert.ok(savedComment, 'Comment must be recorded in DB');
  assert.strictEqual(savedComment.public_reply_status, 'sent');
  assert.strictEqual(savedComment.private_reply_status, 'sent');
  console.log('✓ Passed: Initial public & private replies sent and recorded.');

  // Test 6: Single-Reply Enforcement (Same comment cannot receive second private reply)
  console.log('Test 5: Meta Single-Reply Rule enforcement...');
  const duplicateCommentEvent = {
    id: 'c_test_001', // SAME comment ID
    text: 'Send IPO report again',
    from: { id: 'u_1001', username: 'investor_raj' },
    media: { id: 'post_jio_001' },
    created_time: Math.floor(Date.now() / 1000)
  };

  const dupResult = await AutomationEngine.processComment(duplicateCommentEvent);
  assert.strictEqual(dupResult.skipped, true);
  assert.strictEqual(dupResult.reason, 'DUPLICATE_COMMENT');

  // Verify only 1 private reply exists in outbound_messages for this comment_id
  const dmMessages = queryOne(
    "SELECT COUNT(*) as count FROM outbound_messages WHERE comment_id = ? AND message_type = 'private_reply'",
    ['c_test_001']
  );
  assert.strictEqual(dmMessages.count, 1, 'Strictly only 1 private reply permitted per comment ID');
  console.log('✓ Passed: Single private reply limit strictly enforced.');

  // Test 7: Emergency Stop Halts Outbound Messaging
  console.log('Test 6: Emergency Stop kill-switch enforcement...');
  setSetting('emergency_stop', 'true');

  const commentEvent2 = {
    id: 'c_test_002',
    text: 'JIO report please',
    from: { id: 'u_1002', username: 'investor_priya' },
    media: { id: 'post_jio_001' },
    created_time: Math.floor(Date.now() / 1000)
  };

  const emergencyResult = await AutomationEngine.processComment(commentEvent2);
  assert.strictEqual(emergencyResult.skipped, true);
  assert.strictEqual(emergencyResult.reason, 'EMERGENCY_STOP_ACTIVE');
  console.log('✓ Passed: Emergency Stop immediately suspends all processing.');

  setSetting('emergency_stop', 'false');
  console.log('--- All Automation Tests Passed Successfully! ---\n');
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
