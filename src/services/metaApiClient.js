/**
 * Invest With Clarity - Meta Graph & Messenger API Client
 * 100% Official Meta Graph API v21.0 endpoints.
 * Zero unofficial APIs, zero scraping, zero simulated browser actions.
 */

const config = require('../config');
const LoggerService = require('./loggerService');
const queueService = require('./queueService');
const { getSetting, setSetting } = require('../database/db');

class MetaApiClient {
  constructor(options = {}) {
    this.accessToken = options.accessToken || config.meta.accessToken;
    this.appSecret = options.appSecret || config.meta.appSecret;
    this.instagramAccountId = options.instagramAccountId || config.meta.instagramAccountId;
    this.facebookPageId = options.facebookPageId || config.meta.facebookPageId;
    this.apiVersion = options.apiVersion || config.meta.apiVersion;
    this.baseUrl = config.meta.graphApiBaseUrl || 'https://graph.facebook.com';
    this.mockMode = options.mockMode || false;
  }

  /**
   * Internal HTTP requester using Node native fetch.
   */
  async _request(endpoint, { method = 'GET', body = null, params = {} } = {}) {
    // If mock mode is explicitly active (used during offline testing / sandbox)
    if (this.mockMode) {
      return this._mockHandler(endpoint, method, body);
    }

    if (!this.accessToken) {
      const err = new Error('META_ACCESS_TOKEN is not configured in .env');
      err.code = 'CONFIG_MISSING';
      throw err;
    }

    const url = new URL(`${this.baseUrl}/${this.apiVersion}/${endpoint}`);
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, String(val));
      }
    }

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'InvestWithClarity-Automation/1.0'
    };

    const fetchOptions = {
      method,
      headers
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      const e = data.error || {};
      // "Invalid parameter" alone is undiagnosable. Carry the code, subcode and
      // fbtrace_id on the message so the activity log and a Meta support ticket
      // both have what they need without re-running the call.
      const parts = [e.message || `Meta API HTTP ${response.status}`];
      if (e.code !== undefined) parts.push(`#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}`);
      if (e.error_user_title) parts.push(e.error_user_title);
      if (e.error_user_msg) parts.push(e.error_user_msg);
      if (e.fbtrace_id) parts.push(`trace ${e.fbtrace_id}`);

      const err = new Error(parts.join(' | '));
      err.status = response.status;
      err.metaError = e;
      err.endpoint = endpoint;
      throw err;
    }

    return data;
  }

  /**
   * Public Reply to a comment on a post/Reel.
   * Official Endpoint: POST /{comment-id}/replies
   */
  async replyToComment(commentId, message, context = {}) {
    return queueService.enqueue(
      async () => {
        return await this._request(`${commentId}/replies`, {
          method: 'POST',
          body: { message }
        });
      },
      { action: 'REPLY_TO_COMMENT', commentId, ...context }
    );
  }

  /**
   * Send an eligible Initial Private Reply to a commenter.
   * Official Endpoint: POST /{ig-account-id}/messages
   * Payload: { recipient: { comment_id: commentId }, message: { text: message } }
   * Strictly limited to 1 message per comment ID within 7 days.
   */
  /**
   * Meta documents private replies against two different IDs, and which one a
   * token accepts depends on how the app was set up:
   *
   *   - Instagram Platform docs:      POST /{ig-user-id}/messages
   *   - Messenger Platform docs:      POST /{page-id}/messages
   *
   * A Page access token issued through Facebook Login generally wants the Page
   * ID; an Instagram Login token wants the Instagram ID. Sending to the wrong
   * one returns a bare "Invalid parameter", which looks identical to a dozen
   * unrelated problems and sent us chasing Development Mode for an afternoon.
   *
   * Rather than make the creator guess, try the likely one and fall back to the
   * other, then remember whichever Meta accepted so later sends go straight there.
   */
  _messagingIds() {
    const ig = this.instagramAccountId;
    const page = this.facebookPageId;
    const remembered = getSetting('messaging_endpoint_id', '');

    const candidates = [];
    if (remembered && remembered !== 'ig' && remembered !== 'page') {
      candidates.push({ id: remembered, kind: 'remembered' });
    } else if (remembered === 'page' && page) {
      candidates.push({ id: page, kind: 'page' });
    } else if (remembered === 'ig' && ig) {
      candidates.push({ id: ig, kind: 'ig' });
    }

    // A Page token is the common setup here, so try the Page ID first when we
    // have no memory of what worked.
    for (const c of [{ id: page, kind: 'page' }, { id: ig, kind: 'ig' }]) {
      if (c.id && !candidates.some(x => String(x.id) === String(c.id))) candidates.push(c);
    }

    if (candidates.length === 0) candidates.push({ id: 'me', kind: 'me' });
    return candidates;
  }

  /**
   * Post a message, resolving which ID this token's messaging calls want.
   * Shared by private replies and ordinary DMs: resolving it in only one of
   * them left the other sending to an ID Meta would not accept, which surfaced
   * as "(#10) This message is sent outside of allowed window" on a conversation
   * that was very much inside its window.
   */
  async _postMessage(recipient, message, { messagingType = null, tag = null } = {}) {
    const candidates = this._messagingIds();
    let lastErr = null;

    const buildBody = (extra = {}) => {
      const body = { recipient, message: { text: message } };
      // Meta classifies every send. Replying to someone inside the 24-hour
      // window is messaging_type RESPONSE; omitting the field entirely leaves
      // Meta to assume the strictest class, which is refused as "outside of
      // allowed window" even when the window is open.
      if (messagingType) body.messaging_type = messagingType;
      if (tag) { body.tag = tag; body.messaging_type = 'MESSAGE_TAG'; }
      return { ...body, ...extra };
    };

    for (const candidate of candidates) {
      try {
        const result = await this._request(`${candidate.id}/messages`, {
          method: 'POST',
          body: buildBody()
        });

        if (getSetting('messaging_endpoint_id', '') !== candidate.kind) {
          setSetting('messaging_endpoint_id', candidate.kind);
          LoggerService.log({
            action: 'MESSAGING_ENDPOINT_RESOLVED',
            status: 'SUCCESS',
            details: {
              using: candidate.kind,
              id: candidate.id,
              note: 'Meta accepted this ID for messaging. Remembered for future sends.'
            }
          });
        }

        return result;
      } catch (err) {
        lastErr = err;

        // Codes Meta returns when the ID itself is wrong for this token.
        // #10/2534022 is included because an unresolvable recipient is reported
        // as a window error rather than as a bad parameter.
        const code = err.metaError?.code;
        const worthTryingOther = code === 100 || code === 803 || code === 10;

        if (!worthTryingOther || candidate === candidates[candidates.length - 1]) throw err;

        LoggerService.log({
          action: 'MESSAGING_ENDPOINT_FALLBACK',
          status: 'WARNING',
          details: {
            tried: `${candidate.kind} (${candidate.id})`,
            error: err.message,
            note: 'Trying the other documented ID.'
          }
        });
      }
    }

    throw lastErr;
  }

  async sendPrivateReply(commentId, message, context = {}) {
    return queueService.enqueue(
      () => this._postMessage({ comment_id: commentId }, message),
      { action: 'SEND_PRIVATE_REPLY', commentId, ...context }
    );
  }

  /**
   * Send a Direct Message to a user inside the 24-hour messaging window.
   * Official Endpoint: POST /{ig-account-id}/messages
   * Payload: { recipient: { id: userId }, message: { text: message } }
   */
  /**
   * A follow-up inside the 24-hour window. Tagged RESPONSE, because that is
   * what it is: an answer to something the person just sent us.
   *
   * If Meta still refuses with "outside of allowed window", one retry is made
   * with the HUMAN_AGENT tag, which Meta provides for exactly this case — a
   * person is waiting on an answer and the standard window does not cover it.
   * The tag only works once the app holds Advanced Access, so the retry is
   * attempted rather than assumed, and the real error is surfaced if it fails.
   */
  async sendDirectMessage(userId, message, context = {}) {
    return queueService.enqueue(
      async () => {
        try {
          return await this._postMessage({ id: userId }, message, { messagingType: 'RESPONSE' });
        } catch (err) {
          const outsideWindow =
            err.metaError?.code === 10 && err.metaError?.error_subcode === 2534022;

          if (!outsideWindow) throw err;

          // HUMAN_AGENT needs App Review. Once Meta has told us it is not
          // approved, trying it on every send is a wasted call against the
          // account's hourly quota and buries the real error in the log.
          if (getSetting('human_agent_approved', 'unknown') === 'false') throw err;

          LoggerService.log({
            userId,
            action: 'MESSAGE_WINDOW_RETRY',
            status: 'WARNING',
            details: {
              error: err.message,
              note: 'Standard window refused. Trying the HUMAN_AGENT tag once.'
            }
          });

          try {
            const tagged = await this._postMessage({ id: userId }, message, { tag: 'HUMAN_AGENT' });
            setSetting('human_agent_approved', 'true');
            return tagged;
          } catch (tagErr) {
            if (/must be reviewed and approved/i.test(tagErr.message || '')) {
              setSetting('human_agent_approved', 'false');
              LoggerService.log({
                action: 'HUMAN_AGENT_UNAVAILABLE',
                status: 'WARNING',
                details: {
                  note:
                    'HUMAN_AGENT is not approved for this app, so it will not be tried again. ' +
                    'The underlying problem is that no messaging window is open: this app is not ' +
                    'subscribed to the account\'s messages webhook, so Meta does not register that ' +
                    'the person messaged THIS app. Subscribe the app (needs pages_manage_metadata) ' +
                    'or request Advanced Access.'
                }
              });
            }
            // Surface the original window error: it is the real diagnosis.
            throw err;
          }
        }
      },
      { action: 'SEND_DIRECT_MESSAGE', userId, ...context }
    );
  }

  /**
   * Fetch User Profile & Follower Relationship (Post-DM interaction only).
   * Official Endpoint: GET /{IGSID}?fields=name,username,is_user_follow_business
   */
  async getUserProfile(userId) {
    return queueService.enqueue(
      async () => {
        try {
          return await this._request(userId, {
            method: 'GET',
            params: {
              fields: 'name,username,is_user_follow_business'
            }
          });
        } catch (err) {
          // If regional privacy restrictions apply (e.g. EU ePrivacy), return structured fallback
          LoggerService.log({
            userId,
            action: 'GET_USER_PROFILE',
            status: 'WARNING',
            details: {
              note: 'Profile relationship query not accessible or restricted for this user/region. Using compliant fallback.',
              error: err.message
            }
          });
          return {
            id: userId,
            name: null,
            username: null,
            is_user_follow_business: null,
            fallback_applied: true
          };
        }
      },
      { action: 'GET_USER_PROFILE', userId }
    );
  }

  /**
   * Fetch comments on a post or Reel for audit/sync.
   * Official Endpoint: GET /{media-id}/comments
   */
  async getMediaComments(mediaId) {
    return this._request(`${mediaId}/comments`, {
      method: 'GET',
      params: {
        fields: 'id,text,timestamp,username,from'
      }
    });
  }

  /**
   * Fetch the connected account's posts and Reels for the dashboard cards.
   * Official Endpoint: GET /{ig-user-id}/media
   */
  async getAccountMedia(accountId = null, limit = 50) {
    const id = accountId || this.instagramAccountId || 'me';
    return this._request(`${id}/media`, {
      method: 'GET',
      params: {
        fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,comments_count,like_count',
        limit
      }
    });
  }

  /**
   * Check connection and permissions against Meta Graph API.
   */
  async verifyConnection() {
    if (!this.accessToken) {
      return {
        connected: false,
        status: 'TOKEN_MISSING',
        message: 'No META_ACCESS_TOKEN provided in .env configuration.'
      };
    }

    try {
      const result = await this._request('me', {
        method: 'GET',
        params: { fields: 'id,name' }
      });
      return {
        connected: true,
        status: 'ACTIVE',
        details: result
      };
    } catch (err) {
      return {
        connected: false,
        status: 'ERROR',
        message: err.message,
        details: err.metaError || null
      };
    }
  }

  /**
   * Mock handler for local offline testing and automated test suites.
   */
  _mockHandler(endpoint, method, body) {
    if (endpoint.endsWith('/replies') && method === 'POST') {
      return { id: `mock_reply_${Date.now()}` };
    }
    if (endpoint.endsWith('/messages') && method === 'POST') {
      return {
        recipient_id: body.recipient?.id || 'mock_recipient',
        message_id: `mock_mid_${Date.now()}`
      };
    }
    if (method === 'GET' && endpoint.includes('comments')) {
      return { data: [] };
    }
    if (method === 'GET' && !endpoint.includes('/')) {
      return {
        id: endpoint,
        name: 'Mock User',
        username: 'mock_investor',
        is_user_follow_business: true
      };
    }
    return { success: true };
  }
}

const defaultClient = new MetaApiClient();
module.exports = defaultClient;
module.exports.MetaApiClient = MetaApiClient;
