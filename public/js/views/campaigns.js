/**
 * Campaigns — searchable, filterable, sortable list of every campaign.
 */

import { api } from '../api.js';
import {
  esc, num, statusPill, timeAgo, truncate, emptyState, loading, toastErr
} from '../ui.js';
import { state, setTopbar, refresh, go } from '../app.js';
import { rangeBar, bindRangeBar } from './overview.js';
import { controlButtons, bindControls, deleteCampaign } from './campaignActions.js';

// Filter choices live in the URL hash, so a filtered view can be bookmarked.
function currentFilters(query) {
  return {
    search: query.search || '',
    status: query.status || 'ALL',
    post_id: query.post || 'ALL',
    sort: query.sort || 'recent'
  };
}

function applyFilters(filters) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.status && filters.status !== 'ALL') params.set('status', filters.status);
  if (filters.post_id && filters.post_id !== 'ALL') params.set('post', filters.post_id);
  if (filters.sort && filters.sort !== 'recent') params.set('sort', filters.sort);

  const qs = params.toString();
  go(`/campaigns${qs ? '?' + qs : ''}`);
}

export async function render(container, { query = {} } = {}) {
  setTopbar('Campaigns', 'Create, edit and control every automation');
  container.innerHTML = loading('Loading campaigns…');

  const filters = currentFilters(query);

  let data, postsData;
  try {
    [data, postsData] = await Promise.all([
      api.campaigns({ ...filters, range: state.range }),
      api.posts('all')
    ]);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  const list = data.campaigns;
  const noFilters = !filters.search && filters.status === 'ALL' && filters.post_id === 'ALL';

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Campaigns</h1>
        <p>${num(data.count)} campaign${data.count === 1 ? '' : 's'}${noFilters ? '' : ' matching your filters'}.</p>
      </div>
      ${rangeBar(state.range)}
      <a class="btn btn-primary" href="#/campaigns/new">New campaign</a>
    </div>

    <div class="card mb-2">
      <div class="card-body">
        <div class="toolbar" style="margin-bottom:0">
          <div class="grow">
            <input type="search" id="f-search" placeholder="Search by campaign name…"
                   value="${esc(filters.search)}" aria-label="Search campaigns">
          </div>

          <select id="f-status" aria-label="Filter by status" style="width:auto">
            <option value="ALL">All statuses</option>
            ${['ACTIVE', 'PAUSED', 'DRAFT', 'STOPPED', 'ERROR'].map(s => `
              <option value="${s}" ${filters.status === s ? 'selected' : ''}>
                ${s === 'ACTIVE' ? 'Running' : s.charAt(0) + s.slice(1).toLowerCase()}
              </option>`).join('')}
          </select>

          <select id="f-post" aria-label="Filter by post" style="width:auto;max-width:240px">
            <option value="ALL">All posts &amp; Reels</option>
            ${postsData.posts.map(p => `
              <option value="${esc(p.post_id)}" ${filters.post_id === p.post_id ? 'selected' : ''}>
                ${esc(truncate(p.caption || p.post_id, 40))}
              </option>`).join('')}
          </select>

          <select id="f-sort" aria-label="Sort" style="width:auto">
            <option value="recent"   ${filters.sort === 'recent' ? 'selected' : ''}>Recently updated</option>
            <option value="activity" ${filters.sort === 'activity' ? 'selected' : ''}>Latest activity</option>
            <option value="comments" ${filters.sort === 'comments' ? 'selected' : ''}>Most comments</option>
            <option value="name"     ${filters.sort === 'name' ? 'selected' : ''}>Name A–Z</option>
            <option value="oldest"   ${filters.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
          </select>

          ${noFilters && filters.sort === 'recent' ? '' : '<button class="btn btn-ghost" id="f-clear">Clear</button>'}
        </div>
      </div>
    </div>

    ${list.length === 0
      ? `<div class="card">${noFilters
          ? emptyState({
              title: 'No campaigns yet',
              message: 'A campaign watches one Reel for keywords, replies publicly, then sends the DM. Set one up in a few steps.',
              actionLabel: 'Create your first campaign',
              actionAttr: 'data-go="/campaigns/new"',
              icon: 'campaign'
            })
          : emptyState({
              title: 'Nothing matches those filters',
              message: 'Try a different status, another Reel, or clear the search box.',
              actionLabel: 'Clear filters',
              actionAttr: 'id="f-clear-empty"',
              icon: 'search'
            })}</div>`
      : `<div class="card"><div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Campaign</th>
            <th>Status</th>
            <th>Keywords</th>
            <th class="nowrap">Comments</th>
            <th class="nowrap">Matched</th>
            <th class="nowrap">Delivered</th>
            <th class="nowrap">Issues</th>
            <th class="nowrap">Last activity</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${list.map(c => {
              const issues = c.stats.failedMessages + c.stats.blockedByPolicy;
              return `
              <tr>
                <td>
                  <a href="#/campaigns/${c.id}" class="strong">${esc(c.name)}</a>
                  <div class="xs muted">${esc(truncate(c.post?.caption || c.post_id, 42))}</div>
                </td>
                <td>${statusPill(c.status)}</td>
                <td>
                  <div class="chips">
                    ${c.keywordList.slice(0, 3).map(k => `<span class="chip">${esc(k)}</span>`).join('')}
                    ${c.keywordList.length > 3 ? `<span class="chip">+${c.keywordList.length - 3}</span>` : ''}
                  </div>
                </td>
                <td class="tabnum">${num(c.stats.commentsReceived)}</td>
                <td class="tabnum">${num(c.stats.keywordMatches)}</td>
                <td class="tabnum ok-text">${num(c.stats.successfulMessages)}</td>
                <td class="tabnum ${issues ? 'danger-text' : 'muted'}">${num(issues)}</td>
                <td class="xs muted nowrap">${esc(timeAgo(c.last_activity_at || c.updated_at))}</td>
                <td class="nowrap">
                  <div class="btn-group">
                    ${controlButtons(c)}
                    <button class="btn btn-sm" data-delete-id="${c.id}" data-delete-name="${esc(c.name)}">Delete</button>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody></table></div></div>`}`;

  bindRangeBar(container);
  bindControls(container);

  container.querySelectorAll('[data-go]').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.go)));

  // Search runs on Enter, or after a short pause in typing.
  const searchInput = container.querySelector('#f-search');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => applyFilters({ ...filters, search: searchInput.value.trim() }), 420);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(debounce);
      applyFilters({ ...filters, search: searchInput.value.trim() });
    }
  });

  container.querySelector('#f-status').addEventListener('change', e =>
    applyFilters({ ...filters, status: e.target.value }));
  container.querySelector('#f-post').addEventListener('change', e =>
    applyFilters({ ...filters, post_id: e.target.value }));
  container.querySelector('#f-sort').addEventListener('change', e =>
    applyFilters({ ...filters, sort: e.target.value }));

  const clear = () => go('/campaigns');
  container.querySelector('#f-clear')?.addEventListener('click', clear);
  container.querySelector('#f-clear-empty')?.addEventListener('click', clear);

  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const removed = await deleteCampaign(btn.dataset.deleteId, btn.dataset.deleteName);
      if (removed) refresh();
    });
  });
}
