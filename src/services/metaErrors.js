/**
 * Invest With Clarity - Meta API Error Classifier
 *
 * Meta returns HTTP 400 for almost everything, including its own rate limits and
 * temporary outages. Deciding "retry or not" from the HTTP status alone therefore
 * never retries anything that is actually worth retrying, and marks a commenter as
 * permanently failed when Meta only asked us to slow down.
 *
 * This module reads error.code / error_subcode from the Graph response and sorts it
 * into one category, so the engine, the queue and the dashboard all agree on what
 * happened and whose problem it is.
 */

// Meta's documented rate-limit codes. All of these mean "come back later".
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

// Transient platform errors. Meta's own guidance is to retry these.
const TRANSIENT_CODES = new Set([1, 2]);

// Auth / configuration. Retrying cannot help; the creator must fix something.
const CONFIG_CODES = new Set([190, 200, 210, 294, 492]);

// The recipient cannot be messaged right now. Not our bug and not retryable
// for this comment: the person has restricted message requests, blocked the
// account, deactivated, or is in a region where this is not offered.
const USER_UNAVAILABLE_SUBCODES = new Set([2534022, 2534037, 2018278]);
const USER_UNAVAILABLE_CODES = new Set([551, 1545041]);

const CATEGORY = {
  RATE_LIMITED: 'RATE_LIMITED',
  TRANSIENT: 'TRANSIENT',
  CONFIG: 'CONFIG',
  USER_UNAVAILABLE: 'USER_UNAVAILABLE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  DUPLICATE: 'DUPLICATE',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Categorise an error thrown by MetaApiClient._request.
 * Returns { category, retryable, blame, explanation, code, subcode }.
 *
 * `blame` is who has to act: 'meta' (wait), 'creator' (fix settings/app),
 * 'commenter' (they must accept or change their own settings), or 'none'.
 */
function classify(err) {
  const meta = err?.metaError || {};
  const code = typeof meta.code === 'number' ? meta.code : null;
  const subcode = typeof meta.error_subcode === 'number' ? meta.error_subcode : null;
  const message = err?.message || meta.message || '';
  const status = err?.status || null;
  const lower = message.toLowerCase();

  const out = (category, retryable, blame, explanation) => ({
    category, retryable, blame, explanation, code, subcode, status, message
  });

  // A network-level failure never reached Meta at all: always worth one more try.
  if (!status && !code) {
    return out(
      CATEGORY.TRANSIENT, true, 'meta',
      'The request did not reach Meta (network or DNS). Retrying.'
    );
  }

  if (status >= 500 && status < 600) {
    return out(CATEGORY.TRANSIENT, true, 'meta', `Meta returned HTTP ${status}. Retrying.`);
  }

  if (status === 429 || RATE_LIMIT_CODES.has(code) || lower.includes('rate limit')) {
    return out(
      CATEGORY.RATE_LIMITED, true, 'meta',
      'Meta rate limit reached. The message is queued and will be retried automatically.'
    );
  }

  if (TRANSIENT_CODES.has(code)) {
    return out(
      CATEGORY.TRANSIENT, true, 'meta',
      'Temporary Meta platform error. The message will be retried automatically.'
    );
  }

  if (CONFIG_CODES.has(code)) {
    return out(
      CATEGORY.CONFIG, false, 'creator',
      'Meta rejected the access token or a permission. Reconnect the Instagram account ' +
      'and confirm instagram_manage_messages and instagram_manage_comments are granted.'
    );
  }

  if (USER_UNAVAILABLE_CODES.has(code) || (subcode && USER_UNAVAILABLE_SUBCODES.has(subcode))) {
    return out(
      CATEGORY.USER_UNAVAILABLE, false, 'commenter',
      'Instagram will not deliver a message to this person right now. They have message ' +
      'requests switched off, have blocked the account, or their account is restricted. ' +
      'This is their own privacy setting — it cannot be overridden, and we do not try to.'
    );
  }

  // (#10) is permission-shaped but Meta also uses it for "person not available".
  if (code === 10) {
    return subcode && USER_UNAVAILABLE_SUBCODES.has(subcode)
      ? out(CATEGORY.USER_UNAVAILABLE, false, 'commenter',
          'This person is not accepting message requests.')
      : out(CATEGORY.CONFIG, false, 'creator',
          'Meta denied permission for this call. Check the app has instagram_manage_messages ' +
          'and that the Instagram account is a Business/Creator account linked to the Page.');
  }

  // (#100) on a private reply is the single most common failure, and in practice it
  // almost always means the Meta app is still in Development Mode: in that mode a
  // message can only be sent to a person who holds a role on the app, so every
  // ordinary commenter fails this way regardless of whether their account is private.
  if (code === 100 || lower.includes('does not exist') || lower.includes('cannot be found')) {
    return out(
      CATEGORY.TARGET_NOT_FOUND, false, 'creator',
      'Meta could not resolve the comment or the recipient. The usual cause is the Meta app ' +
      'still being in Development Mode — in that mode only people with a role on the app ' +
      '(admin/developer/tester) can be messaged, so every normal commenter fails. ' +
      'Switch the app to Live mode in the Meta dashboard. It can also mean the comment was ' +
      'deleted, or it is older than Meta\'s 7-day private reply window.'
    );
  }

  if (lower.includes('outside') && lower.includes('window')) {
    return out(
      CATEGORY.WINDOW_CLOSED, false, 'commenter',
      'The 24-hour messaging window is closed. Meta only allows a follow-up message within ' +
      '24 hours of the person\'s own last message.'
    );
  }

  if (lower.includes('already') && lower.includes('replied')) {
    return out(CATEGORY.DUPLICATE, false, 'none', 'A private reply was already sent for this comment.');
  }

  return out(
    CATEGORY.UNKNOWN, false, 'creator',
    `Unrecognised Meta error${code ? ` (#${code}${subcode ? `/${subcode}` : ''})` : ''}: ${message}`
  );
}

function isRetryable(err) {
  return classify(err).retryable;
}

module.exports = { classify, isRetryable, CATEGORY };
