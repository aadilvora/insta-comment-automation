/**
 * Invest With Clarity - Webhook Security & Verification Test Suite
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const WebhookHandler = require('../src/services/webhookHandler');
const config = require('../src/config');

async function runTests() {
  console.log('\n--- Running Webhook Security & Signature Tests ---');

  const testSecret = 'invest_with_clarity_super_secret_test_key_12345';
  const samplePayload = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: '178414000000',
        time: 1730000000,
        changes: [
          {
            field: 'comments',
            value: { id: 'c_9988', text: 'IPO' }
          }
        ]
      }
    ]
  });

  // Test 1: Valid HMAC-SHA256 Signature
  console.log('Test 1: Valid HMAC-SHA256 signature...');
  const expectedHash = crypto
    .createHmac('sha256', testSecret)
    .update(samplePayload)
    .digest('hex');
  const validHeader = `sha256=${expectedHash}`;

  const validResult = WebhookHandler.verifySignature(samplePayload, validHeader, testSecret);
  assert.strictEqual(validResult.valid, true, 'Valid signature must pass');
  console.log('✓ Passed: Valid signature verified successfully.');

  // Test 2: Tampered Payload
  console.log('Test 2: Tampered payload with valid header...');
  const tamperedPayload = samplePayload + 'tampered';
  const tamperedResult = WebhookHandler.verifySignature(tamperedPayload, validHeader, testSecret);
  assert.strictEqual(tamperedResult.valid, false, 'Tampered payload must fail');
  console.log('✓ Passed: Tampered payload rejected.');

  // Test 3: Wrong Secret
  console.log('Test 3: Signature computed with wrong secret...');
  const wrongSecretResult = WebhookHandler.verifySignature(samplePayload, validHeader, 'wrong_secret');
  assert.strictEqual(wrongSecretResult.valid, false, 'Wrong secret must fail');
  console.log('✓ Passed: Wrong secret rejected.');

  // Test 4: Missing Header
  console.log('Test 4: Missing X-Hub-Signature-256 header...');
  const missingResult = WebhookHandler.verifySignature(samplePayload, null, testSecret);
  assert.strictEqual(missingResult.valid, false);
  assert.strictEqual(missingResult.reason, 'MISSING_SIGNATURE_HEADER');
  console.log('✓ Passed: Missing signature header rejected.');

  // Test 5: Webhook Verification Challenge (GET /webhook)
  console.log('Test 5: Webhook verification challenge handling...');
  const mockReq = {
    query: {
      'hub.mode': 'subscribe',
      // Read the configured token so this passes with or without a real .env
      'hub.verify_token': config.meta.webhookVerifyToken,
      'hub.challenge': '1158201207'
    }
  };

  let sentStatus = null;
  let sentBody = null;
  const mockRes = {
    status: (s) => {
      sentStatus = s;
      return {
        send: (b) => { sentBody = b; }
      };
    }
  };

  WebhookHandler.handleVerification(mockReq, mockRes);
  assert.strictEqual(sentStatus, 200);
  assert.strictEqual(sentBody, '1158201207');
  console.log('✓ Passed: Verification challenge correctly answered with hub.challenge.');

  console.log('--- All Webhook Security Tests Passed Successfully! ---\n');
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
