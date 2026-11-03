/**
 * Instagram Posts & Reels — one card per Reel, each with its own stats and its
 * own controls. Numbers on a card only ever come from that Reel.
 */

import { api } from '../api.js';
import {
  esc, num, truncate, fmtDate, statusPill, emptyState, loading,
  toastOk, toastErr, toastWarn, openModal, closeModal, confirmDialog
} from '../ui.js';
import { state, setTopbar, setTopbarActions, refresh, go } from '../app.js';
import { rangeBar, bindRangeBar } from './overview.js';
import { controlButtons, bindControls } from './campaignActions.js';

function thumb(post) {
  if (post.thumbnail_url) {
    return `<img class="post-thumb" src="${esc(post.thumbnail_url)}" alt=""
                 loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'post-thumb-fallback'}))">`;
  }
  return `
    <div class="post-thumb-fallback" title="No thumbnail — sync with Instagram to fetch it">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/>
      </svg>
    </div>`;
}

function postCard(post) {
  const s = post.stats;
  const title = post.caption ? truncate(post.caption, 110) : 'Untitled post';
  const issues = s.failedMessages + s.blockedByPolicy;

  const statuses = [...new Set(post.campaigns.map(c => c.status))];
  const headline = statuses.includes('ACTIVE') ? 'ACTIVE'
    : statuses.includes('PAUSED') ? 'PAUSED'
    : statuses.includes('ERROR') ? 'ERROR'
    : statuses[0] || null;

  return `
    <article class="post-card">
      <div class="post-media">
        ${thumb(post)}
        <div class="post-meta">
          <div class="post-caption">${esc(title)}</div>
          <div class="post-sub">
            ${headline ? statusPill(headline) : '<span class="pill pill-muted">No campaign</span>'}
            ${post.media_product_type ? `<span class="pill pill-muted">${esc(post.media_product_type)}</span>` : ''}
          </div>
          <div class="post-sub mt-1">
            <span>${post.published_at ? esc(fmtDate(post.published_at)) : 'Date unknown'}</span>
            ${post.permalink ? `· <a href="${esc(post.permalink)}" target="_blank" rel="noopener">Open on Instagram</a>` : ''}
          </div>
        </div>
      </div>

      <div class="post-stats">
        <div class="post-stat">
          <div class="post-stat-value">${num(s.commentsOnInstagram ?? s.commentsReceived)}</div>
          <div class="post-stat-label">Comments</div>
          ${s.unprocessedComments
            ? `<div class="xs warn-text" title="Comments the API exposes that the automation never processed. Checked ${esc(fmtDate(s.lastCommentSyncAt))}.">${num(s.unprocessedComments)} not handled</div>`
            : s.lastCommentSyncAt
              ? `<div class="xs muted" title="Instagram's total also counts replies and your own comments.">all handled</div>`
              : ''}
        </div>
        <div class="post-stat">
          <div class="post-stat-value">${num(s.keywordMatches)}</div>
          <div class="post-stat-label">Matched</div>
        </div>
        <div class="post-stat">
          <div class="post-stat-value ${s.successfulMessages ? 'ok-text' : ''}">${num(s.successfulMessages)}</div>
          <div class="post-stat-label">Delivered</div>
          ${issues ? `<div class="xs danger-text">${num(issues)} issue${issues === 1 ? '' : 's'}</div>` : ''}
        </div>
      </div>

      <div class="post-campaigns">
        ${s.unprocessedComments && post.campaigns.some(c => c.status === 'ACTIVE')
          ? `<div class="banner banner-warn mb-2">
               <div class="banner-text">
                 <strong>${num(s.unprocessedComments)} comment(s) never reached the automation.</strong>
                 Instagram delivers each webhook once, so anything that arrived while the public
                 URL was unreachable is only recovered by fetching it back.
                 Use <em>Check for missed comments</em> above.
               </div>
             </div>`
          : ''}
        ${s.commentsOnInstagram > (s.eligibleOnInstagram ?? s.commentsOnInstagram)
          ? `<p class="xs muted">Instagram counts ${num(s.commentsOnInstagram)}; ${num(s.commentsOnInstagram - s.eligibleOnInstagram)} of those are replies or your own comments, which the automation never answers.</p>`
          : ''}
        ${post.campaigns.length === 0
          ? `<p class="small muted">No campaign on this post yet.</p>`
          : post.campaigns.map(c => `
              <div class="post-campaign-row">
                <a class="post-campaign-name" href="#/campaigns/${c.id}">${esc(c.name)}</a>
                ${statusPill(c.status)}
              </div>`).join('')}

        <div class="divider"></div>
        <dl class="kv">
          <dt>Public replies</dt><dd class="tabnum">${num(s.publicReplies)}</dd>
          <dt>Private messages</dt><dd class="tabnum">${num(s.privateReplies)}</dd>
          <dt>Rejected by Meta</dt><dd class="tabnum">${num(s.failedMessages)}</dd>
          <dt>Not eligible</dt><dd class="tabnum">${num(s.blockedByPolicy)}</dd>
          <dt>Post ID</dt><dd class="mono xs">${esc(post.post_id)}</dd>
        </dl>
      </div>

      <div class="post-actions">
        ${post.campaigns.length === 0
          ? `<button class="btn btn-sm btn-primary" data-new-for="${esc(post.post_id)}">Create campaign</button>`
          : controlButtons(post.campaigns[0], { showEdit: true, showMore: true })}
        ${post.campaigns.length === 0
          ? `<button class="btn btn-sm" data-remove-post="${esc(post.post_id)}">Remove</button>`
          : ''}
      </div>
    </article>`;
}

