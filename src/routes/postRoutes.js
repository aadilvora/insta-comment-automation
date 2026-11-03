/**
 * Invest With Clarity - Instagram Posts & Reels Routes
 * Powers the "Instagram Posts & Reels" page, where every Reel is its own card
 * with its own stats and its own controls.
 */

const express = require('express');
const router = express.Router();
const PostsService = require('../services/postsService');
const StatsService = require('../services/statsService');
const CommentSync = require('../services/commentSyncService');

// LIST every known post/Reel with its campaigns and its own scoped stats
router.get('/', (req, res) => {
  try {
    const range = req.query.range || 'all';
    res.json({ success: true, posts: PostsService.listWithStats(range), range });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Backfill comments straight from Meta.
 *
 * Webhooks are delivered once. Anything that arrived while the public URL was
 * unreachable is lost unless it is fetched back, which is what this does.
 * Always preview first (`dryRun: true`) — the live run sends real replies.
 */
router.post('/sync-comments', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false; // preview unless explicitly disabled
    const limit = parseInt(req.body?.limit, 10) || 50;
    const postId = req.body?.postId;

    const result = postId
      ? await CommentSync.syncPost(postId, { dryRun, limit })
      : await CommentSync.syncActiveCampaignPosts({ dryRun, limit });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SYNC from Meta Graph API
router.post('/sync', async (req, res) => {
  try {
    const result = await PostsService.syncFromMeta({ limit: req.body?.limit || 50 });
    const code = result.success ? 200 : 400;
    res.status(code).json({
      ...result,
      posts: PostsService.listWithStats(req.body?.range || 'all')
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ADD a post by hand (for use before the Meta connection is live)
router.post('/manual', (req, res) => {
  try {
    const result = PostsService.addManual(req.body || {});
    res.status(result.success ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET one post with its own stats
router.get('/:postId', (req, res) => {
  try {
    const post = PostsService.getOne(req.params.postId);
    res.json({
      success: true,
      post: post || { post_id: req.params.postId, not_synced: true },
      stats: StatsService.getPostStats(req.params.postId, req.query.range || 'all')
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REMOVE a cached post (refused while campaigns still point at it)
router.delete('/:postId', (req, res) => {
  try {
    const result = PostsService.remove(req.params.postId);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
