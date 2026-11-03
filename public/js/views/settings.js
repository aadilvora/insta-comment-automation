/**
 * Settings — global safety switches and pacing.
 */

import { api } from '../api.js';
import {
  esc, num, fmtDateTime, loading, toastOk, toastErr, toastWarn, confirmDialog
} from '../ui.js';
import { setTopbar, refreshSystemStatus, refresh } from '../app.js';

export async function render(container) {
  setTopbar('Settings', 'Safety switches and pacing');
  container.innerHTML = loading('Loading settings…');

  let status, settingsData;
  try {
    [{ status }, settingsData] = await Promise.all([api.systemStatus(), api.settings()]);
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Settings</h1>
        <p>These apply to every campaign at once. Individual campaign statuses are set on each campaign.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Safety switches</h2></div>
      <div class="card-body stack">
        <div class="row-between wrap">
          <div style="flex:1;min-width:240px">
            <h3>Emergency stop</h3>
            <p class="small muted">
              Halts everything instantly and discards anything queued but unsent.
              Overrides every campaign, whatever its own status.
            </p>
          </div>
          <button class="btn ${status.emergencyStop ? 'btn-primary' : 'btn-danger'}" id="btn-emg">
            ${status.emergencyStop ? 'Release emergency stop' : 'Activate emergency stop'}
          </button>
        </div>

        <div class="divider"></div>

        <div class="row-between wrap">
          <div style="flex:1;min-width:240px">
            <h3>Pause all automation</h3>
            <p class="small muted">
              A softer hold. No new replies go out, but each campaign keeps its own status,
              so resuming puts everything back exactly as it was.
            </p>
          </div>
          <button class="btn ${status.automationPaused ? 'btn-primary' : ''}" id="btn-pause">
            ${status.automationPaused ? 'Resume automation' : 'Pause everything'}
          </button>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Pacing</h2></div>
      <div class="card-body">
        <div class="field" style="max-width:360px">
          <label class="lbl" for="s-delay">Delay between Meta API calls</label>
          <div class="row">
            <input type="number" id="s-delay" min="500" max="10000" step="100" value="${num(status.rateDelay)}">
            <span class="muted small">ms</span>
            <button class="btn btn-primary" id="btn-delay">Save</button>
          </div>
          <div class="hint">
            Slower is safer. Below 1000 ms risks tripping Meta's rate limits and anti-spam checks.
          </div>
        </div>
        <p class="small muted mt-2">${num(status.queueLength)} action(s) waiting in the queue right now.</p>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Compliance</h2></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Private reply window</dt><dd>${num(settingsData.maxCommentAgeDays)} days from the comment</dd>
          <dt>Follow-up window</dt><dd>24 hours from the viewer's last message</dd>
          <dt>Replies per comment</dt><dd>One private reply, enforced in the database</dd>
        </dl>
        <div class="field mt-2">
          <label class="lbl">Educational disclaimer</label>
          <textarea readonly style="min-height:80px">${esc(settingsData.disclaimer)}</textarea>
          <div class="hint">Set with SEBI_EDUCATIONAL_DISCLAIMER in your .env file.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Stored settings</h2></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Key</th><th>Value</th><th>Last changed</th></tr></thead>
          <tbody>
            ${settingsData.settings.map(s => `
              <tr>
                <td class="mono xs">${esc(s.key)}</td>
                <td class="mono xs">${esc(s.value)}</td>
                <td class="xs muted nowrap">${esc(fmtDateTime(s.updated_at))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  container.querySelector('#btn-emg').addEventListener('click', async () => {
    const turningOn = !status.emergencyStop;

    if (turningOn) {
      const ok = await confirmDialog({
        title: 'Activate emergency stop?',
        message: 'Every campaign stops sending immediately and queued actions are discarded. Settings are kept.',
        confirmLabel: 'Stop everything',
        danger: true
      });
      if (!ok) return;
    }

    try {
      const result = await api.emergencyStop(turningOn);
      result.emergencyStop
        ? toastWarn(`Emergency stop on.${result.queuedDropped ? ` ${result.queuedDropped} queued action(s) discarded.` : ''}`)
        : toastOk('Emergency stop released.');
      await refreshSystemStatus();
      refresh();
    } catch (err) {
      toastErr(err.message);
    }
  });

  container.querySelector('#btn-pause').addEventListener('click', async () => {
    try {
      const result = await api.globalPause(!status.automationPaused);
      result.automationPaused
        ? toastWarn('All automation paused. Campaign statuses are untouched.')
        : toastOk('Automation resumed. Running campaigns can send again.');
      await refreshSystemStatus();
      refresh();
    } catch (err) {
      toastErr(err.message);
    }
  });

  container.querySelector('#btn-delay').addEventListener('click', async () => {
    const value = Number(container.querySelector('#s-delay').value);
    if (!value || value < 500) {
      toastErr('Use 500 ms or more.');
      return;
    }
    try {
      await api.rateDelay(value);
      toastOk(`Delay set to ${num(value)} ms.`);
      refresh();
    } catch (err) {
      toastErr(err.message);
    }
  });
}
