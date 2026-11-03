# Troubleshooting: "the comment reply never came and the DM never arrived"

Reported 2026-11-01, about commenters on private accounts. Four separate causes were
found. Three were bugs in this codebase and are fixed. The fourth is a Meta setting
only you can change.

## First, the thing that is NOT the problem

**A private Instagram account is not blocked from getting an automated reply.**
Meta's rules do not treat private and public commenters differently:

- A public reply to their comment is always allowed. Their privacy setting has no
  bearing on it.
- A private reply (the first DM) is allowed to anyone who commented in the last
  7 days, once per comment.

So "their account is private" is not the reason, and nothing here tries to work
around anyone's privacy settings.

## What actually happens to that first DM

Meta delivers the first automated DM into the person's **Message Requests** folder.
It is sent and it is delivered — but until they tap **Accept** and write back,
Meta opens no messaging window, so the follow-up report cannot be sent. That is
exactly right, and it is now shown on the dashboard as **"Waiting to be accepted"**
instead of looking like a failure.

The moment they reply, the 24-hour window opens, `dm_state` becomes `accepted`,
and the report goes out automatically. No change needed on your side.

## The three bugs that were fixed

### 1. A DM failure silently killed the public reply

`processComment` evaluated the private-reply policy *before* posting the public
reply and returned early when it failed. A commenter who could not be DMed
therefore got no public reply either — even though public replies have neither
the one-per-comment limit nor the 7-day limit.

The two are now attempted independently, public reply first.

### 2. One failure meant that comment could never be retried

Deduplication treated any row in `processed_comments` as "finished". A DM that
failed on a temporary Meta error was recorded, and the retry was then rejected as
a duplicate. One blip and that commenter was unreachable forever.

A comment is now only "finished" once both sides settle. A failure that is worth
retrying is reprocessed, up to `MAX_COMMENT_ATTEMPTS` (default 3). A refusal is
never retried — see below.

### 3. Meta's rate limits were filed as permanent failures

The queue only retried on HTTP 429 or 5xx. Meta answers HTTP **400** for its own
rate limits (`#4`, `#17`, `#32`, `#613`) and temporary outages (`#1`, `#2`), so
none of them were ever retried.

`src/services/metaErrors.js` now reads `error.code` / `error_subcode` and sorts
each failure into one category:

| Category | Retried? | Means |
|---|---|---|
| `RATE_LIMITED` | yes | Meta asked us to slow down |
| `TRANSIENT` | yes | Short-lived Meta error |
| `USER_UNAVAILABLE` | **no** | They have message requests off, or blocked/restricted the account |
| `TARGET_NOT_FOUND` | no | App in Development Mode, comment deleted, or past 7 days |
| `CONFIG` | no | Token or permission problem |
| `WINDOW_CLOSED` | no | Past the 24-hour window |

`USER_UNAVAILABLE` is deliberately never retried. If someone has switched message
requests off, that is their decision, and repeatedly trying to message them would
be both a Meta policy violation and plain bad behaviour.

## The fourth cause — check this one yourself

If the dashboard shows failures under **"App not live, or comment gone"**
(`TARGET_NOT_FOUND`, Meta error `#100` "The requested user cannot be found"),
the most likely reason is that **your Meta app is still in Development Mode**.

In Development Mode Meta only delivers messages to people who hold a role on the
app — admin, developer or tester. Every ordinary commenter fails this way,
private account or not. It looks exactly like the bug you reported.

To check and fix:

1. Open <https://developers.facebook.com/apps> and select your app.
2. Look at the App Mode toggle at the top of the dashboard.
3. If it says **Development**, switch it to **Live**.
4. Going Live needs Advanced Access for `instagram_manage_messages` and
   `instagram_manage_comments`, which requires App Review. Until that is
   approved, add yourself and any testers under **App roles → Roles** so you can
   test the full flow end to end.

Nothing in this codebase can bypass that, and it should not try to.

## Why the dashboard showed "0 comments but 3 delivered"

Two separate reporting bugs, both fixed.

### Statistics leaked between Reels

`StatsService.getPostStats` scoped outbound messages with
`campaign_id IN (SELECT id FROM campaigns WHERE post_id = ?)` — the campaign's
**current** target. Re-point a campaign at a different Reel and every message it
had ever sent moved onto the new Reel's card. That is how a card showed
3 delivered against 0 comments: those three were sent weeks earlier, for the
seed post `post_jio_ipo_001`, by the same campaign before it was re-pointed.

Messages are now tied to the Reel they were actually sent for, through
`processed_comments.post_id`. Follow-ups and reports carry no `comment_id`, so
they are linked through the person who commented on that Reel, for that campaign.

### The comment count only counted what we handled

The card's "Comments" figure came from `processed_comments`, which holds only
comments the automation actually received. A Reel with real comments that never
arrived by webhook therefore read `0` — indistinguishable from a Reel nobody
commented on.

The card now shows Instagram's own `comments_count` from the last media sync,
with the shortfall called out underneath as **"N not handled"**, plus a banner
pointing at the backfill.

### "N comments never reached the automation" was itself wrong at first

The badge originally compared `instagram_posts.comments_count` against handled
comments. Instagram's count includes **replies to comments** and **your own
account's comments**; `GET /{media-id}/comments` returns only top-level comments
by other people. On 2026-11-01 that made a card claim one missing comment which
was in fact the creator's own reply to someone else.

The badge is now based on `eligible_comment_count` — what the API actually
exposes, minus our own account — recorded when a comment sync runs. Before a
sync has ever run, no shortfall is claimed, because none is known.

A sync also skips comments from the connected account itself. Replying to our
own comment would waste the single private reply Meta allows per comment.

