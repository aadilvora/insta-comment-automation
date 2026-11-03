/**
 * Campaign controls shared by the Reel cards, the campaign list and the
 * campaign detail page, so a Start button behaves identically everywhere.
 */

import { api } from '../api.js';
import { toastOk, toastErr, toastWarn, confirmDialog, esc } from '../ui.js';
import { go, refresh, refreshSystemStatus } from '../app.js';

/**
 * Which controls make sense for a campaign in a given status.
 * Returns [{ action, label, kind }] in the order they should appear.
 */
export function controlsFor(status) {
  const s = String(status || 'DRAFT').toUpperCase();

  const start   = { action: 'start',   label: 'Start',   kind: 'btn-primary' };
  const pause   = { action: 'pause',   label: 'Pause',   kind: '' };
  const resume  = { action: 'resume',  label: 'Resume',  kind: 'btn-primary' };
  const stop    = { action: 'stop',    label: 'Stop',    kind: '' };
  const restart = { action: 'start',   label: 'Restart', kind: 'btn-primary' };

  switch (s) {
    case 'ACTIVE':  return [pause, stop];
    case 'PAUSED':  return [resume, stop];
    case 'STOPPED': return [restart];
    case 'ERROR':   return [restart, stop];
    default:        return [start, stop];
  }
}

const STATUS_FOR_ACTION = {
  start: 'ACTIVE',
  activate: 'ACTIVE',
  resume: 'ACTIVE',
  pause: 'PAUSED',
  stop: 'STOPPED',
  draft: 'DRAFT'
};

/**
 * Run a lifecycle action. Confirms the destructive ones, reports what actually
 * happened (including how many queued actions were dropped) and re-renders.
 */
export async function runAction(campaignId, action, { name = 'This campaign', onDone = null } = {}) {
  const target = STATUS_FOR_ACTION[action];
  if (!target) return;

  if (action === 'stop') {
    const ok = await confirmDialog({
      title: 'Stop this campaign?',
      message:
        `"${name}" will stop replying to new comments, and anything queued but not yet sent is discarded. ` +
        'All its settings and history are kept, so you can restart it later.',
      confirmLabel: 'Stop campaign',
      danger: true
    });
    if (!ok) return;
  }

  try {
    const result = await api.setStatus(campaignId, target);

    const messages = {
      ACTIVE: 'Campaign is running. New matching comments will be answered.',
      PAUSED: 'Campaign paused. No new replies will go out.',
      STOPPED: 'Campaign stopped.',
      DRAFT: 'Campaign moved back to draft.'
    };

    let msg = messages[target];
    if (result.queuedDropped) {
      msg += ` ${result.queuedDropped} queued action(s) were discarded.`;
    }

    target === 'ACTIVE' ? toastOk(msg) : toastWarn(msg);

    if (onDone) onDone(result);
    else refresh();

    refreshSystemStatus();
  } catch (err) {
    // A failed activation usually means the campaign is incomplete — say what's missing.
    if (err.data?.errors?.length) {
      toastErr(`${err.message}: ${err.data.errors.join(', ')}`, 'Cannot start this campaign');
    } else {
      toastErr(err.message);
    }
  }
}

export async function duplicateCampaign(campaignId, name) {
  try {
    const result = await api.duplicateCampaign(campaignId);
    toastOk(`Copied as "${result.campaign.name}". It's saved as a draft.`);
    go(`/campaigns/${result.campaign.id}/edit`);
  } catch (err) {
    toastErr(err.message);
  }
}

export async function resetCampaign(campaignId, name) {
  const ok = await confirmDialog({
    title: `Reset "${name}" back to zero?`,  // openModal escapes the title
    message:
      '<p>This clears <strong>this campaign\'s own records only</strong>: the comments it has ' +
      'processed, the messages it has sent, and its conversation threads. Every count on the ' +
      'dashboard returns to zero and the campaign behaves like a fresh one.</p>' +
      '<p>Your campaign settings and message wording are <strong>not</strong> touched, and no ' +
      'other campaign is affected.</p>' +
      '<p class="muted small"><strong>One thing a reset cannot do:</strong> Meta allows one ' +
      'private reply per comment, and that rule lives on Meta\'s side. A comment already replied ' +
      'to will still be refused. A <em>new</em> comment from the same person works normally — ' +
      'which it already did, because comments are deduplicated per comment, not per person.</p>' +
      '<p class="muted small">The activity log is kept as the record of what was actually sent.</p>',
    confirmLabel: 'Reset this campaign',
    danger: true,
    html: true
  });
  if (!ok) return false;

  try {
    const result = await api.resetCampaign(campaignId);
    const r = result.removed || {};
    toastOk(
      `Reset "${result.campaign}". Cleared ${r.processedComments || 0} comment(s) and ` +
      `${r.outboundMessages || 0} message record(s).`
    );
    return true;
  } catch (err) {
    toastErr(err.message);
    return false;
  }
}

export async function deleteCampaign(campaignId, name) {
  const ok = await confirmDialog({
    title: 'Delete this campaign?',
    message:
      `"${name}" will be removed permanently, along with its settings and message wording. ` +
      'Past activity logs are kept. This cannot be undone.',
    confirmLabel: 'Delete permanently',
    danger: true
  });
  if (!ok) return false;

  try {
    await api.deleteCampaign(campaignId);
    toastOk('Campaign deleted.');
    return true;
  } catch (err) {
    toastErr(err.message);
    return false;
  }
}

/**
 * Render the control buttons for a campaign.
 * Buttons carry data-* attributes that `bindControls` turns into handlers.
 */
export function controlButtons(campaign, { size = 'btn-sm', showEdit = true, showMore = true } = {}) {
  const controls = controlsFor(campaign.status)
    .map(c => `
      <button class="btn ${size} ${c.kind}"
              data-campaign-action="${c.action}"
              data-campaign-id="${campaign.id}"
              data-campaign-name="${esc(campaign.name)}">${esc(c.label)}</button>`)
    .join('');

  const edit = showEdit
    ? `<a class="btn ${size}" href="#/campaigns/${campaign.id}/edit">Edit</a>`
    : '';

  const more = showMore
    ? `<a class="btn ${size}" href="#/campaigns/${campaign.id}">Activity</a>
       <button class="btn ${size}" data-campaign-action="duplicate"
               data-campaign-id="${campaign.id}"
               data-campaign-name="${esc(campaign.name)}">Duplicate</button>
       <button class="btn ${size}" data-campaign-action="reset"
               title="Clear this campaign's comments, messages and threads so its counts start from zero"
               data-campaign-id="${campaign.id}"
               data-campaign-name="${esc(campaign.name)}">Reset</button>`
    : '';

  return controls + edit + more;
}

/**
 * Wire every [data-campaign-action] inside `root`. Safe to call repeatedly.
 */
export function bindControls(root, { onDone = null } = {}) {
  root.querySelectorAll('[data-campaign-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.preventDefault();
      const id = btn.dataset.campaignId;
      const name = btn.dataset.campaignName || 'This campaign';
      const action = btn.dataset.campaignAction;

      btn.disabled = true;

      try {
        if (action === 'duplicate') {
          await duplicateCampaign(id, name);
        } else if (action === 'reset') {
          const didReset = await resetCampaign(id, name);
          if (didReset) (onDone ? onDone() : refresh());
        } else if (action === 'delete') {
          const removed = await deleteCampaign(id, name);
          if (removed) (onDone ? onDone() : refresh());
        } else {
          await runAction(id, action, { name, onDone });
        }
      } finally {
        btn.disabled = false;
      }
    });
  });
}
