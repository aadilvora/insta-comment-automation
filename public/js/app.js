/**
 * Invest With Clarity — dashboard shell and hash router.
 */

import { api } from './api.js';
import { toastErr, toastOk, toastWarn, confirmDialog, esc } from './ui.js';

import * as overview from './views/overview.js';
import * as posts from './views/posts.js';
import * as campaigns from './views/campaigns.js';
import * as campaignDetail from './views/campaignDetail.js';
import * as campaignEditor from './views/campaignEditor.js';
import * as templates from './views/templates.js';
import * as analytics from './views/analytics.js';
import * as logs from './views/logs.js';
import * as connection from './views/connection.js';
import * as sandbox from './views/sandbox.js';
import * as settings from './views/settings.js';

/* ---------------- shared state ---------------- */

const RANGE_KEY = 'iwc.range';

export const state = {
  range: localStorage.getItem(RANGE_KEY) || 'all',
  system: null
};

export function setRange(range) {
  state.range = range;
  localStorage.setItem(RANGE_KEY, range);
}

/* ---------------- routes ---------------- */

const routes = [
  { pattern: /^\/?$/,                     view: overview,       nav: 'overview' },
  { pattern: /^\/overview$/,              view: overview,       nav: 'overview' },
  { pattern: /^\/posts$/,                 view: posts,          nav: 'posts' },
  { pattern: /^\/campaigns$/,             view: campaigns,      nav: 'campaigns' },
  { pattern: /^\/campaigns\/new$/,        view: campaignEditor, nav: 'campaigns' },
  { pattern: /^\/campaigns\/(\d+)$/,      view: campaignDetail, nav: 'campaigns' },
  { pattern: /^\/campaigns\/(\d+)\/edit$/, view: campaignEditor, nav: 'campaigns' },
  { pattern: /^\/templates$/,             view: templates,      nav: 'templates' },
  { pattern: /^\/analytics$/,             view: analytics,      nav: 'analytics' },
  { pattern: /^\/logs$/,                  view: logs,           nav: 'logs' },
  { pattern: /^\/connection$/,            view: connection,     nav: 'connection' },
  { pattern: /^\/sandbox$/,               view: sandbox,        nav: 'sandbox' },
  { pattern: /^\/settings$/,              view: settings,       nav: 'settings' }
];

export function go(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

/** Re-render whatever view is currently on screen. */
export function refresh() {
  render();
}

const viewEl = () => document.getElementById('view');

async function render() {
  const raw = window.location.hash.replace(/^#/, '') || '/overview';
  const [path, query] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));

  const match = routes.find(r => r.pattern.test(path));
  const container = viewEl();

  if (!match) {
    container.innerHTML = `
      <div class="empty">
        <h3>Page not found</h3>
        <p>The link <span class="mono">${esc(path)}</span> doesn't match anything in this dashboard.</p>
        <a class="btn btn-primary" href="#/overview">Back to Overview</a>
      </div>`;
    return;
  }

  const captured = path.match(match.pattern).slice(1);
  highlightNav(match.nav);

  // Clear the previous view's topbar buttons before the next one mounts.
  document.getElementById('topbar-actions').innerHTML = '';

  try {
    await match.view.render(container, { params: captured, query: params });
  } catch (err) {
    console.error(err);
    container.innerHTML = `
      <div class="banner banner-danger">
        <div class="banner-text"><strong>Could not load this page.</strong> ${esc(err.message)}</div>
      </div>`;
  }

  window.scrollTo({ top: 0 });
  closeRail();
}

function highlightNav(nav) {
  document.querySelectorAll('.rail-link').forEach(link => {
    link.classList.toggle('active', link.dataset.route === nav);
  });
}

export function setTopbar(title, subtitle = '') {
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent = subtitle;
  document.title = `${title} — Invest With Clarity`;
}

/** Place buttons in the topbar; returns the container so views can bind events. */
export function setTopbarActions(html) {
  const el = document.getElementById('topbar-actions');
  el.innerHTML = html;
  return el;
}

/* ---------------- system status strip ---------------- */

export async function refreshSystemStatus() {
  const el = document.getElementById('rail-meta-status');
  const btn = document.getElementById('btn-emergency');

  try {
    const { status } = await api.systemStatus();
    state.system = status;

    let dot = 'dot-ok';
    let label = 'Instagram connected';

    if (status.emergencyStop) {
      dot = 'dot-danger';
      label = 'Emergency stop ON';
    } else if (status.automationPaused) {
      dot = 'dot-warn';
      label = 'All automation paused';
    } else if (!status.metaStatus?.connected) {
      dot = 'dot-danger';
      label = status.metaStatus?.status === 'TOKEN_MISSING' ? 'No access token' : 'Connection problem';
    }

    el.innerHTML = `<span class="rail-status-dot ${dot}"></span><span>${esc(label)}</span>`;

    btn.textContent = status.emergencyStop ? 'Release Emergency Stop' : 'Emergency Stop';
    btn.className = status.emergencyStop
      ? 'btn btn-primary btn-sm btn-block'
      : 'btn btn-danger btn-sm btn-block';

    updateCounts();
  } catch (err) {
    el.innerHTML = `<span class="rail-status-dot dot-danger"></span><span>Server unreachable</span>`;
  }
}

async function updateCounts() {
  try {
    const [{ overview: ov }, { posts: list }] = await Promise.all([
      api.overview('all'),
      api.posts('all')
    ]);

    setCount('count-campaigns', ov.campaigns.total);
    setCount('count-posts', list.length);
  } catch (e) {
    /* counts are decoration; a failure here must not break the page */
  }
}

function setCount(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.toggle('hidden', !value);
}

/* ---------------- emergency stop ---------------- */

async function onEmergencyClick() {
  const active = Boolean(state.system?.emergencyStop);

  if (!active) {
    const ok = await confirmDialog({
      title: 'Activate emergency stop?',
      message:
        'Every campaign stops sending immediately, and anything already queued but not yet sent is discarded. ' +
        'Campaign settings are kept, so you can release the stop at any time.',
      confirmLabel: 'Stop everything',
      danger: true
    });
    if (!ok) return;
  }

  try {
    const result = await api.emergencyStop(!active);
    if (result.emergencyStop) {
      toastWarn(
        result.queuedDropped
          ? `Emergency stop is on. ${result.queuedDropped} queued action(s) discarded.`
          : 'Emergency stop is on. Nothing will be sent.',
        'All automation halted'
      );
    } else {
      toastOk('Emergency stop released. Running campaigns can send again.');
    }
    await refreshSystemStatus();
    refresh();
  } catch (err) {
    toastErr(err.message);
  }
}

/* ---------------- mobile rail ---------------- */

function openRail() {
  document.getElementById('rail').classList.add('open');
  if (!document.querySelector('.scrim')) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.onclick = closeRail;
    document.body.appendChild(scrim);
  }
}

function closeRail() {
  document.getElementById('rail').classList.remove('open');
  document.querySelector('.scrim')?.remove();
}

/* ---------------- boot ---------------- */

window.addEventListener('hashchange', render);

document.getElementById('btn-emergency').addEventListener('click', onEmergencyClick);
document.getElementById('rail-toggle').addEventListener('click', () => {
  const rail = document.getElementById('rail');
  rail.classList.contains('open') ? closeRail() : openRail();
});

refreshSystemStatus();
render();

// Keep the connection indicator honest without hammering the server.
setInterval(refreshSystemStatus, 30000);
