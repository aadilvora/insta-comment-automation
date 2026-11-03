/**
 * Invest With Clarity - Delivery Resilience Test Suite
 *
 * Covers the 2026-11-01 report: "a comment from a private account gets no public
 * reply and no DM". Each test below pins one of the causes found.
 */

const assert = require('node:assert');
const path = require('path');
const { initDatabase, execute, queryOne, setSetting } = require('../src/database/db');
const AutomationEngine = require('../src/services/automationEngine');
const PolicyChecker = require('../src/services/policyChecker');
const MetaErrors = require('../src/services/metaErrors');
const metaApiClient = require('../src/services/metaApiClient');

initDatabase(path.resolve(__dirname, '../test_automation.db'));

function metaError(message, code, subcode = null, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.metaError = { message, code, error_subcode: subcode };
  return err;
}

function seedCampaign() {
  execute('DELETE FROM processed_comments');
  execute('DELETE FROM outbound_messages');
  execute('DELETE FROM campaigns');
  execute('DELETE FROM user_threads');
  execute('DELETE FROM activity_logs');
  setSetting('emergency_stop', 'false');
  setSetting('automation_paused', 'false');

  execute(
    `INSERT INTO campaigns (name, post_id, keywords, match_type, public_reply_enabled,
       public_reply_text, initial_private_reply_text, report_text, is_active, status)
     VALUES (?, ?, ?, 'contains', 1, ?, ?, ?, 1, 'ACTIVE')`,
    [
      'Delivery Test Campaign', 'post_test_001', JSON.stringify(['REPORT']),
      'Public reply for @{{username}}',
      'Private DM for {{first_name}}',
      'Here is your report.'
    ]
  );
  return queryOne('SELECT id FROM campaigns WHERE post_id = ?', ['post_test_001']).id;
}

function comment(id, text = 'send me the REPORT') {
  return {
    id,
    text,
    from: { id: 'user_private_001', username: 'private_person' },
    media: { id: 'post_test_001' }
  };
}

