/**
 * Instagram Connection — what Meta sees, and what still needs setting up.
 */

import { api } from '../api.js';
import { esc, num, loading, toastOk, toastErr, toastWarn } from '../ui.js';
import { setTopbar, refreshSystemStatus, refresh } from '../app.js';

function check(ok, yes, no) {
  return ok
    ? `<span class="pill pill-SUCCESS"><span class="pill-dot"></span>${esc(yes)}</span>`
    : `<span class="pill pill-FAILURE"><span class="pill-dot"></span>${esc(no)}</span>`;
}

export async function render(container) {
  setTopbar('Instagram Connection', 'Meta Graph API status');
  container.innerHTML = loading('Checking your connection…');

  let status;
  try {
    ({ status } = await api.systemStatus());
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  const meta = status.metaStatus || {};
  const acct = status.account || {};
  const connected = Boolean(meta.connected);

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Instagram Connection</h1>
        <p>Everything runs through the official Meta Graph API ${esc(acct.apiVersion || '')}.</p>
      </div>
      <button class="btn" id="btn-recheck">Check again</button>
    </div>

    ${connected
      ? `<div class="banner banner-ok">
          <div class="banner-text">
            <strong>Connected.</strong> ${esc(meta.details?.name ? `Signed in as ${meta.details.name}.` : 'Your access token is valid.')}
          </div>
        </div>`
      : `<div class="banner banner-danger">
          <div class="banner-text">
            <strong>Not connected.</strong> ${esc(meta.message || 'Add a valid access token to your .env file.')}
          </div>
        </div>`}

    <div class="grid-2 mb-3">
      <div class="card">
        <div class="card-head"><h2>Credentials</h2></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Access token</dt><dd>${check(acct.tokenConfigured, 'Configured', 'Missing')}</dd>
            <dt>App secret</dt><dd>${check(acct.appSecretConfigured, 'Configured', 'Missing')}</dd>
            <dt>Instagram account ID</dt>
            <dd class="mono xs">${esc(acct.instagramAccountId || '—')}</dd>
            <dt>Facebook Page ID</dt>
            <dd class="mono xs">${esc(acct.facebookPageId || '—')}</dd>
            <dt>API version</dt><dd>${esc(acct.apiVersion || '—')}</dd>
          </dl>
          <p class="xs muted mt-2">
            These live in your <span class="mono">.env</span> file and are never shown in full or written to logs.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Webhook</h2></div>
        <div class="card-body">
          <div class="field">
            <label class="lbl">Callback URL to give Meta</label>
            <div class="row">
              <input type="text" readonly value="${esc(acct.webhookUrl || '')}" id="hook-url">
              <button class="btn" id="btn-copy-hook">Copy</button>
            </div>
            <div class="hint">
              For Meta to reach a local server, expose it first (for example with ngrok) and register that public URL.
            </div>
          </div>
          <dl class="kv mt-2">
            <dt>Subscribe to</dt><dd><span class="mono xs">comments</span>, <span class="mono xs">messages</span></dd>
            <dt>Verify token</dt><dd>Set as <span class="mono xs">META_WEBHOOK_VERIFY_TOKEN</span></dd>
          </dl>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Live system</h2></div>
      <div class="card-body">
        <div class="stat-grid" style="margin:0">
          <div class="stat ${status.emergencyStop ? 'accent-danger' : 'accent-ok'}">
            <div class="stat-label">Emergency stop</div>
            <div class="stat-value" style="font-size:1.1rem">${status.emergencyStop ? 'ON' : 'Off'}</div>
          </div>
          <div class="stat ${status.automationPaused ? 'accent-warn' : 'accent-ok'}">
            <div class="stat-label">Global pause</div>
            <div class="stat-value" style="font-size:1.1rem">${status.automationPaused ? 'Paused' : 'Running'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Queued actions</div>
            <div class="stat-value">${num(status.queueLength)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Delay between calls</div>
            <div class="stat-value" style="font-size:1.1rem">${num(status.rateDelay)} ms</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>What Meta does and doesn't allow</h2></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Public comment reply</dt><dd>Allowed on any comment on your own media.</dd>
          <dt>Private reply to a comment</dt>
          <dd>One per comment, within 7 days of it being posted. A second one is refused.</dd>
          <dt>Further direct messages</dt>
          <dd>Only within 24 hours of the viewer's own last message to you.</dd>
          <dt>Checking a follow</dt>
          <dd>Only after the viewer messages you, and some regions never return it. There is no way to check at comment time.</dd>
        </dl>
        <p class="xs muted mt-2">
          This dashboard counts a refusal as “rejected by Meta” and a rule-blocked message as “not eligible”,
          so the numbers stay honest.
        </p>
      </div>
    </div>`;

  container.querySelector('#btn-recheck').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    await refreshSystemStatus();
    refresh();
  });

  container.querySelector('#btn-copy-hook').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(container.querySelector('#hook-url').value);
      toastOk('Webhook URL copied.');
    } catch (e) {
      toastWarn('Could not copy — select the text manually.');
    }
  });
}
