/**
 * Activity Logs — the full, searchable audit trail.
 */

import { api } from '../api.js';
import {
  esc, num, fmtDateTime, timeAgo, logPill, readDetails,
  emptyState, loading, openModal
} from '../ui.js';
import { state, setTopbar } from '../app.js';
import { rangeBar, bindRangeBar } from './overview.js';

const filters = { action: 'ALL', status: 'ALL', campaignId: 'ALL', search: '', limit: 200 };

export async function render(container) {
  setTopbar('Activity Logs', 'Every action the automation has taken');

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Activity Logs</h1>
        <p>A record of every comment seen, every reply sent, and every message Meta refused.</p>
      </div>
      ${rangeBar(state.range)}
    </div>

    <div class="card mb-2">
      <div class="card-body">
        <div class="toolbar" style="margin-bottom:0">
          <div class="grow">
            <input type="search" id="l-search" placeholder="Search actions, users, details…" value="${esc(filters.search)}">
          </div>
          <select id="l-campaign" style="width:auto;max-width:220px"><option value="ALL">All campaigns</option></select>
          <select id="l-action" style="width:auto;max-width:220px"><option value="ALL">All actions</option></select>
          <select id="l-status" style="width:auto">
            <option value="ALL">All outcomes</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="WARNING">Warning</option>
            <option value="SKIPPED">Skipped</option>
          </select>
          <select id="l-limit" style="width:auto">
            <option value="100">100 rows</option>
            <option value="200" selected>200 rows</option>
            <option value="500">500 rows</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card"><div id="log-pane">${loading('Loading logs…')}</div></div>`;

  bindRangeBar(container);

  // Populate the campaign filter once; the action list comes with each fetch.
  try {
    const { campaigns } = await api.campaigns({ sort: 'name' });
    const select = container.querySelector('#l-campaign');
    for (const c of campaigns) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (String(filters.campaignId) === String(c.id)) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (e) { /* the filter simply stays on "All campaigns" */ }

  async function load() {
    const pane = container.querySelector('#log-pane');
    pane.innerHTML = loading('Loading logs…');

    try {
      const { logs, actions } = await api.logs({ ...filters, range: state.range });

      // Keep the action dropdown in step with what actually exists.
      const actionSelect = container.querySelector('#l-action');
      if (actionSelect.options.length <= 1 && actions?.length) {
        for (const a of actions) {
          const opt = document.createElement('option');
          opt.value = a;
          opt.textContent = a.replace(/_/g, ' ').toLowerCase();
          actionSelect.appendChild(opt);
        }
        actionSelect.value = filters.action;
      }

      pane.innerHTML = logs.length === 0
        ? emptyState({
            title: 'No log entries match',
            message: 'Try a wider date range, or clear the filters to see everything.',
            icon: 'search'
          })
        : `<div class="table-wrap"><table class="data">
            <thead><tr>
              <th class="nowrap">Time</th><th>Action</th><th>Outcome</th>
              <th>Campaign</th><th>Viewer</th><th>Details</th>
            </tr></thead>
            <tbody>${logs.map(l => `
              <tr data-log='${esc(JSON.stringify({ ...l, pretty: readDetails(l.details) }))}' style="cursor:pointer">
                <td class="xs muted nowrap" title="${esc(fmtDateTime(l.timestamp))}">${esc(timeAgo(l.timestamp))}</td>
                <td class="mono xs nowrap">${esc(l.action)}</td>
                <td>${logPill(l.status)}</td>
                <td class="xs">${l.campaign_id ? `<a href="#/campaigns/${l.campaign_id}">#${l.campaign_id}</a>` : '<span class="faint">—</span>'}</td>
                <td class="xs mono">${esc(l.user_id || '—')}</td>
                <td><div class="truncate">${esc(readDetails(l.details))}</div></td>
              </tr>`).join('')}</tbody></table></div>
          <div class="card-foot"><span class="xs muted">${num(logs.length)} entries shown, newest first.</span></div>`;

      // Click a row to read the whole entry.
      pane.querySelectorAll('[data-log]').forEach(row => {
        row.addEventListener('click', () => {
          const l = JSON.parse(row.dataset.log);
          openModal({
            title: l.action.replace(/_/g, ' '),
            subtitle: fmtDateTime(l.timestamp),
            wide: true,
            body: `
              <dl class="kv mb-2">
                <dt>Outcome</dt><dd>${logPill(l.status)}</dd>
                <dt>Campaign</dt><dd>${l.campaign_id ? `#${l.campaign_id}` : '—'}</dd>
                <dt>Post</dt><dd class="mono xs">${esc(l.post_id || '—')}</dd>
                <dt>Comment</dt><dd class="mono xs">${esc(l.comment_id || '—')}</dd>
                <dt>Viewer</dt><dd class="mono xs">${esc(l.user_id || '—')}</dd>
              </dl>
              <label class="lbl">Full details</label>
              <pre class="mono" style="background:var(--surface-sunken);padding:.8rem;border-radius:var(--r);
                   overflow:auto;max-height:320px;white-space:pre-wrap;word-break:break-word;margin:0">${esc(prettyJson(l.details))}</pre>`,
            footer: `<button class="btn" data-cancel>Close</button>`,
            onMount: (modal, close) => { modal.querySelector('[data-cancel]').onclick = close; }
          });
        });
      });
    } catch (err) {
      pane.innerHTML = `<div class="card-body"><p class="muted small">Could not load logs: ${esc(err.message)}</p></div>`;
    }
  }

  function prettyJson(details) {
    try {
      return JSON.stringify(JSON.parse(details), null, 2);
    } catch (e) {
      return String(details || '');
    }
  }

  const search = container.querySelector('#l-search');
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { filters.search = search.value.trim(); load(); }, 400);
  });

  container.querySelector('#l-action').addEventListener('change', e => { filters.action = e.target.value; load(); });
  container.querySelector('#l-status').addEventListener('change', e => { filters.status = e.target.value; load(); });
  container.querySelector('#l-campaign').addEventListener('change', e => { filters.campaignId = e.target.value; load(); });
  container.querySelector('#l-limit').addEventListener('change', e => { filters.limit = Number(e.target.value); load(); });

  load();
}
