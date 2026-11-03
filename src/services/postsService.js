/**
 * Invest With Clarity - Instagram Posts & Reels Service
 * Syncs media from the official Graph API endpoint
 *   GET /{ig-user-id}/media?fields=id,caption,media_type,media_product_type,
 *       permalink,thumbnail_url,media_url,timestamp,comments_count,like_count
 * and caches it locally so each Reel can be rendered as its own card with a
 * thumbnail, caption and publish date even when the dashboard is offline.
 */

const { queryAll, queryOne, execute } = require('../database/db');
const metaApiClient = require('./metaApiClient');
const LoggerService = require('./loggerService');
const StatsService = require('./statsService');
const config = require('../config');

class PostsService {
  /**
   * Pull the latest media from Meta and upsert it into the local cache.
   * Returns { success, synced, error } — a failure here is never fatal, the
   * dashboard simply keeps showing the last cached set.
   */
  static async syncFromMeta({ limit = 50 } = {}) {
    const accountId = config.meta.instagramAccountId;

    if (!metaApiClient.accessToken) {
      return {
        success: false,
        code: 'TOKEN_MISSING',
        error: 'No META_ACCESS_TOKEN configured. Connect Instagram in Settings to sync your Reels.'
      };
    }
    if (!accountId) {
      return {
        success: false,
        code: 'ACCOUNT_MISSING',
        error: 'No INSTAGRAM_ACCOUNT_ID configured.'
      };
    }

    try {
      const response = await metaApiClient.getAccountMedia(accountId, limit);
      const media = (response && response.data) || [];
      let synced = 0;

      for (const item of media) {
        this.upsert({
          post_id: item.id,
          media_type: item.media_type || null,
          media_product_type: item.media_product_type || null,
          caption: item.caption || null,
          permalink: item.permalink || null,
          thumbnail_url: item.thumbnail_url || item.media_url || null,
          media_url: item.media_url || null,
          published_at: item.timestamp || null,
          comments_count: item.comments_count || 0,
          like_count: item.like_count || 0,
          is_manual: 0
        });
        synced += 1;
      }

      LoggerService.log({
        action: 'INSTAGRAM_MEDIA_SYNCED',
        status: 'SUCCESS',
        details: { synced }
      });

      return { success: true, synced };
    } catch (err) {
      LoggerService.log({
        action: 'INSTAGRAM_MEDIA_SYNC_FAILED',
        status: 'FAILURE',
        details: { error: err.message }
      });
      return { success: false, code: 'SYNC_FAILED', error: err.message };
    }
  }

  /**
   * Insert or update one cached post.
   */
  static upsert(post) {
    execute(
      `INSERT INTO instagram_posts (
          post_id, media_type, media_product_type, caption, permalink,
          thumbnail_url, media_url, published_at, comments_count, like_count,
          is_manual, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(post_id) DO UPDATE SET
          media_type = excluded.media_type,
          media_product_type = excluded.media_product_type,
          caption = excluded.caption,
          permalink = excluded.permalink,
          thumbnail_url = excluded.thumbnail_url,
          media_url = excluded.media_url,
          published_at = excluded.published_at,
          comments_count = excluded.comments_count,
          like_count = excluded.like_count,
          synced_at = CURRENT_TIMESTAMP`,
      [
        post.post_id,
        post.media_type || null,
        post.media_product_type || null,
        post.caption || null,
        post.permalink || null,
        post.thumbnail_url || null,
        post.media_url || null,
        post.published_at || null,
        post.comments_count || 0,
        post.like_count || 0,
        post.is_manual ? 1 : 0
      ]
    );

    return queryOne('SELECT * FROM instagram_posts WHERE post_id = ?', [post.post_id]);
  }

  /**
   * Add a post by hand. Lets the creator build campaigns before the Meta
   * connection is live, using a post ID copied from Instagram.
   */
  static addManual({ post_id, caption = null, permalink = null, thumbnail_url = null, published_at = null }) {
    if (!post_id || !String(post_id).trim()) {
      return { success: false, error: 'A post ID is required' };
    }

    const post = this.upsert({
      post_id: String(post_id).trim(),
      caption,
      permalink,
      thumbnail_url,
      published_at,
      media_product_type: 'REELS',
      is_manual: 1
    });

    LoggerService.log({
      postId: post_id,
      action: 'POST_ADDED_MANUALLY',
      status: 'SUCCESS',
      details: { post_id }
    });

    return { success: true, post };
  }

  /**
   * Every post the dashboard knows about, each with its own campaigns and its
   * own stats. Posts that have campaigns but were never synced from Meta still
   * appear, so a campaign is never orphaned off-screen.
   */
  static listWithStats(range = 'all') {
    const cached = queryAll('SELECT * FROM instagram_posts');
    const byId = new Map(cached.map(p => [p.post_id, { ...p }]));

    // Surface post IDs that only exist on campaigns (e.g. seeded or hand-typed).
    for (const row of queryAll('SELECT DISTINCT post_id FROM campaigns')) {
      if (!byId.has(row.post_id)) {
        byId.set(row.post_id, {
          post_id: row.post_id,
          caption: null,
          permalink: null,
          thumbnail_url: null,
          published_at: null,
          media_product_type: null,
          comments_count: 0,
          like_count: 0,
          is_manual: 1,
          not_synced: true
        });
      }
    }

    const posts = [];

    for (const post of byId.values()) {
      const campaigns = queryAll(
        `SELECT id, name, status, is_active, keywords, updated_at, last_activity_at
           FROM campaigns WHERE post_id = ? ORDER BY id DESC`,
        [post.post_id]
      );

      posts.push({
        ...post,
        campaigns,
        campaignCount: campaigns.length,
        stats: StatsService.getPostStats(post.post_id, range)
      });
    }

    // Newest first; posts with no publish date fall to the end.
    posts.sort((a, b) => {
      const da = a.published_at ? Date.parse(a.published_at) : 0;
      const db = b.published_at ? Date.parse(b.published_at) : 0;
      return db - da;
    });

    return posts;
  }

  static getOne(postId) {
    return queryOne('SELECT * FROM instagram_posts WHERE post_id = ?', [postId]);
  }

  static remove(postId) {
    const inUse = queryOne('SELECT COUNT(*) as count FROM campaigns WHERE post_id = ?', [postId]);
    if (inUse && inUse.count > 0) {
      return {
        success: false,
        error: `This post still has ${inUse.count} campaign(s). Delete or move them first.`
      };
    }
    execute('DELETE FROM instagram_posts WHERE post_id = ?', [postId]);
    return { success: true };
  }
}

module.exports = PostsService;
