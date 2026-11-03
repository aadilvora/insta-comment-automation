# Setup — Meta app, permissions and webhooks

Everything about getting this app talking to Instagram. Merged from the old
`SETUP_GUIDE.md` and `META-SETUP.md` on 2026-11-03.

This is the **Meta Developer** dashboard at <https://developers.facebook.com>, not Meta Business
Suite. Business Suite manages the Page and the Instagram account; the Developer dashboard manages
the *app* allowed to act on them.

- **Part 1** — where this app stands today, and what is blocking it
- **Part 2** — setting one up from scratch
- **Part 3** — going live

---

# Part 1 — Diagnosing a live app

These are the three things that go wrong in practice, in the order you will hit them.
Check your own app's ID, token and account ID in the Meta dashboard and in your `.env`.

### The permissions you need granted

```
instagram_basic              OK
instagram_manage_comments    OK      <- public comment replies
instagram_manage_messages    OK      <- DMs
instagram_content_publish    OK
pages_show_list              OK
pages_read_engagement        OK
```

**Nothing is missing here.** Worth saying plainly, because the natural assumption when DMs fail is
that a permission was never granted. It was.

## Blocker 1 — the app is in Development Mode

A permission in Development Mode is granted at *Standard Access*, which only works for people who
hold a role on the app. This app has exactly one such person. Every other commenter gets:

```
Invalid parameter / (#100) The requested user cannot be found
```

Public comment replies are unaffected and already work — which is why replies appear on Reels but
no DM arrives. **That split is the signature of this exact problem.**

**Confirm it:** <https://developers.facebook.com/apps> → *Invest With Clarity Automation* → the
**App Mode** toggle in the top bar reads `Development` or `Live`.

### Fix A — make DMs work today (testing, ~2 minutes, no review)

Works only for accounts you explicitly add, but proves the whole flow end to end.

1. Sidebar: **App roles → Roles**
2. **Instagram Testers** section → **Add People**
3. Enter the Instagram username of the tester
4. That account must **accept the invite**: Instagram app → **Settings and privacy** →
   **Apps and websites** → **Tester invites** → Accept
5. Comment on a Reel from that account again.

The poller picks the comment up within 60 seconds. Nothing in this project needs changing.

> Each tester accepts individually. An invite sent but not accepted does not count, and the DM
> keeps failing exactly as before.

### Fix B — make DMs work for everyone

That is Part 3 (going Live). Use Fix A in the meantime.

## Blocker 2 — the follow-up DM cannot send

Comment replies and the first DM work. The follow-up after the person replies does not.
Every attempt returns:

```
(#10) This message is sent outside of allowed window | #10/2534022
```

The window was open every time — the reply had arrived seconds earlier. Each of these was tried
and ruled out:

| Tried | Result |
|---|---|
| Instagram account ID as the endpoint | same error |
| Facebook Page ID as the endpoint | same error |
| `messaging_type: RESPONSE` | same error |
| `HUMAN_AGENT` tag | *"must be reviewed and approved by Facebook"* |

**The cause is the subscription:**

```
GET /<INSTAGRAM_ACCOUNT_ID>/subscribed_apps  ->  {"data":[]}
GET /<FACEBOOK_PAGE_ID>/subscribed_apps      ->  (#200) Requires pages_manage_metadata
```

This app is **not subscribed to the account's `messages` webhook**. The 24-hour messaging window
is tracked per app through that subscription. Without it Meta never registers that the person
messaged *this app*, so there is no window to send inside — no matter how recently they wrote.

Reading conversations still works, because that is `instagram_manage_messages`, a different
permission. Being able to read a conversation is not the same as permission to send into it.

| Part of the flow | Needs the webhook subscription? |
|---|---|
| Comment → public reply | No |
| Comment → first DM (private reply) | No |
| Person replies → follow-up / report | **Yes** |

> An earlier note called webhooks "optional now" because comment polling removed the need for them.
> True for **comments**, false for **the DM follow-up**.