async function runTests() {
  console.log('\n--- Running Delivery Resilience Tests ---');
  metaApiClient.mockMode = true;

  // ---------------------------------------------------------------- Test 1
  // The reported symptom. The DM fails; the public comment reply must still
  // have been posted. Previously the private-reply gate returned early and the
  // public reply was never attempted.
  console.log('Test 1: a failed DM must not suppress the public comment reply...');
  seedCampaign();

  const realSendPrivate = metaApiClient.sendPrivateReply;
  metaApiClient.sendPrivateReply = async () => {
    throw metaError("(#10) This person isn't available right now.", 10, 2534022);
  };

  await AutomationEngine.processComment(comment('c_test_1'));

  let row = queryOne('SELECT * FROM processed_comments WHERE comment_id = ?', ['c_test_1']);
  assert.strictEqual(row.public_reply_status, 'sent',
    'Public reply must be sent even when the DM fails');
  assert.strictEqual(row.private_reply_status, 'failed');
  assert.strictEqual(row.error_category, 'USER_UNAVAILABLE');
  console.log('✓ Passed: public reply sent; DM failure recorded as USER_UNAVAILABLE.');

  // ---------------------------------------------------------------- Test 2
  // A person who has switched off message requests must not be messaged again.
  console.log('Test 2: a refusal is terminal — no repeat attempts...');
  const state2 = PolicyChecker.getCommentState('c_test_1');
  assert.strictEqual(state2.retryingPrivateReply, false,
    'USER_UNAVAILABLE must never be retried');
  assert.strictEqual(state2.shouldProcess, false);
  console.log('✓ Passed: USER_UNAVAILABLE is terminal, the person is left alone.');

  // ---------------------------------------------------------------- Test 3
  // A rate limit is Meta asking us to wait, not a dead commenter. It used to
  // be filed as a permanent failure because the HTTP status is 400.
  console.log('Test 3: a rate-limited DM stays retryable...');
  metaApiClient.sendPrivateReply = async () => {
    throw metaError('(#4) Application request limit reached', 4);
  };
  await AutomationEngine.processComment(comment('c_test_3'));

  row = queryOne('SELECT * FROM processed_comments WHERE comment_id = ?', ['c_test_3']);
  assert.strictEqual(row.public_reply_status, 'sent');
  assert.strictEqual(row.error_category, 'RATE_LIMITED');

  const state3 = PolicyChecker.getCommentState('c_test_3');
  assert.strictEqual(state3.retryingPrivateReply, true,
    'A rate-limited comment must be eligible for another attempt');
  console.log('✓ Passed: rate limit is retryable, not a permanent failure.');

  // ---------------------------------------------------------------- Test 4
  // The retry itself. The old dedup treated any existing row as "done", and the
  // INSERT would have thrown on the UNIQUE comment_id anyway.
  console.log('Test 4: the retry runs and succeeds...');
  metaApiClient.sendPrivateReply = realSendPrivate;
  await AutomationEngine.processComment(comment('c_test_3'));

  row = queryOne('SELECT * FROM processed_comments WHERE comment_id = ?', ['c_test_3']);
  assert.strictEqual(row.private_reply_status, 'sent',
    'The second attempt must deliver the DM');
  assert.strictEqual(row.attempts, 2, 'Attempt count must advance');
  console.log('✓ Passed: comment reprocessed and the DM delivered on retry.');

  // ---------------------------------------------------------------- Test 5
  // A delivered private reply sits in Message Requests. Nothing more may be
  // sent until the person accepts, and that wait is a state, not a failure.
  console.log('Test 5: a delivered DM is marked pending_acceptance...');
  let thread = queryOne('SELECT * FROM user_threads WHERE user_id = ?', ['user_private_001']);
  assert.strictEqual(thread.dm_state, 'pending_acceptance');
  assert.strictEqual(thread.conversation_stage, 'awaiting_reply');

  const windowCheck = PolicyChecker.isMessagingWindowOpen('user_private_001');
  assert.strictEqual(windowCheck.allowed, false,
    'No follow-up may be sent before the person replies');
  assert.strictEqual(windowCheck.reason, 'NO_INBOUND_CONVERSATION');
  console.log('✓ Passed: waiting for acceptance; follow-up correctly withheld.');

  // ---------------------------------------------------------------- Test 6
  // The person accepts and replies. That opens the 24-hour window and the
  // report goes out — which is exactly the flow the creator described.
  console.log('Test 6: acceptance opens the window and the report is delivered...');
  await AutomationEngine.processInboundMessage({
    sender: { id: 'user_private_001' },
    message: { text: 'DONE' },
    timestamp: Date.now()
  });

  thread = queryOne('SELECT * FROM user_threads WHERE user_id = ?', ['user_private_001']);
  assert.strictEqual(thread.dm_state, 'accepted');
  assert.strictEqual(thread.conversation_stage, 'report_delivered');

  const report = queryOne(
    "SELECT * FROM outbound_messages WHERE user_id = ? AND message_type = 'report' AND status = 'sent'",
    ['user_private_001']
  );
  assert.ok(report, 'The report must be delivered once the person accepts and replies');
  console.log('✓ Passed: acceptance recorded, window opened, report sent.');

  // ---------------------------------------------------------------- Test 7
  // Dev Mode is the most common real cause of a silent DM failure.
  console.log('Test 7: (#100) is explained as Development Mode, not blamed on the user...');
  const verdict = MetaErrors.classify(
    metaError('(#100) The requested user cannot be found.', 100)
  );
  assert.strictEqual(verdict.category, 'TARGET_NOT_FOUND');
  assert.strictEqual(verdict.retryable, false);
  assert.strictEqual(verdict.blame, 'creator');
  assert.ok(/Development Mode/i.test(verdict.explanation));
  console.log('✓ Passed: (#100) names Development Mode as the likely cause.');

  // ---------------------------------------------------------------- Test 8
  // A pause must still win over all of the above.
  console.log('Test 8: pause still blocks everything...');
  seedCampaign();
  setSetting('automation_paused', 'true');
  const paused = await AutomationEngine.processComment(comment('c_test_8'));
  assert.strictEqual(paused.skipped, true);
  assert.strictEqual(paused.reason, 'AUTOMATION_PAUSED');
  assert.strictEqual(
    queryOne('SELECT COUNT(*) n FROM outbound_messages').n, 0,
    'Nothing may be sent while paused'
  );
  setSetting('automation_paused', 'false');
  console.log('✓ Passed: a paused system sends nothing, public or private.');

  // ---------------------------------------------------------------- Test 9
  // Reset clears this campaign's own records and nothing else.
  console.log('Test 9: reset clears one campaign and leaves others alone...');
  const CampaignService = require('../src/services/campaignService');
  const campA = seedCampaign();

  execute(
    `INSERT INTO campaigns (name, post_id, keywords, match_type, public_reply_enabled,
       public_reply_text, initial_private_reply_text, is_active, status)
     VALUES ('Other Campaign', 'post_other', '[\"OTHER\"]', 'contains', 1, 'p', 'd', 1, 'ACTIVE')`
  );
  const campB = queryOne('SELECT id FROM campaigns WHERE post_id = ?', ['post_other']).id;

  metaApiClient.sendPrivateReply = realSendPrivate;
  await AutomationEngine.processComment(comment('c_reset_a'));
  execute(
    `INSERT INTO outbound_messages (user_id, campaign_id, message_type, message_content, status)
     VALUES ('user_other', ?, 'public_reply', 'x', 'sent')`,
    [campB]
  );

  assert.ok(
    queryOne('SELECT COUNT(*) n FROM processed_comments WHERE matched_campaign_id = ?', [campA]).n > 0,
    'Campaign A should have records before the reset'
  );

  const reset = CampaignService.resetData(campA);
  assert.strictEqual(reset.success, true);

  assert.strictEqual(
    queryOne('SELECT COUNT(*) n FROM processed_comments WHERE matched_campaign_id = ?', [campA]).n, 0,
    'Campaign A comments must be cleared'
  );
  assert.strictEqual(
    queryOne('SELECT COUNT(*) n FROM outbound_messages WHERE campaign_id = ?', [campA]).n, 0,
    'Campaign A messages must be cleared'
  );
  assert.strictEqual(
    queryOne('SELECT COUNT(*) n FROM outbound_messages WHERE campaign_id = ?', [campB]).n, 1,
    'Campaign B must be untouched'
  );
  assert.ok(
    queryOne('SELECT id FROM campaigns WHERE id = ?', [campA]),
    'The campaign itself and its wording must survive the reset'
  );
  assert.ok(
    queryOne("SELECT id FROM activity_logs WHERE action = 'CAMPAIGN_DATA_RESET'"),
    'The reset must be recorded in the audit log'
  );
  console.log('✓ Passed: reset scoped to one campaign; settings and audit log kept.');

  // ---------------------------------------------------------------- Test 10
  // After a reset the same comment is treated as new again by OUR rules.
  console.log('Test 10: after reset the comment is processed again...');
  const afterReset = PolicyChecker.getCommentState('c_reset_a');
  assert.strictEqual(afterReset.seen, false,
    'A reset campaign must treat a previously handled comment as unseen');
  console.log('✓ Passed: comment is replayable after a reset.');

  // ---------------------------------------------------------------- Test 11
  // The poller exists because webhooks fail silently. It must still obey the
  // kill switches, or a "stopped" system would keep acting on its own timer.
  console.log('Test 11: the poller obeys emergency stop and pause...');
  const PollingService = require('../src/services/pollingService');

  setSetting('emergency_stop', 'true');
  let polled = await PollingService.runOnce({ manual: true });
  assert.strictEqual(polled.skipped, true);
  assert.strictEqual(polled.reason, 'EMERGENCY_STOP_ACTIVE');
  setSetting('emergency_stop', 'false');

  setSetting('automation_paused', 'true');
  polled = await PollingService.runOnce({ manual: true });
  assert.strictEqual(polled.skipped, true);
  assert.strictEqual(polled.reason, 'AUTOMATION_PAUSED');
  setSetting('automation_paused', 'false');
  console.log('✓ Passed: a halted system does not poll.');

  // ---------------------------------------------------------------- Test 12
  // A mistyped interval must not burn the account's hourly Meta quota.
  console.log('Test 12: the poll interval has a floor...');
  assert.strictEqual(PollingService.setInterval(1), 30,
    'An interval below the floor must be clamped to 30s');
  assert.strictEqual(PollingService.setInterval(120), 120);
  PollingService.setInterval(60);
  PollingService.stop();
  console.log('✓ Passed: interval clamped to a safe floor.');

  metaApiClient.sendPrivateReply = realSendPrivate;
  console.log('--- All Delivery Resilience Tests Passed! ---');
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => { console.error(err); process.exit(1); });
}
