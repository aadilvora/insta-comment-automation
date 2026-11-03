/**
 * Shared UI toolkit: escaping, formatting, toasts, modals, confirm dialogs,
 * status pills, empty states and a dependency-free line chart.
 */

/* ---------------- escaping & formatting ---------------- */

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function num(value) {
  return Number(value || 0).toLocaleString('en-IN');
}

export function fmtDate(value) {
  if (!value) return '—';
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(value) {
  if (!value) return '—';
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
  });
}

/**
 * SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Parsed as-is,
 * browsers read it as local time and every timestamp shifts. Normalise first.
 */
function parseDate(value) {
  if (value instanceof Date) return value;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

export function timeAgo(value) {
  if (!value) return '—';
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';

  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return fmtDate(value);
}

export function truncate(text, max = 90) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ---------------- status rendering ---------------- */

export const STATUS_LABEL = {
  DRAFT: 'Draft',
  ACTIVE: 'Running',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
  ERROR: 'Error'
};

export function statusPill(status) {
  const s = String(status || 'DRAFT').toUpperCase();
  return `<span class="pill pill-${esc(s)}"><span class="pill-dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`;
}

export function logPill(status) {
  const s = String(status || '').toUpperCase();
  return `<span class="pill pill-${esc(s)}">${esc(s || '—')}</span>`;
}

/**
 * Outbound message outcomes are shown with Meta's distinction intact:
 * delivered, rejected by Meta, and not eligible under Meta's rules.
 */
export function deliveryPill(status) {
  const map = {
    sent: ['pill-SUCCESS', 'Delivered'],
    failed: ['pill-FAILURE', 'Rejected by Meta'],
    blocked_by_policy: ['pill-WARNING', 'Not eligible'],
    pending: ['pill-muted', 'Pending'],
    disabled: ['pill-muted', 'Off'],
    already_replied: ['pill-muted', 'Duplicate']
  };
  const [cls, label] = map[status] || ['pill-muted', status || '—'];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

/* ---------------- toasts ---------------- */

export function toast(message, { type = 'ok', title = null, timeout = 4200 } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;

  const titles = { ok: 'Done', error: 'Something went wrong', warn: 'Heads up', info: 'Note' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-text">
      <div class="toast-title">${esc(title || titles[type] || 'Note')}</div>
      <div class="toast-msg">${esc(message)}</div>
    </div>
    <button class="btn btn-ghost btn-sm" aria-label="Dismiss">&times;</button>`;

  el.querySelector('button').onclick = () => el.remove();
  root.appendChild(el);

  if (timeout) setTimeout(() => el.remove(), timeout);
}

export const toastOk = (m, t) => toast(m, { type: 'ok', title: t });
export const toastErr = (m, t) => toast(m, { type: 'error', title: t, timeout: 7000 });
export const toastWarn = (m, t) => toast(m, { type: 'warn', title: t });

/* ---------------- modals ---------------- */

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  document.body.style.overflow = '';
}

/**
 * Open a modal. `onMount(modalEl, close)` runs once the markup is in the DOM.
 */
export function openModal({ title, subtitle = '', body = '', footer = '', wide = false, onMount = null }) {
  const root = document.getElementById('modal-root');
  if (!root) return;

  root.innerHTML = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;

  document.body.style.overflow = 'hidden';

  const backdrop = root.querySelector('[data-backdrop]');
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) closeModal();
  });

  const onKey = e => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  if (onMount) onMount(root.querySelector('.modal'), closeModal);
}

/**
 * Confirmation dialog. Resolves true only when the action is confirmed, so
 * destructive steps always need a deliberate click.
 */
/**
 * `html: true` renders `message` as markup instead of escaped text, for dialogs
 * that need a list or emphasis. The caller is then responsible for escaping any
 * value that came from Instagram or the database — esc() each one at the point
 * it is interpolated. Never pass unescaped remote data with html: true.
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  html = false
}) {
  return new Promise(resolve => {
    openModal({
      title,
      body: html
        ? `<div class="muted" style="font-size:.88rem">${message}</div>`
        : `<p class="muted" style="font-size:.88rem">${esc(message)}</p>`,
      footer: `
        <button class="btn" data-cancel>${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
      onMount: (modal, close) => {
        modal.querySelector('[data-cancel]').onclick = () => { close(); resolve(false); };
        modal.querySelector('[data-confirm]').onclick = () => { close(); resolve(true); };
        modal.querySelector('[data-confirm]').focus();
      }
    });
  });
}

