/**
 * Test Sandbox — fire a pretend comment or DM at your own campaigns to see
 * exactly what the automation would do, without touching Instagram.
 */

import { api } from '../api.js';
import { esc, loading, toastOk, toastErr, toastWarn } from '../ui.js';
import { setTopbar } from '../app.js';

export async function render(container) {
  setTopbar('Test Sandbox', 'Try your automation safely');
  container.innerHTML = loading('Loading…');

  let campaignsData;
  try {
    campaignsData = await api.campaigns({ sort: 'recent' });
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  const running = campaignsData.campaigns.filter(c => c.status === 'ACTIVE');

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Test Sandbox</h1>
        <p>Send a pretend comment through the real matching, policy and logging path.</p>
      </div>
    </div>

    <div class="banner banner-info">
      <div class="banner-text">
        Messages here are <strong>simulated by default</strong> — nothing is sent to Instagram.
        Results still appear in your stats and logs, so you can clear them later if you want clean numbers.
      </div>
    </div>

    ${running.length === 0 ? `
      <div class="banner banner-warn">
        <div class="banner-text">
          No campaign is running, so a test comment won't match anything.
          Start a campaign first to see the full flow.
        </div>
        <a class="btn btn-sm" href="#/campaigns">Campaigns</a>
      </div>` : ''}

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Simulate a comment</h2></div>
        <div class="card-body">
          <div class="field">
            <label class="lbl" for="s-post">On which post</label>
            <select id="s-post">
              ${campaignsData.campaigns.map(c => `
                <option value="${esc(c.post_id)}">${esc(c.name)} — ${esc(c.post_id)}</option>`).join('')
                || '<option value="">No campaigns yet</option>'}
            </select>
          </div>
          <div class="field">
            <label class="lbl" for="s-user">From username</label>
            <input type="text" id="s-user" value="test_investor">
          </div>
          <div class="field">
            <label class="lbl" for="s-text">Comment text</label>
            <textarea id="s-text" style="min-height:80px">Please send me the REPORT</textarea>
            <div class="hint">Include one of the campaign's keywords to trigger a reply.</div>
          </div>
          <label class="check mb-2">
            <input type="checkbox" id="s-real">
            <span>Actually call Meta (will fail — a made-up comment ID doesn't exist on Instagram)</span>
          </label>
          <button class="btn btn-primary btn-block" id="btn-sim-comment">Send test comment</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Simulate a DM reply</h2></div>
        <div class="card-body">
          <p class="small muted mb-2">
            Run the comment test first — this stands in for the viewer replying to the DM it sent.
          </p>
          <div class="field">
            <label class="lbl" for="d-user">From username</label>
            <input type="text" id="d-user" value="test_investor">
          </div>
          <div class="field">
            <label class="lbl" for="d-text">Their message</label>
            <input type="text" id="d-text" value="DONE">
            <div class="hint">Try STOP to see the opt-out path.</div>
          </div>
          <button class="btn btn-primary btn-block" id="btn-sim-dm">Send test reply</button>
        </div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-head"><h2>Result</h2></div>
      <div class="card-body" id="sim-result">
        <p class="muted small">Run a test and the outcome shows up here.</p>
      </div>
    </div>`;

  const show = (title, result) => {
    container.querySelector('#sim-result').innerHTML = `
      <h3 class="mb-1">${esc(title)}</h3>
      <pre class="mono" style="background:var(--surface-sunken);padding:.9rem;border-radius:var(--r);
           overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0">${esc(JSON.stringify(result, null, 2))}</pre>
      <p class="xs muted mt-2">Open <a href="#/logs">Activity Logs</a> to see every step this produced.</p>`;
  };

  container.querySelector('#btn-sim-comment').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const result = await api.simulateComment({
        postId: container.querySelector('#s-post').value,
        username: container.querySelector('#s-user').value.trim() || 'test_investor',
        commentText: container.querySelector('#s-text').value,
        mock: !container.querySelector('#s-real').checked
      });

      show('Comment simulation', result.result);

      const r = result.result;
      if (r.matched === false) toastWarn('No campaign matched that comment.');
      else if (r.skipped) toastWarn(`Skipped: ${String(r.reason || '').replace(/_/g, ' ').toLowerCase()}`);
      else if (r.success) toastOk(`Public reply: ${r.publicReplyStatus} · DM: ${r.privateReplyStatus}`);
    } catch (err) {
      toastErr(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('#btn-sim-dm').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const result = await api.simulateDm({
        username: container.querySelector('#d-user').value.trim() || 'test_investor',
        messageText: container.querySelector('#d-text').value,
        mock: true
      });

      show('DM simulation', result.result);

      const r = result.result;
      if (r.optedOut) toastOk('Opt-out handled — this viewer will get nothing further.');
      else if (r.delivered) toastOk(`Delivered: ${r.type}`);
      else if (r.skipped) toastWarn(`Skipped: ${String(r.reason || '').replace(/_/g, ' ').toLowerCase()}`);
      else toastWarn('Nothing was sent — check the result below.');
    } catch (err) {
      toastErr(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}
