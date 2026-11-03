/**
 * Overview — the headline numbers for the whole account, with date filters.
 */

import { api } from '../api.js';
import {
  esc, num, statCard, lineChart, loading, emptyState,
  statusPill, timeAgo, logPill, readDetails, toastErr
} from '../ui.js';
import { state, setRange, setTopbar, setTopbarActions, refresh, go } from '../app.js';
import { bindControls, controlButtons } from './campaignActions.js';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d',    label: 'Last 7 days' },
  { key: '30d',   label: 'Last 30 days' },
  { key: 'all',   label: 'All time' }
];

function rangeBar(active) {
  return `
    <div class="segmented" id="range-bar">
      ${RANGES.map(r => `
        <button data-range="${r.key}" class="${r.key === active ? 'active' : ''}">${esc(r.label)}</button>
      `).join('')}
    </div>`;
}

export function bindRangeBar(root, onChange) {
  root.querySelectorAll('#range-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      setRange(btn.dataset.range);
      onChange ? onChange(btn.dataset.range) : refresh();
    });
  });
}

export { rangeBar };

export async function render(container) {
  setTopbar('Overview', 'How your automation is performing');
  container.innerHTML = loading('Loading your numbers…');

  let data, campaignsData, system;
  try {
    [data, campaignsData, { status: system }] = await Promise.all([
      api.overview(state.range),
      api.campaigns({ sort: 'activity', range: state.range }),
      api.systemStatus()
    ]);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">
      <strong>Could not load the dashboard.</strong> ${esc(err.message)}</div></div>`;
    return;
  }

  const ov = data.overview;
  const live = campaignsData.campaigns;

  // Banners for anything that stops messages going out right now.
  let banners = '';
  if (system.emergencyStop) {
    banners += `
      <div class="banner banner-danger">
        <div class="banner-text">
          <strong>Emergency stop is active.</strong>
          No campaign is sending anything, and queued actions are being discarded.
          Release it from the button in the sidebar.
        </div>
      </div>`;
  } else if (system.automationPaused) {
    banners += `
      <div class="banner banner-warn">
        <div class="banner-text">
          <strong>All automation is paused.</strong>
          Individual campaign statuses are untouched — resume from Settings.
        </div>
      </div>`;
  }

  if (!system.metaStatus?.connected) {
    banners += `
      <div class="banner banner-warn">
        <div class="banner-text">
          <strong>Instagram isn't connected.</strong>
          ${esc(system.metaStatus?.message || 'Add your Meta access token to start receiving comments.')}
        </div>
        <a class="btn btn-sm" href="#/connection">Fix connection</a>
      </div>`;
  }

  const recentActive = live.filter(c => c.status === 'ACTIVE').slice(0, 4);

  container.innerHTML = `
    ${banners}

    <div class="page-head">
      <div class="page-head-text">
        <h1>Overview</h1>
        <p>Figures below cover <strong>${esc(ov.rangeLabel.toLowerCase())}</strong>, straight from your database.</p>
      </div>
      ${rangeBar(state.range)}
    </div>

    <div class="stat-grid">
      ${statCard({ label: 'Comments received', value: ov.totalComments, accent: 'brand' })}
      ${statCard({ label: 'Comments processed', value: ov.processedComments, note: `${num(ov.matchedComments)} matched a keyword, ${num(ov.totalComments - ov.processedComments)} still pending` })}
      ${statCard({ label: 'Public replies sent', value: ov.publicReplies, accent: 'info' })}
      ${statCard({ label: 'Private messages sent', value: ov.privateMessages, accent: 'info' })}
      ${statCard({ label: 'Delivered successfully', value: ov.successfulMessages, accent: 'ok' })}
      ${statCard({ label: 'Rejected by Meta', value: ov.failedMessages, accent: ov.failedMessages ? 'danger' : '' })}
      ${statCard({ label: 'Not eligible to send', value: ov.blockedByPolicy, accent: ov.blockedByPolicy ? 'warn' : '', note: "Blocked by Meta's rules" })}
      ${statCard({ label: 'Unique commenters', value: ov.uniqueCommenters })}
    </div>

    <div class="card mb-3">
      <div class="card-head">
        <h2>Message request status</h2>
        <span class="muted small">Why a sent DM can still look undelivered</span>
      </div>
      <div class="card-body">
        <div class="stat-grid" style="margin:0">
          ${statCard({
            label: 'Waiting to be accepted',
            value: ov.awaitingAcceptance,
            accent: ov.awaitingAcceptance ? 'warn' : '',
            note: 'DM is in their Message Requests folder'
          })}
          ${statCard({
            label: 'Accepted and replied',
            value: ov.acceptedThreads,
            accent: 'ok',
            note: 'The 24-hour window opened'
          })}
          ${statCard({
            label: 'Declined by recipient',
            value: ov.declinedByRecipient,
            note: 'Their own privacy setting'
          })}
          ${statCard({
            label: 'Needs your attention',
            value: ov.needsAttention,
            accent: ov.needsAttention ? 'danger' : '',
            note: 'App or permission problem'
          })}
        </div>
        <p class="muted small mt-2" style="margin-bottom:0">
          Instagram puts the first automated DM into the person's <strong>Message Requests</strong>.
          Meta opens no messaging window until they tap Accept and reply, so the follow-up report is
          held back until then — for private and public accounts alike. That wait is normal.
        </p>
        ${(data.failureReasons || []).length ? `
          <div class="mt-3">
            <h3 class="small" style="margin:0 0 .5rem">Why messages did not send</h3>
            <table class="table">
              <thead><tr><th>Reason</th><th class="right">Comments</th><th>What it means</th></tr></thead>
              <tbody>
                ${data.failureReasons.map(r => `
                  <tr>
                    <td><span class="pill">${esc(reasonLabel(r.error_category))}</span></td>
                    <td class="right tabnum">${num(r.count)}</td>
                    <td class="muted small">${esc(reasonHelp(r.error_category))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : ''}
      </div>
    </div>

    <div class="grid-2 mb-3">
      <div class="card">
        <div class="card-head"><h2>Activity trend</h2></div>
        <div class="card-body">${lineChart(data.series)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Campaign status</h2>
          <a class="btn btn-sm" href="#/campaigns">Manage</a>
        </div>
        <div class="card-body">
          <div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin:0">
            ${statCard({ label: 'Running', value: ov.campaigns.active, accent: 'ok' })}
            ${statCard({ label: 'Paused', value: ov.campaigns.paused, accent: 'warn' })}
            ${statCard({ label: 'Drafts', value: ov.campaigns.draft })}
            ${statCard({ label: 'Stopped', value: ov.campaigns.stopped })}
          </div>
          ${ov.campaigns.error ? `
            <div class="banner banner-danger mt-2" style="margin-bottom:0">
              <div class="banner-text">${num(ov.campaigns.error)} campaign(s) need attention.</div>
              <a class="btn btn-sm" href="#/campaigns?status=ERROR">Review</a>
            </div>` : ''}
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head">
        <h2>Running campaigns</h2>
        <a class="btn btn-sm btn-primary" href="#/campaigns/new">New campaign</a>
      </div>
      <div id="active-list">
        ${recentActive.length === 0
          ? emptyState({
              title: 'Nothing is running yet',
              message: 'Create a campaign, pick one of your Reels, set the keywords and start it. Every reply is logged here.',
              actionLabel: 'Create your first campaign',
              actionAttr: 'data-go="/campaigns/new"',
              icon: 'campaign'
            })
          : `<div class="table-wrap"><table class="data">
              <thead><tr>
                <th>Campaign</th><th>Status</th><th class="nowrap">Keyword hits</th>
                <th class="nowrap">Delivered</th><th class="nowrap">Issues</th>
                <th>Last activity</th><th></th>
              </tr></thead>
              <tbody>
                ${recentActive.map(c => `
                  <tr>
                    <td>
                      <a href="#/campaigns/${c.id}" class="strong">${esc(c.name)}</a>
                      <div class="xs muted mono">${esc(c.post_id)}</div>
                    </td>
                    <td>${statusPill(c.status)}</td>
                    <td class="tabnum">${num(c.stats.keywordMatches)}</td>
                    <td class="tabnum ok-text">${num(c.stats.successfulMessages)}</td>
                    <td class="tabnum ${c.stats.failedMessages || c.stats.blockedByPolicy ? 'danger-text' : 'muted'}">
                      ${num(c.stats.failedMessages + c.stats.blockedByPolicy)}
                    </td>
                    <td class="xs muted nowrap">${esc(timeAgo(c.last_activity_at || c.updated_at))}</td>
                    <td class="nowrap">
                      <div class="btn-group">
                        ${controlButtons(c, { showEdit: false, showMore: false })}
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody></table></div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Latest activity</h2>
        <a class="btn btn-sm" href="#/logs">View all logs</a>
      </div>
      <div class="card-body" id="recent-activity">${loading('Loading activity…')}</div>
    </div>`;

  bindRangeBar(container);
  bindControls(container);

  container.querySelectorAll('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => go(btn.dataset.go));
  });

  // Activity stream loads after the main numbers so the page paints fast.
  try {
    const { logs } = await api.logs({ limit: 12, range: state.range });
    const box = container.querySelector('#recent-activity');

    box.innerHTML = logs.length === 0
      ? emptyState({
          title: 'No activity in this period',
          message: 'Once a comment arrives on one of your Reels, every step the automation takes shows up here.',
          icon: 'inbox'
        })
      : `<div class="timeline">
          ${logs.map(l => `
            <div class="tl-item ${String(l.status).toLowerCase() === 'success' ? 'ok' : String(l.status).toLowerCase()}">
              <div class="tl-time">${esc(timeAgo(l.timestamp))}</div>
              <div class="tl-title">${esc(l.action.replace(/_/g, ' ').toLowerCase())} ${logPill(l.status)}</div>
              <div class="tl-body">${esc(readDetails(l.details))}</div>
            </div>`).join('')}
        </div>`;
  } catch (err) {
    container.querySelector('#recent-activity').innerHTML =
      `<p class="muted small">Could not load activity: ${esc(err.message)}</p>`;
  }
}

// Plain-English names for the categories metaErrors.js records. Kept here so the
// dashboard never shows a raw Meta error code to the creator.
const REASONS = {
  USER_UNAVAILABLE: ['Person not accepting DMs',
    'They have message requests switched off, or have blocked or restricted the account. Instagram will not deliver to them and we do not retry.'],
  TARGET_NOT_FOUND: ['App not live, or comment gone',
    'Usually the Meta app is still in Development Mode, where only people with an app role can be messaged. Switch the app to Live. It can also mean the comment was deleted or is older than 7 days.'],
  CONFIG: ['Token or permission problem',
    'Reconnect the Instagram account and confirm instagram_manage_messages and instagram_manage_comments are granted.'],
  RATE_LIMITED: ['Meta rate limit',
    'Meta asked us to slow down. These are retried automatically.'],
  TRANSIENT: ['Temporary Meta error',
    'A short-lived problem on Meta\'s side. Retried automatically.'],
  WINDOW_CLOSED: ['24-hour window closed',
    'Meta only allows a follow-up within 24 hours of the person\'s own last message.'],
  SINGLE_REPLY_RULE_VIOLATION: ['Already replied once',
    'Meta permits exactly one private reply per comment.'],
  COMMENT_EXPIRED: ['Comment older than 7 days',
    'Meta does not allow a private reply after 7 days.'],
  EMERGENCY_STOP_ACTIVE: ['Emergency stop was on', 'The send was cancelled by the emergency stop.'],
  AUTOMATION_PAUSED: ['Automation was paused', 'The send was cancelled because automation was paused.'],
  UNKNOWN: ['Unrecognised error', 'Check the activity log for the exact Meta response.']
};

function reasonLabel(key) {
  if (!key) return 'Unknown';
  if (REASONS[key]) return REASONS[key][0];
  if (key.startsWith('CAMPAIGN_')) return `Campaign was ${key.slice(9).toLowerCase()}`;
  return key;
}

function reasonHelp(key) {
  if (REASONS[key]) return REASONS[key][1];
  if (key && key.startsWith('CAMPAIGN_')) return 'The campaign was not running when this comment arrived.';
  return 'Check the activity log for the exact Meta response.';
}
