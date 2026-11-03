# Instagram Comment-to-DM Automation

Someone comments a keyword on your Instagram Reel → the app replies to their comment publicly →
and sends them a DM. Self-hosted, Node.js, built entirely on the **official Meta Graph API**.

No scraping. No browser automation. No password storage. No third-party SaaS.

---

## What works today

This is the honest status. Three steps are working end to end:

| # | Step | Status |
|---|---|---|
| 1 | Someone comments a keyword on your Reel → the app detects it | ✅ **Working** |
| 2 | The app posts a public reply under that comment | ✅ **Working** |
| 3 | The app sends that person a DM (private reply) | ✅ **Working** |
| 4 | They reply to the DM → the app sends a follow-up/report | ⚠️ **Not working yet** |

**Step 4 needs one thing**: your app must be subscribed to the account's `messages` webhook.
Meta tracks the 24-hour messaging window *per app* through that subscription — without it, Meta
never registers that the person messaged **your** app, so there is no open window to reply into,
no matter how recently they wrote. You get `(#10) sent outside of allowed window` even when the
window is obviously open. Fix: [`SETUP.md` → Blocker 2](SETUP.md).

**Two limits apply to steps 1–3 as well:**

- While your Meta app is in **Development Mode**, DMs only reach people who hold a role on the
  app (add them under *App roles → Instagram Testers*). Everyone else gets
  `(#100) The requested user cannot be found`. Public replies are unaffected — which is exactly
  why you see replies appear but no DM arrives. Going Live removes this.
- Steps 1–3 work **without** webhooks: a poller reads comments directly every 60 seconds. Only
  step 4 requires the webhook.

---

## Install

**Requirements:** Node.js 22+ (uses the built-in `node:sqlite`), and an Instagram
**Business or Creator** account linked to a Facebook Page.

```bash
git clone https://github.com/<you>/insta-comment-automation.git
cd insta-comment-automation
npm install

cp .env.example .env     # then fill it in — see the table below
npm test                 # policy + webhook checks, no Meta keys needed
npm start                # dashboard at http://localhost:3000
```

`npm run dev` restarts on file changes. The SQLite database is created automatically on first run.

---

## Configuration

Every value lives in `.env`. Nothing account-specific is hardcoded.

### Required

| Variable | Where to get it |
|---|---|
| `META_APP_ID` | developers.facebook.com → your app → Settings → Basic |
| `META_APP_SECRET` | same page |
| `META_ACCESS_TOKEN` | Long-lived Page token, or a System User token that never expires |
| `INSTAGRAM_ACCOUNT_ID` | Your Instagram Business/Creator account ID (the number, not the @handle) |
| `FACEBOOK_PAGE_ID` | The Facebook Page linked to that Instagram account |
| `META_WEBHOOK_VERIFY_TOKEN` | Any random string you invent — paste the **same** value into Meta's webhook form |

Your token needs these six permissions:

```
instagram_basic              instagram_manage_comments
instagram_manage_messages    pages_show_list
pages_read_engagement        pages_manage_metadata
```

> `pages_manage_metadata` is the one people miss. Without it you cannot subscribe the webhook,
> so step 4 can never work.

### Optional

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Node environment |
| `APP_BASE_URL` | `http://localhost:3000` | Public HTTPS URL Meta can reach. Only needed for webhooks. |
| `META_API_VERSION` | `v21.0` | Graph API version |
| `BRAND_NAME` | `Instagram Automation` | Shown in the dashboard header |
| `INSTAGRAM_HANDLE` | `your_handle` | Your @handle, no `@`. Used in the seeded example wording. |
| `API_REQUEST_DELAY_MS` | `1500` | Delay between outbound calls, to stay under Meta's burst limits |
| `MAX_RETRIES` | `3` | Retries for transient/rate-limit failures. A refusal is never retried. |
| `MAX_COMMENT_ATTEMPTS` | `3` | How many times one comment may be re-attempted |
| `EMERGENCY_STOP` | `false` | `true` = kill switch, blocks every outbound message |
| `DISCLAIMER_TEXT` | *(empty)* | Appended to outbound messages. Empty appends nothing. |

