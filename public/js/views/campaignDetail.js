/**
 * Campaign detail — the analytics page for one Reel campaign.
 * Everything here is scoped to this campaign alone.
 */

import { api } from '../api.js';
import {
  esc, num, truncate, fmtDateTime, timeAgo, statusPill, logPill, deliveryPill,
  statCard, lineChart, emptyState, loading, readDetails, toastErr, toastOk
} from '../ui.js';
import { state, setTopbar, refresh, go } from '../app.js';
import { rangeBar, bindRangeBar } from './overview.js';
import { controlButtons, bindControls, deleteCampaign } from './campaignActions.js';

let activityFilters = { action: 'ALL', status: 'ALL', search: '' };

export async function render(container, { params }) {
  const id = params[0];
  container.innerHTML = loading('Loading campaign…');

  let detail, statsData;
  try {
    [detail, statsData] = await Promise.all([
      api.campaign(id, state.range),
      api.campaignStats(id, state.range)
    ]);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>
      <a class="btn mt-2" href="#/campaigns">Back to campaigns</a>`;
    return;
  }

  const c = detail.campaign;
  const s = statsData.stats;
  const validation = detail.validation;

  setTopbar(c.name, 'Campaign analytics and activity');

  const notRunning = c.status !== 'ACTIVE';

  container.innerHTML = `
    ${c.status === 'ERROR' && c.last_error ? `
      <div class="banner banner-danger">
        <div class="banner-text"><strong>This campaign hit an error.</strong> ${esc(c.last_error)}</div>
      </div>` : ''}

    ${!validation.valid ? `
      <div class="banner banner-warn">
        <div class="banner-text">
          <strong>Not ready to run:</strong> ${esc(validation.errors.join(', '))}.
        </div>
        <a class="btn btn-sm" href="#/campaigns/${c.id}/edit">Fix it</a>
      </div>` : ''}

    ${notRunning && validation.valid ? `
      <div class="banner banner-info">
        <div class="banner-text">
          This campaign is <strong>${esc(c.status === 'DRAFT' ? 'a draft' : c.status.toLowerCase())}</strong>.
          No new replies are being sent. Its settings and history are safe.
        </div>
      </div>` : ''}

    <div class="page-head">
      <div class="page-head-text">
        <div class="row wrap mb-1">
          <a href="#/campaigns" class="small muted">&larr; All campaigns</a>
        </div>
        <h1>${esc(c.name)}</h1>
        <p class="row wrap">
          ${statusPill(c.status)}
          <span class="muted">${esc(truncate(c.post?.caption || c.post_id, 70))}</span>
        </p>
      </div>
      ${rangeBar(state.range)}
    </div>

    <div class="card mb-3">
      <div class="card-body">
        <div class="row wrap">
          <div class="btn-group">
            ${controlButtons(c, { size: '', showEdit: true, showMore: false })}
            <button class="btn" data-campaign-action="duplicate"
                    data-campaign-id="${c.id}" data-campaign-name="${esc(c.name)}">Duplicate</button>
            <button class="btn btn-danger" id="btn-delete">Delete</button>
          </div>
        </div>
      </div>
    </div>

    <div class="stat-grid">
      ${statCard({ label: 'Comments received', value: s.commentsReceived, accent: 'brand', note: 'On this post' })}
      ${statCard({ label: 'Keyword matches', value: s.keywordMatches, accent: 'info' })}
      ${statCard({ label: 'Unique commenters', value: s.uniqueCommenters })}
      ${statCard({ label: 'Public replies', value: s.publicReplies })}
      ${statCard({ label: 'Initial private replies', value: s.privateReplies })}
      ${statCard({ label: 'Follow-up messages', value: s.followUps })}
      ${statCard({ label: 'Delivered', value: s.successfulMessages, accent: 'ok' })}
      ${statCard({ label: 'Rejected by Meta', value: s.failedMessages, accent: s.failedMessages ? 'danger' : '' })}
      ${statCard({ label: 'Not eligible', value: s.blockedByPolicy, accent: s.blockedByPolicy ? 'warn' : '', note: "Meta's messaging rules" })}
      ${statCard({ label: 'Duplicates ignored', value: s.duplicatesIgnored, note: 'Already answered' })}
      ${statCard({ label: 'Policy-blocked actions', value: s.policyBlocked, accent: s.policyBlocked ? 'warn' : '' })}
    </div>

    <div class="grid-2 mb-3">
      <div class="card">
        <div class="card-head"><h2>Activity trend</h2></div>
        <div class="card-body">${lineChart(statsData.series)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Campaign setup</h2>
          <a class="btn btn-sm" href="#/campaigns/${c.id}/edit">Edit</a>
        </div>
        <div class="card-body">
          <dl class="kv">
            <dt>Trigger keywords</dt>
            <dd><div class="chips">${c.keywordList.map(k => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted">None</span>'}</div></dd>
            <dt>Match type</dt><dd>${esc(c.match_type === 'exact' ? 'Exact word' : 'Contains the word')}</dd>
            <dt>Public reply</dt><dd>${c.public_reply_enabled ? 'On' : '<span class="muted">Off</span>'}</dd>
            <dt>Follow-up</dt><dd>${c.follow_up_enabled ? 'On' : '<span class="muted">Off</span>'}</dd>
            <dt>Instagram post ID</dt><dd class="mono xs">${esc(c.post_id)}</dd>
            ${c.post?.permalink ? `<dt>Post link</dt><dd><a href="${esc(c.post.permalink)}" target="_blank" rel="noopener">Open on Instagram</a></dd>` : ''}
            <dt>Created</dt><dd>${esc(fmtDateTime(c.created_at))}</dd>
            <dt>Last edited</dt><dd>${esc(fmtDateTime(c.updated_at))}</dd>
            <dt>Last activity</dt><dd>${esc(c.last_activity_at ? fmtDateTime(c.last_activity_at) : 'None yet')}</dd>
          </dl>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Message delivery</h2></div>
      <div class="card-body">
        ${statsData.delivery.length === 0
          ? `<p class="muted small">Nothing has been sent for this campaign yet.</p>`
          : `<div class="table-wrap"><table class="data">
              <thead><tr><th>Message type</th><th>Outcome</th><th class="nowrap">Count</th></tr></thead>
              <tbody>${statsData.delivery.map(d => `
                <tr>
                  <td>${esc(d.message_type.replace(/_/g, ' '))}</td>
                  <td>${deliveryPill(d.status)}</td>
                  <td class="tabnum">${num(d.count)}</td>
                </tr>`).join('')}</tbody></table></div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Activity</h2>
        <div class="segmented" id="tab-bar">
          <button data-tab="timeline" class="active">Timeline</button>
          <button data-tab="comments">Comments</button>
          <button data-tab="messages">Messages</button>
          <button data-tab="logs">Full log</button>
        </div>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <div class="grow">
            <input type="search" id="a-search" placeholder="Search activity…" value="${esc(activityFilters.search)}">
          </div>
          <select id="a-status" style="width:auto">
            <option value="ALL">All outcomes</option>
            <option value="SUCCESS" ${activityFilters.status === 'SUCCESS' ? 'selected' : ''}>Success</option>
            <option value="FAILURE" ${activityFilters.status === 'FAILURE' ? 'selected' : ''}>Failure</option>
            <option value="WARNING" ${activityFilters.status === 'WARNING' ? 'selected' : ''}>Warning</option>
            <option value="SKIPPED" ${activityFilters.status === 'SKIPPED' ? 'selected' : ''}>Skipped</option>
          </select>
        </div>
        <div id="activity-pane">${loading('Loading activity…')}</div>
      </div>
    </div>`;

  bindRangeBar(container);
  bindControls(container);

  container.querySelector('#btn-delete').addEventListener('click', async () => {
    const removed = await deleteCampaign(c.id, c.name);
    if (removed) go('/campaigns');
  });

  /* ---------- activity pane ---------- */

  let currentTab = 'timeline';
  let activity = null;

  async function loadActivity() {
    const pane = container.querySelector('#activity-pane');
    pane.innerHTML = loading('Loading activity…');

    try {
      activity = await api.campaignActivity(c.id, {
        range: state.range,
        status: activityFilters.status,
        search: activityFilters.search,
        limit: 300
      });
      paint();
    } catch (err) {
      pane.innerHTML = `<p class="muted small">Could not load activity: ${esc(err.message)}</p>`;
    }
  }

  function paint() {
    const pane = container.querySelector('#activity-pane');
    if (!activity) return;

    if (currentTab === 'timeline') {
      pane.innerHTML = activity.logs.length === 0
        ? emptyState({ title: 'No activity yet', message: 'Every step this campaign takes will appear here in order.', icon: 'inbox' })
        : `<div class="timeline">${activity.logs.slice(0, 80).map(l => `
            <div class="tl-item ${String(l.status).toLowerCase() === 'success' ? 'ok' : String(l.status).toLowerCase()}">
              <div class="tl-time">${esc(fmtDateTime(l.timestamp))} · ${esc(timeAgo(l.timestamp))}</div>
              <div class="tl-title">${esc(l.action.replace(/_/g, ' ').toLowerCase())} ${logPill(l.status)}</div>
              <div class="tl-body">${esc(readDetails(l.details))}</div>
            </div>`).join('')}</div>`;
      return;
    }

    if (currentTab === 'comments') {
      pane.innerHTML = activity.comments.length === 0
        ? emptyState({ title: 'No matching comments yet', message: 'Comments that hit one of this campaign\'s keywords will be listed here.', icon: 'inbox' })
        : `<div class="table-wrap"><table class="data">
            <thead><tr><th>When</th><th>From</th><th>Comment</th><th>Public reply</th><th>Private reply</th></tr></thead>
            <tbody>${activity.comments.map(r => `
              <tr>
                <td class="xs muted nowrap">${esc(timeAgo(r.processed_at))}</td>
                <td class="nowrap">@${esc(r.username || 'unknown')}</td>
                <td><div class="truncate" title="${esc(r.comment_text)}">${esc(r.comment_text)}</div></td>
                <td>${deliveryPill(r.public_reply_status)}</td>
                <td>${deliveryPill(r.private_reply_status)}
                  ${r.error_reason ? `<div class="xs danger-text">${esc(r.error_reason)}</div>` : ''}</td>
              </tr>`).join('')}</tbody></table></div>`;
      return;
    }

    if (currentTab === 'messages') {
      pane.innerHTML = activity.messages.length === 0
        ? emptyState({ title: 'Nothing sent yet', message: 'Each public reply and direct message this campaign sends is recorded here.', icon: 'message' })
        : `<div class="table-wrap"><table class="data">
            <thead><tr><th>When</th><th>Type</th><th>Message</th><th>Outcome</th></tr></thead>
            <tbody>${activity.messages.map(m => `
              <tr>
                <td class="xs muted nowrap">${esc(timeAgo(m.sent_at))}</td>
                <td class="nowrap">${esc(m.message_type.replace(/_/g, ' '))}</td>
                <td><div class="truncate" title="${esc(m.message_content)}">${esc(m.message_content)}</div></td>
                <td>${deliveryPill(m.status)}
                  ${m.error_message ? `<div class="xs danger-text truncate" title="${esc(m.error_message)}">${esc(truncate(m.error_message, 60))}</div>` : ''}</td>
              </tr>`).join('')}</tbody></table></div>`;
      return;
    }

    pane.innerHTML = activity.logs.length === 0
      ? emptyState({ title: 'No log entries', message: 'Nothing has been recorded for this campaign in this period.', icon: 'inbox' })
      : `<div class="table-wrap"><table class="data">
          <thead><tr><th>Time</th><th>Action</th><th>Status</th><th>Details</th></tr></thead>
          <tbody>${activity.logs.map(l => `
            <tr>
              <td class="xs muted nowrap">${esc(fmtDateTime(l.timestamp))}</td>
              <td class="nowrap mono xs">${esc(l.action)}</td>
              <td>${logPill(l.status)}</td>
              <td><div class="truncate" title="${esc(readDetails(l.details))}">${esc(readDetails(l.details))}</div></td>
            </tr>`).join('')}</tbody></table></div>`;
  }

  container.querySelectorAll('#tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#tab-bar button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      paint();
    });
  });

  const searchBox = container.querySelector('#a-search');
  let debounce;
  searchBox.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      activityFilters.search = searchBox.value.trim();
      loadActivity();
    }, 400);
  });

  container.querySelector('#a-status').addEventListener('change', e => {
    activityFilters.status = e.target.value;
    loadActivity();
  });

  loadActivity();
}
