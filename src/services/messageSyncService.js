/**
 * Invest With Clarity - Inbound DM Backfill
 *
 * Comments can be polled from the media edge; inbound DMs could not, so a reply
 * like "DONE" only ever reached the automation through a webhook. With webhooks
 * unavailable the conversation simply stopped after the first message: the
 * person answered, nothing happened, and the report was never sent.
 *
 * This reads the conversation edge directly and feeds genuinely new inbound
 * messages through the same handler a webhook would.
 *
 * The dangerous part of reading history is replying to it. A first run against
 * an account with months of DMs must not answer all of them, so the first pass
 * records what exists WITHOUT processing it, and only messages that arrive
 * after that baseline are acted on.
 */

const { queryOne, queryAll, execute, getSetting, setSetting } = require('../database/db');
const metaApiClient = require('./metaApiClient');
const AutomationEngine = require('./automationEngine');
const LoggerService = require('./loggerService');
const config = require('../config');

const BASELINE_KEY = 'dm_baseline_taken';

function ownIds() {
  return new Set([
    String(config.meta.instagramAccountId || ''),
    String(config.meta.facebookPageId || '')
  ].filter(Boolean));
}

function seen(messageId) {
  return Boolean(queryOne('SELECT message_id FROM processed_messages WHERE message_id = ?', [messageId]));
}

function markSeen(messageId, { userId = null, conversationId = null, processed = 0, text = null }) {
  execute(
    `INSERT INTO processed_messages (message_id, conversation_id, user_id, message_text, processed, seen_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(message_id) DO UPDATE SET processed = excluded.processed`,
    [messageId, conversationId, userId, text, processed]
  );
}

async function fetchConversations(limit = 25) {
  // The Page ID is the id Meta accepted for this token's messaging calls; the
  // Instagram ID is kept as a fallback for accounts set up the other way.
  const bases = [config.meta.facebookPageId, config.meta.instagramAccountId].filter(Boolean);
  let lastErr = null;

  for (const base of bases) {
    try {
      return await metaApiClient._request(`${base}/conversations`, {
        method: 'GET',
        params: {
          platform: 'instagram',
          fields: 'id,updated_time,participants,messages.limit(20){id,created_time,from,message}',
          limit
        }
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * One pass over recent conversations.
 * On the very first run nothing is answered; the history is only recorded.
 */
async function syncMessages({ limit = 25 } = {}) {
  const result = { conversations: 0, newMessages: 0, processed: 0, baseline: false, skippedOwn: 0 };

  const baselineTaken = getSetting(BASELINE_KEY, 'false') === 'true';
  result.baseline = !baselineTaken;

  let page;
  try {
    page = await fetchConversations(limit);
  } catch (err) {
    LoggerService.log({
      action: 'DM_SYNC_FAILED',
      status: 'FAILURE',
      details: { error: err.message, meta: err.metaError || null }
    });
    throw err;
  }

  const mine = ownIds();
  const conversations = page?.data || [];
  result.conversations = conversations.length;

  for (const conv of conversations) {
    const messages = conv.messages?.data || [];

    // Meta returns newest first; process oldest first so a conversation is
    // replayed in the order it actually happened.
    for (const msg of [...messages].reverse()) {
      if (!msg.id || seen(msg.id)) continue;

      const fromId = String(msg.from?.id || '');
      const isOurs = mine.has(fromId);
      result.newMessages += 1;

      if (isOurs) {
        result.skippedOwn += 1;
        markSeen(msg.id, { conversationId: conv.id, userId: fromId, processed: 0, text: msg.message || '' });
        continue;
      }

      // First run: record, do not answer.
      if (!baselineTaken) {
        markSeen(msg.id, { conversationId: conv.id, userId: fromId, processed: 0, text: msg.message || '' });
        continue;
      }

      // An empty message is a share, sticker or reaction with no text for the
      // keyword logic to read. Recorded so it is not revisited.
      if (!msg.message || !msg.message.trim()) {
        markSeen(msg.id, { conversationId: conv.id, userId: fromId, processed: 0, text: '' });
        continue;
      }

      markSeen(msg.id, { conversationId: conv.id, userId: fromId, processed: 1, text: msg.message });
      result.processed += 1;

      await AutomationEngine.processInboundMessage({
        sender: { id: fromId },
        message: { text: msg.message, mid: msg.id },
        timestamp: msg.created_time ? new Date(msg.created_time).getTime() : Date.now()
      });
    }
  }

  if (!baselineTaken) {
    setSetting(BASELINE_KEY, 'true');
    LoggerService.log({
      action: 'DM_BASELINE_TAKEN',
      status: 'SUCCESS',
      details: {
        recorded: result.newMessages,
        note:
          'Existing DM history recorded without replying to it. Only messages that ' +
          'arrive from now on are answered.'
      }
    });
  } else if (result.processed > 0) {
    LoggerService.log({
      action: 'DM_SYNC_FOUND',
      status: 'SUCCESS',
      details: { processed: result.processed, conversations: result.conversations }
    });
  }

  return result;
}

module.exports = { syncMessages };
