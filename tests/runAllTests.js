/**
 * Invest With Clarity - Master Test Suite Runner
 */

const runAutomationTests = require('./automation.test');
const runPolicyTests = require('./policy.test');
const runWebhookTests = require('./webhook.test');
const runDeliveryTests = require('./delivery.test');

async function main() {
  console.log('===========================================================');
  console.log('🧪 Invest With Clarity — Master Test Suite Verification');
  console.log('===========================================================');

  try {
    await runAutomationTests();
    await runPolicyTests();
    await runWebhookTests();
    await runDeliveryTests();

    console.log('===========================================================');
    console.log('🎉 ALL TEST SUITES PASSED CLEANLY (100% Policy Compliant)!');
    console.log('===========================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST RUN FAILED:', err);
    process.exit(1);
  }
}

main();
