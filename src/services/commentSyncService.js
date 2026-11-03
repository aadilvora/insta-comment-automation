/**
 * Invest With Clarity - Comment Backfill
 *
 * Webhooks are the primary path, but they are delivered exactly once. If the
 * public tunnel is down, the server is restarted, or the subscription lapses,
 * Meta's delivery fails and that comment is gone for good — the person waits
 * for a reply that can never arrive, and nothing in the dashboard shows it.
 *
 * This reads the comments Instagram already holds (GET /{media-id}/comments)
 * and feeds anything unseen through the ordinary automation path. It is a
 * safety net, not a replacement: every policy gate, pause switch and the
 * one-reply-per-comment rule still apply, because the comments go through
 * AutomationEngine.processComment exactly as a webhook would.
 */

const { queryOne, queryAll, execute } = require('../database/db');
const metaApiClient = require('./metaApiClient');
const AutomationEngine = require('./automationEngine');
const PolicyChecker = require('./policyChecker');
const LoggerService = require('./loggerService');
const config = require('../config');


/**
 * Convert a Graph API comment into the shape the webhook handler produces, so
 * one code path serves both. Graph returns an ISO timestamp; the webhook sends
 * unix seconds, and processComment expects the latter.
 */
function toWebhookShape(comment, postId) {
  const iso = comment.timestamp || comment.created_time;
  return {
    id: comment.id,
    text: comment.text || '',
    from: {
      id: comment.from?.id || null,
      username: comment.from?.username || comment.username || 'Investor'
    },
    media: { id: postId },
    created_time: iso ? Math.floor(new Date(iso).getTime() / 1000) : undefined
  };
}

function ageInDays(comment) {
  const iso = comment.timestamp || comment.created_time;
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Backfill one post.
 *
 * @param {string} postId
 * @param {Object} opts
 * @param {boolean} opts.dryRun  Report what would happen; send nothing.
 * @param {number}  opts.limit   Max comments to pull from Meta.
 */
async function syncPost(postId, { dryRun = false, limit = 50 } = {}) {
  const result = {
    postId,
    dryRun,
    fetched: 0,
    alreadyHandled: 0,
    tooOld: 0,
    noSenderId: 0,
    processed: 0,
    wouldProcess: [],
    outcomes: []
  };

  let page;
  try {
    page = await metaApiClient._request(`${postId}/comments`, {
      method: 'GET',
      params: { fields: 'id,text,timestamp,username,from{id,username}', limit }
    });
  } catch (err) {
    LoggerService.log({
      postId,
      action: 'COMMENT_SYNC_FAILED',
      status: 'FAILURE',
      details: { error: err.message, meta: err.metaError || null }
    });
    throw err;
  }

  const comments = page?.data || [];
  result.fetched = comments.length;

  // Our own replies are comments too. Replying to ourselves would be absurd and
  // would burn the one private reply Meta allows per comment.
  const ownAccountId = String(config.meta.instagramAccountId || '');
  const eligible = comments.filter(c => String(c.from?.id || '') !== ownAccountId);
  result.ownComments = comments.length - eligible.length;
  result.eligible = eligible.length;

  for (const comment of eligible) {
    // Already settled by a webhook or an earlier sync — leave it alone. This is
    // what keeps the backfill from replying twice to the same person.
    const state = PolicyChecker.getCommentState(comment.id);
    if (!state.shouldProcess) {
      result.alreadyHandled += 1;
      continue;
    }

    // Past Meta's 7-day private reply window. Recorded so the count is honest,
    // but not sent: a DM would be refused and a public reply on a week-old
    // comment is not what the automation is for.
    const age = ageInDays(comment);
    if (age !== null && age > config.safeguards.maxCommentAgeDays) {
      result.tooOld += 1;
      continue;
    }

    if (!comment.from?.id) {
      result.noSenderId += 1;
      continue;
    }

    const shaped = toWebhookShape(comment, postId);

    if (dryRun) {
      const match = AutomationEngine.matchCampaign(postId, shaped.text);
      result.wouldProcess.push({
        commentId: comment.id,
        username: shaped.from.username,
        text: shaped.text,
        ageDays: age === null ? null : Number(age.toFixed(2)),
        matches: Boolean(match),
        campaign: match ? match.campaign.name : null,
        keyword: match ? match.matchedKeyword : null
      });
      continue;
    }

    const outcome = await AutomationEngine.processComment(shaped);
    result.processed += 1;
    result.outcomes.push({
      commentId: comment.id,
      username: shaped.from.username,
      text: shaped.text,
      ...outcome
    });
  }

  // Record what the API actually exposes for this post. The card compares against
  // this, never against Instagram's comments_count, which also counts replies.
  execute(
    `UPDATE instagram_posts
        SET api_comment_count = ?, eligible_comment_count = ?, last_comment_sync_at = CURRENT_TIMESTAMP
      WHERE post_id = ?`,
    [result.fetched, result.eligible, postId]
  );

  LoggerService.log({
    postId,
    action: dryRun ? 'COMMENT_SYNC_PREVIEW' : 'COMMENT_SYNC_RUN',
    status: 'SUCCESS',
    details: {
      fetched: result.fetched,
      processed: result.processed,
      alreadyHandled: result.alreadyHandled,
      tooOld: result.tooOld,
      noSenderId: result.noSenderId,
      ownComments: result.ownComments
    }
  });

  return result;
}

/**
 * Backfill every post that an ACTIVE campaign targets. A campaign aimed at the
 * wildcard '*' has no single media id, so it is covered by syncing each known
 * post instead.
 */
async function syncActiveCampaignPosts({ dryRun = false, limit = 50 } = {}) {
  const wildcard = queryOne(
    "SELECT COUNT(*) as count FROM campaigns WHERE status = 'ACTIVE' AND post_id = '*'"
  )?.count || 0;

  const rows = wildcard
    ? queryAll('SELECT post_id FROM instagram_posts ORDER BY published_at DESC LIMIT 25')
    : queryAll("SELECT DISTINCT post_id FROM campaigns WHERE status = 'ACTIVE' AND post_id <> '*'");

  const results = [];
  for (const row of rows) {
    try {
      results.push(await syncPost(row.post_id, { dryRun, limit }));
    } catch (err) {
      results.push({ postId: row.post_id, error: err.message });
    }
  }

  return {
    dryRun,
    posts: results.length,
    totalProcessed: results.reduce((a, r) => a + (r.processed || 0), 0),
    totalFetched: results.reduce((a, r) => a + (r.fetched || 0), 0),
    results
  };
}

module.exports = { syncPost, syncActiveCampaignPosts };
