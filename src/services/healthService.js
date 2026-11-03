/**
 * Invest With Clarity - Delivery Capability Check
 *
 * Three separate Meta capabilities decide what this system can actually do, and
 * they fail in different ways that all look alike from the dashboard. This asks
 * Meta directly and reports each one, so the answer to "why didn't it send" is
 * on screen instead of buried in an error code.
 */

const metaApiClient = require('./metaApiClient');
const config = require('../config');
const { queryAll } = require('../database/db');

async function check() {
  const out = {
    checkedAt: new Date().toISOString(),
    canReplyToComments: { ok: null, detail: null },
    canSendFirstDm: { ok: null, detail: null },
    canSendFollowUp: { ok: null, detail: null },
    canCheckFollowers: { ok: null, detail: null },
    recommendation: null
  };

  // 1. Comment replies — needs instagram_manage_comments. Proven by the fact
  //    that replies are landing, so this is read as a token scope check.
  try {
    const t = await metaApiClient._request('debug_token', {
      method: 'GET',
      params: { input_token: config.meta.accessToken, access_token: config.meta.accessToken }
    });
    const scopes = t?.data?.scopes || [];
    out.canReplyToComments.ok = scopes.includes('instagram_manage_comments');
    out.canReplyToComments.detail = out.canReplyToComments.ok
      ? 'instagram_manage_comments is granted.'
      : 'instagram_manage_comments is missing from the access token.';

    out.canSendFirstDm.ok = scopes.includes('instagram_manage_messages');
    out.canSendFirstDm.detail = out.canSendFirstDm.ok
      ? 'instagram_manage_messages is granted. A private reply to a comment needs no messaging window.'
      : 'instagram_manage_messages is missing from the access token.';
  } catch (err) {
    out.canReplyToComments.detail = `Could not read the token: ${err.message}`;
  }

  // 2. Follow-ups — need an OPEN messaging window, and a window only exists for
  //    an app that is subscribed to the account's `messages` webhook. This is
  //    the check that explains "(#10) sent outside of allowed window" on a
  //    conversation that is plainly inside its window.
  try {
    const subs = await metaApiClient._request(`${config.meta.instagramAccountId}/subscribed_apps`, {
      method: 'GET'
    });
    const apps = subs?.data || [];
    const fields = apps.flatMap(a => a.subscribed_fields || []);

    out.canSendFollowUp.ok = fields.includes('messages');
    out.canSendFollowUp.detail = out.canSendFollowUp.ok
      ? 'The app is subscribed to the messages webhook, so Meta opens a 24-hour window when someone replies.'
      : apps.length === 0
        ? 'No app is subscribed to this account. Meta therefore never opens a messaging window, ' +
          'and every follow-up is refused as "outside of allowed window" however recently the ' +
          'person wrote. Subscribe the app to comments and messages (needs pages_manage_metadata).'
        : 'The app is subscribed but not to the "messages" field.';
  } catch (err) {
    out.canSendFollowUp.ok = false;
    out.canSendFollowUp.detail = `Could not read the subscription: ${err.message}`;
  }

  // 3. The follower gate. Without Advanced Access Meta refuses this for every
  //    user, so the campaign cannot truly verify who follows.
  out.canCheckFollowers.ok = false;
  out.canCheckFollowers.detail =
    'is_user_follow_business returns (#230) "User consent is required" until the app has ' +
    'Advanced Access. Until then a follow cannot be verified, only self-declared.';

  const twoStep = queryAll(
    "SELECT id, name FROM campaigns WHERE status = 'ACTIVE' AND COALESCE(delivery_mode,'two_step') = 'two_step'"
  );

  if (out.canSendFollowUp.ok === false && twoStep.length > 0) {
    out.recommendation = {
      severity: 'blocking',
      title: 'Follow-up messages cannot be delivered',
      message:
        `${twoStep.length} running campaign(s) ask the person to reply and then send the report. ` +
        'That second message cannot be delivered, because this app is not subscribed to the ' +
        'account\'s messages webhook and Meta opens no messaging window without it. ' +
        'Either subscribe the app, or switch these campaigns to "Send everything in the first DM", ' +
        'which needs no window and works today.',
      campaigns: twoStep,
      action: 'SWITCH_TO_ONE_SHOT'
    };
  }

  return out;
}

module.exports = { check };