function addPostModal() {
  openModal({
    title: 'Add a post by hand',
    subtitle: 'Use this when Instagram isn\'t connected yet, or for a post that didn\'t come through the sync.',
    body: `
      <div class="field">
        <label class="lbl" for="m-post-id">Instagram post ID *</label>
        <input type="text" id="m-post-id" placeholder="e.g. 17912345678901234">
        <div class="hint">The media ID from the Graph API. Any text works for testing.</div>
      </div>
      <div class="field">
        <label class="lbl" for="m-caption">Caption or title</label>
        <input type="text" id="m-caption" placeholder="Jio IPO breakdown">
      </div>
      <div class="field-row">
        <div class="field">
          <label class="lbl" for="m-permalink">Instagram link</label>
          <input type="url" id="m-permalink" placeholder="https://instagram.com/reel/…">
        </div>
        <div class="field">
          <label class="lbl" for="m-thumb">Thumbnail URL</label>
          <input type="url" id="m-thumb" placeholder="https://…">
        </div>
      </div>`,
    footer: `
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Add post</button>`,
    onMount: (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelector('[data-save]').onclick = async () => {
        const post_id = modal.querySelector('#m-post-id').value.trim();
        if (!post_id) {
          toastErr('A post ID is required.');
          return;
        }
        try {
          await api.addPost({
            post_id,
            caption: modal.querySelector('#m-caption').value.trim() || null,
            permalink: modal.querySelector('#m-permalink').value.trim() || null,
            thumbnail_url: modal.querySelector('#m-thumb').value.trim() || null
          });
          close();
          toastOk('Post added. You can build a campaign on it now.');
          refresh();
        } catch (err) {
          toastErr(err.message);
        }
      };
      modal.querySelector('#m-post-id').focus();
    }
  });
}