### Fixing it

1. **Grant `pages_manage_metadata`.** It is not on the current token, which is why even reading
   the Page's subscriptions fails. Re-run the Facebook login flow and accept that scope.

2. **Make sure the public URL is live** (see Part 2 §6) — Meta verifies the callback at the moment
   the subscription is created.

3. **Subscribe the app:**
   ```bash
   curl -s -X POST "https://graph.facebook.com/v21.0/$INSTAGRAM_ACCOUNT_ID/subscribed_apps?subscribed_fields=comments,messages&access_token=$META_ACCESS_TOKEN"
   ```

4. **Confirm it took:**
   ```bash
   curl -s "https://graph.facebook.com/v21.0/$INSTAGRAM_ACCOUNT_ID/subscribed_apps?access_token=$META_ACCESS_TOKEN"
   ```
   `{"data":[]}` means nothing is subscribed and no webhook will ever be sent.

If Advanced Access is granted (Part 3), `HUMAN_AGENT` becomes available as a second route, but the
subscription is the correct fix.

## Blocker 3 — the follower check needs Advanced Access

Asking Meta whether a commenter follows you uses:

```
GET /{IGSID}?fields=name,username,is_user_follow_business
```

An app without Advanced Access gets `(#230) User consent is required to access user profile`.
An app without **Advanced Access** gets that for every user. **No code can work around it.**

### What the system does in the meantime

It never pretends to know. The three answers are kept distinct:

| Meta says | `is_following` | Behaviour |
|---|---|---|
| `true` | `1` | Report sent |
| `false` | `0` | Follow request sent; a later reply re-checks |
| won't say (#230) | `NULL` | Follow request sent; a reply after it is accepted as the person's own word |

That last row is self-declaration — Meta's own documented fallback when the field is unavailable.
The thread records that it was never actually verified, so the dashboard never claims a follow it
could not confirm.

> Treating "won't say" as "yes" would make the follow gate do nothing at all, so it does not.

Once Advanced Access is approved, `is_user_follow_business` starts returning real values and the
gate becomes a true check **with no code change** — the three-way logic is already in place.

---

# Part 2 — Setting up from scratch

## 1. Prerequisites

1. **Professional account** — Instagram **Creator** or **Business**.
2. **Linked Facebook Page** — linked, or claimed in Meta Business Suite.
3. **Allow access to messages (critical).** Instagram app → **Settings and privacy** →
   **Messages and story replies** → **Message controls** → under **Connected tools**, toggle
   **"Allow access to messages"** ON. If this is off, Meta rejects every automated private reply,
   even with a Live app and full permissions.

## 2. Create the Meta Developer app

1. <https://developers.facebook.com> → **My Apps** → **Create App**
2. App type: **Business**
3. Name it (e.g. `Invest With Clarity Automation`), add a contact email, **Create App**

## 3. Add the products

1. **Instagram Graph API** → Set Up
2. **Messenger** → Set Up
3. **Messenger → Settings → Instagram settings → Add or Remove Pages**, connect the Facebook Page
   linked to the Instagram account.

## 4. Permissions

| Permission | For |
|---|---|
| `instagram_basic` | Read profile info |
| `instagram_manage_comments` | Read comments, post public replies |
| `instagram_manage_messages` | Private replies and DMs |
| `pages_manage_metadata` | Subscribe the webhook to the page **(required — see Blocker 2)** |
| `pages_read_engagement` | Read post and comment engagement |
| `pages_show_list` | Enumerate managed pages |

## 5. Access token

**For testing** — [Graph API Explorer](https://developers.facebook.com/tools/explorer/): select the
app, choose **Page Access Token**, add the permissions above, **Generate Access Token**. Then open
the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/), paste it,
**Debug** → **Extend Access Token** for a 60-day token.