**Never commit `.env`.** It is git-ignored, along with `*.db` and `node_modules/`.

Full Meta setup — creating the app, tokens, webhooks, going Live — is in **[`SETUP.md`](SETUP.md)**.

---

## Rules this enforces for you

Meta bans accounts for getting these wrong, so they are enforced in code, not left to config:

- **One private reply per comment, ever.** Enforced by a database unique constraint on `comment_id`.
- **Comments older than 7 days are never replied to privately.** Meta's hard window.
- **The 24-hour messaging window** is checked against the person's last inbound message before
  any follow-up is attempted.
- **Emergency stop** halts every outbound call and flushes the queue, instantly.
- **A paused or stopped campaign sends nothing** — the queue re-checks status in the instant
  before each API call, so even already-queued messages are dropped.
- **Nothing restarts on its own.** State lives in SQLite; restarting the app leaves a paused
  campaign paused.

Outcomes are never collapsed into one "failed" bucket:

| Outcome | Meaning |
|---|---|
| **Delivered** | Meta accepted the message |
| **Rejected by Meta** | The API refused it — the real error text is stored and shown |
| **Not eligible** | Our own policy layer blocked it before sending (expired window, comment too old, duplicate reply, campaign paused in time) |

---

## Dashboard

`http://localhost:3000` — eight sections:

| Section | For |
|---|---|
| **Overview** | Headline numbers, filtered by Today / 7d / 30d / All time |
| **Posts & Reels** | One card per post. Stats never mix between Reels. |
| **Campaigns** | Search, filter by status or Reel, sort by activity |
| **Message Templates** | Reusable wording, so messages change without touching code |
| **Analytics** | Campaign comparison, delivery outcomes, open conversations |
| **Activity Logs** | Full searchable audit trail; secrets redacted |
| **Instagram Connection** | Token and webhook status, and what Meta does and doesn't permit |
| **Settings** | Emergency stop, global pause, API delay |

Campaigns are `DRAFT` → `ACTIVE` → `PAUSED` / `STOPPED` / `ERROR`. **Only `ACTIVE` sends anything**,
and a campaign cannot go active until it has a name, a post, a keyword and an initial DM.

A fresh install seeds **one example campaign as a DRAFT** — edit the wording before starting it.

---

## Testing without Meta keys

The dashboard has a **Sandbox** that simulates inbound comments and DM replies, so you can verify
keyword matching, the single-reply rule and the follow-up logic locally.

```bash
npm test    # automation, policy, delivery and webhook-signature suites
```

---

## Project layout

```
src/
  server.js              Express app, routes, example-campaign seeding
  config.js              Reads .env; nothing account-specific is hardcoded
  database/              Schema, connection, additive migrations
  services/
    metaApiClient.js     Graph API client with retry/backoff
    webhookHandler.js    HMAC-SHA256 signature verification
    automationEngine.js  Keyword matching and campaign execution
    policyChecker.js     7-day, single-reply and 24-hour enforcement
    queueService.js      Throttled outbound queue with a send-time stop gate
    pollingService.js    Reads comments every 60s, so step 1-3 work without webhooks
    ...
  routes/                Webhooks, campaigns, posts, templates, dashboard, sandbox
public/                  Dashboard (vanilla ES modules, no build step)
tests/                   Automation, policy, delivery, webhook security
```

---

## Troubleshooting

[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) covers the failures that actually happen, with a quick
error-code reference. The three most common:

| Error | Cause |
|---|---|
| `(#100) The requested user cannot be found` | App is in Development Mode; that person has no role on it |
| `(#10) sent outside of allowed window` | App is not subscribed to the `messages` webhook |
| `(#230) User consent is required` | The follower check needs Advanced Access |

---

## Licence

ISC.