export async function render(container) {
  setTopbar('Instagram Posts & Reels', 'Every post with its own numbers');
  container.innerHTML = loading('Loading your posts…');

  let data;
  try {
    data = await api.posts(state.range);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  const posts = data.posts;

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Posts &amp; Reels</h1>
        <p>Each card counts only its own comments and messages. Figures cover ${esc(
          state.range === 'all' ? 'all time' : state.range === 'today' ? 'today' : `the last ${state.range.replace('d', ' days')}`
        )}.</p>
      </div>
      ${rangeBar(state.range)}
      <div class="btn-group">
        <button class="btn" id="btn-add-post">Add by hand</button>
        <button class="btn" id="btn-sync-comments" title="Fetch comments Meta never delivered by webhook">Check for missed comments</button>
        <button class="btn btn-primary" id="btn-sync">Sync from Instagram</button>
      </div>
    </div>

    ${posts.length === 0
      ? emptyState({
          title: 'No posts yet',
          message: 'Sync your Instagram account to pull in your Reels, or add a post by hand using its ID.',
          actionLabel: 'Sync from Instagram',
          actionAttr: 'id="btn-sync-empty"',
          icon: 'instagram'
        })
      : `<div class="post-grid">${posts.map(postCard).join('')}</div>`}`;

  bindRangeBar(container);
  bindControls(container);

  container.querySelector('#btn-add-post')?.addEventListener('click', addPostModal);

  container.querySelectorAll('[data-new-for]').forEach(btn => {
    btn.addEventListener('click', () => go(`/campaigns/new?post=${encodeURIComponent(btn.dataset.newFor)}`));
  });

  container.querySelectorAll('[data-remove-post]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.removePost;
      const ok = await confirmDialog({
        title: 'Remove this post?',
        message: 'It only disappears from this dashboard. Nothing on Instagram changes.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (!ok) return;
      try {
        await api.deletePost(id);
        toastOk('Post removed from the dashboard.');
        refresh();
      } catch (err) {
        toastErr(err.message);
      }
    });
  });

  const doSync = async btn => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Syncing…';
    try {
      const result = await api.syncPosts();
      toastOk(`Synced ${result.synced} post(s) from Instagram.`);
      refresh();
    } catch (err) {
      toastWarn(err.message, 'Could not sync');
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  // Webhooks are delivered once. Anything that arrived while the public URL was
  // unreachable never becomes a reply unless it is fetched back. Always preview
  // first and show exactly who would be messaged before sending anything.
  const doSyncComments = async btn => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking…';

    try {
      const preview = await api.syncComments({ dryRun: true });
      const pending = (preview.results || [])
        .flatMap(r => (r.wouldProcess || []).map(c => ({ ...c, postId: r.postId })))
        .filter(c => c.matches);

      btn.disabled = false;
      btn.textContent = original;

      if (pending.length === 0) {
        toastOk('No missed comments. Everything matching a keyword has already been handled.');
        return;
      }

      const list = pending.slice(0, 10).map(c =>
        `<li><strong>@${esc(c.username)}</strong> — “${esc(c.text)}”
         <span class="muted small">→ ${esc(c.campaign)} (${esc(c.keyword)}), ${c.ageDays}d old</span></li>`
      ).join('');

      const ok = await confirmDialog({
        title: `Send replies to ${pending.length} missed comment(s)?`,
        message:
          `<p>These comments matched a running campaign but never reached the server — ` +
          `usually because the public webhook URL was unreachable at the time.</p>` +
          `<ul class="plain-list">${list}</ul>` +
          (pending.length > 10 ? `<p class="muted small">…and ${pending.length - 10} more.</p>` : '') +
          `<p><strong>Each one gets a real public reply and a real DM.</strong> ` +
          `Paused and stopped campaigns are skipped, and nobody is replied to twice.</p>`,
        confirmLabel: `Send ${pending.length} repl${pending.length === 1 ? 'y' : 'ies'}`,
        html: true
      });
      if (!ok) return;

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Sending…';
      const result = await api.syncComments({ dryRun: false });
      toastOk(`Processed ${result.totalProcessed} missed comment(s).`);
      refresh();
    } catch (err) {
      toastWarn(err.message, 'Could not check for missed comments');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  container.querySelector('#btn-sync-comments')?.addEventListener('click', e => doSyncComments(e.currentTarget));

  container.querySelector('#btn-sync')?.addEventListener('click', e => doSync(e.currentTarget));
  container.querySelector('#btn-sync-empty')?.addEventListener('click', e => doSync(e.currentTarget));
}