/* ---------------- empty state ---------------- */

export function emptyState({ title, message, actionLabel = null, actionAttr = '', icon = 'inbox' }) {
  const icons = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    campaign: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
  };

  return `
    <div class="empty">
      <div class="empty-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[icon] || icons.inbox}</svg>
      </div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${actionLabel ? `<button class="btn btn-primary" ${actionAttr}>${esc(actionLabel)}</button>` : ''}
    </div>`;
}

export function loading(message = 'Loading…') {
  return `<div class="empty"><span class="spinner"></span><p class="mt-1">${esc(message)}</p></div>`;
}

/* ---------------- chart ---------------- */

/**
 * A small two-series line chart drawn as inline SVG. No chart library, so it
 * stays fast and works with no network.
 */
export function lineChart(series, { height = 190 } = {}) {
  if (!series || series.length === 0) {
    return `<div class="empty small">No activity in this period yet.</div>`;
  }

  const w = 720;
  const h = height;
  const padL = 34, padR = 12, padT = 12, padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const maxVal = Math.max(1, ...series.map(d => Math.max(d.comments || 0, d.messages || 0)));
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;

  const pointsFor = key => series.map((d, i) => {
    const x = padL + i * stepX;
    const y = padT + innerH - ((d[key] || 0) / maxVal) * innerH;
    return [x, y];
  });

  const pathOf = pts => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaOf = pts =>
    `${pathOf(pts)} L${(padL + (series.length - 1) * stepX).toFixed(1)},${padT + innerH} L${padL},${padT + innerH} Z`;

  const commentPts = pointsFor('comments');
  const messagePts = pointsFor('messages');

  // Horizontal gridlines with value labels
  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const y = padT + (innerH / ticks) * i;
    const value = Math.round(maxVal - (maxVal / ticks) * i);
    grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#94a3b8">${value}</text>`;
  }

  // Date labels: first, middle, last
  let labels = '';
  const labelIdx = series.length > 2 ? [0, Math.floor(series.length / 2), series.length - 1] : [0, series.length - 1];
  for (const i of [...new Set(labelIdx)]) {
    const d = series[i];
    if (!d) continue;
    const x = padL + i * stepX;
    const txt = new Date(d.day + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    labels += `<text x="${x}" y="${h - 6}" text-anchor="${anchor}" font-size="9" fill="#94a3b8">${esc(txt)}</text>`;
  }

  return `
    <svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Activity over time">
      <defs>
        <linearGradient id="gradComments" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0d9488" stop-opacity=".18"/>
          <stop offset="100%" stop-color="#0d9488" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaOf(commentPts)}" fill="url(#gradComments)"/>
      <path d="${pathOf(commentPts)}" fill="none" stroke="#0d9488" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${pathOf(messagePts)}" fill="none" stroke="#6366f1" stroke-width="2"
            stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>
      ${labels}
    </svg>
    <div class="chart-legend">
      <span class="legend-key"><span class="legend-swatch" style="background:#0d9488"></span>Comments received</span>
      <span class="legend-key"><span class="legend-swatch" style="background:#6366f1"></span>Messages delivered</span>
    </div>`;
}

/* ---------------- misc helpers ---------------- */

export function statCard({ label, value, accent = '', note = '' }) {
  return `
    <div class="stat ${accent ? 'accent-' + accent : ''}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${num(value)}</div>
      ${note ? `<div class="stat-note">${esc(note)}</div>` : ''}
    </div>`;
}

/** Pull a readable line out of a JSON log details blob. */
export function readDetails(details) {
  if (!details) return '';
  try {
    const parsed = typeof details === 'string' ? JSON.parse(details) : details;
    if (typeof parsed === 'string') return parsed;
    if (parsed.message) return parsed.message;
    if (parsed.text) return parsed.text;
    if (parsed.error) return parsed.error;
    if (parsed.reason) return parsed.reason;
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ');
  } catch (e) {
    return String(details);
  }
}
