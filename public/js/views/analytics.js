/**
 * Analytics — comparison across campaigns, plus Meta delivery outcomes
 * and the conversation threads the automation has opened.
 */

import { api } from '../api.js';
import {
  esc, num, truncate, timeAgo, fmtDateTime, statusPill, deliveryPill,
  statCard, lineChart, emptyState, loading
} from '../ui.js';
import { state, setTopbar } from '../app.js';
import { rangeBar, bindRangeBar } from './overview.js';

export async function render(container) {
  setTopbar('Analytics', 'Compare campaigns and delivery outcomes');
  container.innerHTML = loading('Crunching the numbers…');

  let data, campaignsData, threadsData;
  try {
    [data, campaignsData, threadsData] = await Promise.all([
      api.overview(state.range),
      api.campaigns({ sort: 'comments', range: state.range }),
      api.threads()
    ]);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  const ov = data.overview;
  const list = campaignsData.campaigns;
  const threads = threadsData.threads;

  const attempted = ov.successfulMessages + ov.failedMessages + ov.blockedByPolicy;
  const deliveryRate = attempted ? Math.round((ov.successfulMessages / attempted) * 100) : 0;
  const matchRate = ov.totalComments ? Math.round((ov.matchedComments / ov.totalComments) * 100) : 0;

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Analytics</h1>
        <p>Covering ${esc(ov.rangeLabel.toLowerCase())}.</p>
      </div>
      ${rangeBar(state.range)}
    </div>

    <div class="stat-grid">
      ${statCard({ label: 'Delivery rate', value: deliveryRate, accent: deliveryRate >= 90 ? 'ok' : 'warn', note: `${num(ov.successfulMessages)} of ${num(attempted)} attempts` })}
      ${statCard({ label: 'Keyword match rate', value: matchRate, accent: 'brand', note: `${num(ov.matchedComments)} of ${num(ov.totalComments)} comments` })}
      ${statCard({ label: 'Conversations opened', value: threads.length, accent: 'info' })}
      ${statCard({ label: 'Rejected by Meta', value: ov.failedMessages, accent: ov.failedMessages ? 'danger' : '' })}
      ${statCard({ label: 'Not eligible', value: ov.blockedByPolicy, accent: ov.blockedByPolicy ? 'warn' : '' })}
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Comments and messages over time</h2></div>
      <div class="card-body">${lineChart(data.series, { height: 220 })}</div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Campaign comparison</h2></div>
      ${list.length === 0
        ? `<div class="card-body">${emptyState({ title: 'No campaigns yet', message: 'Create a campaign and its numbers will appear here beside the others.', icon: 'campaign' })}</div>`
        : `<div class="table-wrap"><table class="data">
            <thead><tr>
              <th>Campaign</th><th>Status</th>
              <th class="nowrap">Comments</th><th class="nowrap">Matched</th>
              <th class="nowrap">Match rate</th><th class="nowrap">Public</th>
              <th class="nowrap">DMs</th><th class="nowrap">Delivered</th>
              <th class="nowrap">Rejected</th><th class="nowrap">Not eligible</th>
            </tr></thead>
            <tbody>${list.map(c => {
              const s = c.stats;
              const rate = s.commentsReceived ? Math.round((s.keywordMatches / s.commentsReceived) * 100) : 0;
              return `
                <tr>
                  <td><a href="#/campaigns/${c.id}" class="strong">${esc(truncate(c.name, 36))}</a></td>
                  <td>${statusPill(c.status)}</td>
                  <td class="tabnum">${num(s.commentsReceived)}</td>
                  <td class="tabnum">${num(s.keywordMatches)}</td>
                  <td class="tabnum">${rate}%</td>
                  <td class="tabnum">${num(s.publicReplies)}</td>
                  <td class="tabnum">${num(s.privateReplies)}</td>
                  <td class="tabnum ok-text">${num(s.successfulMessages)}</td>
                  <td class="tabnum ${s.failedMessages ? 'danger-text' : 'muted'}">${num(s.failedMessages)}</td>
                  <td class="tabnum ${s.blockedByPolicy ? 'warn-text' : 'muted'}">${num(s.blockedByPolicy)}</td>
                </tr>`;
            }).join('')}</tbody></table></div>`}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Delivery outcomes</h2></div>
        <div class="card-body">
          ${data.delivery.length === 0
            ? `<p class="muted small">Nothing has been sent yet.</p>`
            : `<div class="table-wrap"><table class="data">
                <thead><tr><th>Type</th><th>Outcome</th><th class="nowrap">Count</th></tr></thead>
                <tbody>${data.delivery.map(d => `
                  <tr>
                    <td>${esc(d.message_type.replace(/_/g, ' '))}</td>
                    <td>${deliveryPill(d.status)}</td>
                    <td class="tabnum">${num(d.count)}</td>
                  </tr>`).join('')}</tbody></table></div>`}
          <p class="xs muted mt-2">
            “Not eligible” means Meta's rules blocked the message — an expired window, a comment older than 7 days,
            or a campaign that was paused before it sent.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Conversations</h2></div>
        <div class="card-body">
          ${threads.length === 0
            ? `<p class="muted small">No one has replied to a DM yet.</p>`
            : `<div class="table-wrap"><table class="data">
                <thead><tr><th>Viewer</th><th>Campaign</th><th>Stage</th><th class="nowrap">Last reply</th></tr></thead>
                <tbody>${threads.slice(0, 40).map(t => `
                  <tr>
                    <td class="nowrap">@${esc(t.username || t.user_id)}</td>
                    <td>${esc(truncate(t.campaign_name || '—', 24))}</td>
                    <td><span class="pill pill-muted">${esc(String(t.conversation_stage || '').replace(/_/g, ' '))}</span></td>
                    <td class="xs muted nowrap">${esc(timeAgo(t.last_inbound_time || t.updated_at))}</td>
                  </tr>`).join('')}</tbody></table></div>`}
        </div>
      </div>
    </div>`;

  bindRangeBar(container);
}