**For permanent use (recommended)** — [Business Manager → System Users](https://business.facebook.com/settings/system-users):
create a System User → **Add Assets** → assign the Page with full control → **Generate New Token**,
select the app, check the permissions, expiration **Never**.

## 6. Public URL for webhooks

Meta requires an HTTPS callback reachable from the internet.

```bash
# Cloudflare Tunnel — free, no account
cloudflared tunnel --url http://localhost:3000

# or ngrok (reserve a domain, or the URL changes every restart)
ngrok http 3000 --domain=your-reserved-domain.ngrok-free.dev
```

A free ngrok URL changes on every restart unless the domain is reserved — and both `APP_BASE_URL`
in `.env` **and** the Meta callback must be updated when it does. For anything permanent, host the
app somewhere with a fixed URL.

## 7. Register the webhook

1. Sidebar: **Webhooks** → from the dropdown pick **Instagram** (not Page, not User)
2. **Subscribe to this object**
3. **Callback URL**: `https://<your-domain>/webhook`
4. **Verify Token**: the value of `META_WEBHOOK_VERIFY_TOKEN` in `.env`
5. **Verify and Save** — the local server logs `[WEBHOOK_VERIFY_CHALLENGE] [SUCCESS]`
6. Subscribe to the fields `comments`, `messages` (and `mentions` if wanted)
7. Then link the app to the account with the two `curl` commands in **Blocker 2 → Fixing it**.

## 8. Configure `.env`

```bash
cp .env.example .env
```

```env
PORT=3000
NODE_ENV=development
APP_BASE_URL=http://localhost:3000

META_APP_ID=your_actual_meta_app_id
META_APP_SECRET=your_actual_meta_app_secret
META_API_VERSION=v21.0
META_WEBHOOK_VERIFY_TOKEN=your_webhook_verify_secret

INSTAGRAM_ACCOUNT_ID=your_instagram_business_account_id
FACEBOOK_PAGE_ID=your_connected_page_id
META_ACCESS_TOKEN=your_long_lived_or_system_user_token

API_REQUEST_DELAY_MS=1500
MAX_RETRIES=3
EMERGENCY_STOP=false
```

`.env` is git-ignored. Never commit it.

## 9. Run it

```bash
npm install
npm test        # policy + webhook signature suites, no Meta keys needed
npm start       # or: npm run dev  (auto-reload)
```

Dashboard: **<http://localhost:3000>**

---

# Part 3 — Going Live

In Development Mode the automation works for your own account and anyone added as a Tester,
Developer or Admin. To reach the general public:

1. Sidebar: **App review → Permissions and features**
2. Request **Advanced Access** for `instagram_manage_messages` and `instagram_manage_comments`
3. Meta asks for:
   - a **screencast** (1–2 min) of the full flow: someone comments a keyword → a public reply
     appears → a DM arrives
   - a written description of why the app needs each permission
   - reachable **Privacy Policy** and **Terms of Service** URLs
   - **Business verification** of the business behind the app
4. Once approved, switch **App Mode** to **Live**.

Expect a few days. Use Fix A (Instagram Testers) in the meantime.

> Be accurate in the submission. Describing the app as sending reports people asked for is both
> true and what Meta approves. Anything implying bulk or unsolicited messaging gets rejected.

### Also checked during review

- The Instagram account is a **Business** or **Creator** account
- It is **linked to a Facebook Page**
- **Allow access to messages** is ON in the Instagram app (Part 2 §1)

---

## How to tell it worked

Comment a keyword on a Reel from a non-admin account. Within 60 seconds the dashboard should show,
on that Reel's card: **Comments** up, **Matched** up, **Delivered** up, and
Overview → *Message request status* → **"Waiting to be accepted"** up.

That last one is normal, not an error: the first DM lands in the person's **Message Requests**.
Once they tap Accept and reply, the follow-up report sends automatically.

If it still fails, Overview → *"Why messages did not send"* names the exact reason and whose side
it is on. See `TROUBLESHOOTING.md`.