## Recovering comments a webhook never delivered

**Posts & Reels → "Check for missed comments"**.

It reads the comments Instagram already holds and runs anything unseen through
the normal automation path — same policy gates, same pause switches, same
one-reply-per-comment rule. It previews first and lists exactly who would be
messaged before anything is sent.

From the command line:

```bash
# preview only, sends nothing
curl -s -X POST http://localhost:3000/api/posts/sync-comments \
  -H 'Content-Type: application/json' -d '{"dryRun":true}' | python3 -m json.tool

# live run — sends real replies
curl -s -X POST http://localhost:3000/api/posts/sync-comments \
  -H 'Content-Type: application/json' -d '{"dryRun":false}' | python3 -m json.tool
```

Comments older than 7 days are counted but never sent to: Meta refuses a private
reply past that window.

## Replies now work without webhooks at all

A webhook is delivered **once**. If the public callback URL is unreachable at
that moment, Meta drops it and the comment is gone — nothing retries, nothing
appears in the dashboard, and the person waits for a reply that never comes.
Between 2026-10-31 and 2026-11-01 not one real Instagram webhook was ever
received, and every "the reply didn't send" report traced back to that.

The system no longer depends on it. `src/services/pollingService.js` asks
Instagram directly, every 60 seconds, what comments exist on the Reels that
active campaigns target, and runs anything new through the normal automation
path. Webhooks still work and are still faster when they are set up; whichever
sees a comment first handles it, and per-comment deduplication means nobody is
answered twice.

| Setting | Default | Where |
|---|---|---|
| `comment_polling_enabled` | `true` | Settings page, or `POST /api/dashboard/polling` |
| `comment_poll_interval_s` | `60` (floor 30) | same |

The poller obeys every existing safeguard: emergency stop, global pause,
campaign status, the 7-day window, and the one-reply-per-comment rule. It skips
comments from the connected account itself. A failed cycle never kills the
timer, and only cycles that actually found something are written to the
activity log.

Run one immediately instead of waiting for the timer:

```bash
curl -s -X POST http://localhost:3000/api/dashboard/polling/run | python3 -m json.tool
```

Turn it off:

```bash
curl -s -X POST http://localhost:3000/api/dashboard/polling \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

Webhooks are still worth setting up — they reply in seconds rather than up to a
minute — but they are now an optimisation, not a requirement.

## The webhook delivery path — check this first

A comment that never arrives produces exactly the symptoms above. Both of these
must be true, and on 2026-11-01 neither was:

1. **The public URL must be live.** `APP_BASE_URL` in `.env` points at the ngrok
   domain. If the tunnel is not running, Meta's POST gets a 404 and the comment
   is gone permanently.

   ```bash
   ngrok http 3000 --domain=<your-reserved-domain>.ngrok-free.dev
   ```

2. **The app must be subscribed to the account's webhooks.** Check with:

   ```bash
   curl -s "https://graph.facebook.com/v21.0/$INSTAGRAM_ACCOUNT_ID/subscribed_apps?access_token=$META_ACCESS_TOKEN"
   ```

   `{"data":[]}` means nothing is subscribed and no comment webhook will ever be
   sent. Subscribe with:

   ```bash
   curl -s -X POST "https://graph.facebook.com/v21.0/$INSTAGRAM_ACCOUNT_ID/subscribed_apps?subscribed_fields=comments,messages&access_token=$META_ACCESS_TOKEN"
   ```

   Then confirm the GET returns the app with `comments` and `messages` listed.

Also confirm, in the Meta app dashboard under **Webhooks**, that the Instagram
object is subscribed to the `comments` and `messages` fields and that the
callback URL matches `APP_BASE_URL`.

## Where to look when something fails

- **Dashboard → Overview → "Message request status"** — the four counts, plus a
  plain-English table of why messages did not send.
- **Activity log** — every attempt carries `category`, `blame` (meta / creator /
  commenter) and `willRetry`.
- `processed_comments.error_category` and `attempts` — per comment.

## Tests

`tests/delivery.test.js` pins all of the above:

```
npm test
```

Test 1 is the exact reported symptom: a DM that fails must still leave the public
reply sent.

---

## Quick error reference

| Error | Cause | Fix |
|---|---|---|
| `(#10) Message failed to send` | "Allow access to messages" is OFF in the Instagram app | Instagram → Settings and privacy → Messages and story replies → Message controls → Connected tools → **Allow access to messages** ON |
| `(#10) sent outside of allowed window` (window *was* open) | The app is not subscribed to the account's `messages` webhook | `SETUP.md` → Blocker 2 |
| `(#100) The requested user cannot be found` | App is in Development Mode; the commenter holds no role on it | `SETUP.md` → Blocker 1 |
| `(#100) Unsupported request` on a 2nd reply | Meta allows exactly 1 private reply per comment | Expected. The system deduplicates on `comment_id`. |
| `(#200) Requires pages_manage_metadata` | That scope is not on the token | Re-run the login flow and grant it |
| `(#230) User consent is required` | Follower check needs Advanced Access | `SETUP.md` → Blocker 3 |
| `Comment is older than 7 days` | Past Meta's private-reply window | Expected. Nothing to fix. |
| `403 Invalid signature` | Webhook HMAC mismatch | `META_APP_SECRET` in `.env` must match the Meta App Secret exactly |
| `24_HOUR_WINDOW_EXPIRED` | The person has not messaged in 24h | Expected. Meta prohibits unsolicited DMs outside the window. |
| `{"data":[]}` from `subscribed_apps` | Nothing is subscribed; no webhook will ever arrive | `SETUP.md` → Blocker 2 |
