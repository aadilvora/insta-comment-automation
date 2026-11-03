/**
 * Invest With Clarity - Meta Policy & Compliance Test Suite
 */

const assert = require('node:assert');
const path = require('path');
const { initDatabase, execute, setSetting } = require('../src/database/db');
const PolicyChecker = require('../src/services/policyChecker');

initDatabase(path.resolve(__dirname, '../test_automation.db'));

async function runTests() {
  console.log('\n--- Running Policy & Compliance Enforcement Tests ---');

  // Clear tables
  execute('DELETE FROM outbound_messages');
  execute('DELETE FROM user_threads');
  setSetting('emergency_stop', 'false');

  // Test 1: 7-Day Comment Age Check
  console.log('Test 1: 7-day comment age restriction...');
  const recentCommentTime = new Date(); // right now
  const eligibleCheck = PolicyChecker.canSendPrivateReply('c_fresh_101', recentCommentTime);
  assert.strictEqual(eligibleCheck.allowed, true, 'Fresh comment must be eligible');

  const oldCommentTime = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000); // 9 days old
  const expiredCheck = PolicyChecker.canSendPrivateReply('c_old_102', oldCommentTime);
  assert.strictEqual(expiredCheck.allowed, false, 'Comment > 7 days must be blocked');
  assert.strictEqual(expiredCheck.reason, 'COMMENT_EXPIRED');
  console.log('✓ Passed: Comments > 7 days correctly blocked per Meta policy.');

  // Test 2: 24-Hour Messaging Window Enforcement
  console.log('Test 2: 24-hour standard messaging window...');
  // Scenario A: User has not replied in DM yet
  const noConvoCheck = PolicyChecker.isMessagingWindowOpen('u_random_999');
  assert.strictEqual(noConvoCheck.allowed, false);
  assert.strictEqual(noConvoCheck.reason, 'NO_INBOUND_CONVERSATION');
  console.log('✓ Passed: Freeform DM blocked when no inbound conversation exists.');

  // Scenario B: User replied 2 hours ago (Window OPEN)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const activeWindowExpires = new Date(twoHoursAgo.getTime() + 24 * 60 * 60 * 1000);
  execute(
    `INSERT INTO user_threads (user_id, last_inbound_time, messaging_window_expires_at)
     VALUES (?, ?, ?)`,
    ['u_active_user', twoHoursAgo.toISOString(), activeWindowExpires.toISOString()]
  );

  const activeCheck = PolicyChecker.isMessagingWindowOpen('u_active_user');
  assert.strictEqual(activeCheck.allowed, true);
  console.log('✓ Passed: Follow-up permitted inside active 24-hour window.');

  // Scenario C: User replied 26 hours ago (Window EXPIRED)
  const twentySixHoursAgo = new Date(Date.now() - 26 * 60 * 60 * 1000);
  const expiredWindowExpires = new Date(twentySixHoursAgo.getTime() + 24 * 60 * 60 * 1000);
  execute(
    `INSERT INTO user_threads (user_id, last_inbound_time, messaging_window_expires_at)
     VALUES (?, ?, ?)`,
    ['u_expired_user', twentySixHoursAgo.toISOString(), expiredWindowExpires.toISOString()]
  );

  const expiredWindowCheck = PolicyChecker.isMessagingWindowOpen('u_expired_user');
  assert.strictEqual(expiredWindowCheck.allowed, false);
  assert.strictEqual(expiredWindowCheck.reason, '24_HOUR_WINDOW_EXPIRED');
  console.log('✓ Passed: Follow-up strictly blocked when 24-hour window has elapsed.');

  // Test 3: Follower Verification Compliance Logic
  console.log('Test 3: Follower verification transparency and compliance...');
  const commentTimeCheck = PolicyChecker.evaluateFollowerVerification('comment_time');
  assert.strictEqual(commentTimeCheck.supported, false);
  assert.strictEqual(commentTimeCheck.classification, 'NOT_SUPPORTED');
  console.log('✓ Passed: Arbitrary follower check at comment time correctly flagged as NOT SUPPORTED.');

  const postDmCheck = PolicyChecker.evaluateFollowerVerification('post_dm');
  assert.strictEqual(postDmCheck.supported, true);
  assert.strictEqual(postDmCheck.classification, 'SUPPORTED_WITH_CONDITIONS');
  console.log('✓ Passed: Post-DM follower check recognized as SUPPORTED WITH CONDITIONS.');

  console.log('--- All Policy Tests Passed Successfully! ---\n');
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
