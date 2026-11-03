/**
 * Message Templates — a reusable library of wording, so messages can be
 * changed without touching source code.
 */

import { api } from '../api.js';
import {
  esc, num, truncate, fmtDateTime, emptyState, loading,
  toastOk, toastErr, openModal, confirmDialog
} from '../ui.js';
import { setTopbar, refresh } from '../app.js';

const TYPE_LABEL = {
  public_reply: 'Public reply',
  private_reply: 'First DM',
  follow_up: 'Follow-up',
  reminder: 'Follow reminder',
  report: 'Report delivery'
};

function editor(template = null) {
  const t = template || { name: '', message_type: 'private_reply', body: '', notes: '' };

  openModal({
    title: template ? 'Edit template' : 'New message template',
    subtitle: 'Use {{first_name}} and {{username}} to personalise it.',
    wide: true,
    body: `
      <div class="field-row">
        <div class="field">
          <label class="lbl" for="t-name">Template name</label>
          <input type="text" id="t-name" value="${esc(t.name)}" placeholder="IPO report delivery">
        </div>
        <div class="field">
          <label class="lbl" for="t-type">Used for</label>
          <select id="t-type">
            ${Object.entries(TYPE_LABEL).map(([k, v]) => `
              <option value="${k}" ${t.message_type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label class="lbl" for="t-body">Message</label>
        <textarea id="t-body" style="min-height:140px">${esc(t.body)}</textarea>
        <div class="hint" id="t-count">${num((t.body || '').length)} characters</div>
      </div>
      <div class="field">
        <label class="lbl" for="t-notes">Note to yourself</label>
        <input type="text" id="t-notes" value="${esc(t.notes || '')}" placeholder="When to use this one">
      </div>`,
    footer: `
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>${template ? 'Save changes' : 'Create template'}</button>`,
    onMount: (modal, close) => {
      const body = modal.querySelector('#t-body');
      body.addEventListener('input', () => {
        modal.querySelector('#t-count').textContent = `${num(body.value.length)} characters`;
      });

      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelector('[data-save]').onclick = async () => {
        const data = {
          name: modal.querySelector('#t-name').value.trim(),
          message_type: modal.querySelector('#t-type').value,
          body: body.value,
          notes: modal.querySelector('#t-notes').value.trim() || null
        };

        if (!data.name || !data.body.trim()) {
          toastErr('A template needs a name and a message.');
          return;
        }

        try {
          template ? await api.updateTemplate(template.id, data) : await api.createTemplate(data);
          close();
          toastOk(template ? 'Template updated.' : 'Template saved.');
          refresh();
        } catch (err) {
          toastErr(err.message);
        }
      };
      modal.querySelector('#t-name').focus();
    }
  });
}

export async function render(container) {
  setTopbar('Message Templates', 'Reusable wording for your campaigns');
  container.innerHTML = loading('Loading templates…');

  let data;
  try {
    data = await api.templates();
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <h1>Message Templates</h1>
        <p>Save wording you reuse across campaigns. Editing a template here doesn't change campaigns already using that text.</p>
      </div>
      <button class="btn btn-primary" id="btn-new">New template</button>
    </div>

    <div class="banner banner-info">
      <div class="banner-text">
        <strong>{{first_name}}</strong> and <strong>{{username}}</strong> are filled in automatically.
        Anything else in double braces is left as-is.
      </div>
    </div>

    ${data.templates.length === 0
      ? `<div class="card">${emptyState({
          title: 'No templates yet',
          message: 'Save the messages you use often — an IPO report delivery, a follow reminder — and reuse them across Reels.',
          actionLabel: 'Create your first template',
          actionAttr: 'id="btn-new-empty"',
          icon: 'message'
        })}</div>`
      : `<div class="post-grid">
          ${data.templates.map(t => `
            <div class="card">
              <div class="card-head">
                <div style="flex:1;min-width:0">
                  <h3>${esc(t.name)}</h3>
                  <span class="pill pill-muted">${esc(TYPE_LABEL[t.message_type] || t.message_type)}</span>
                </div>
              </div>
              <div class="card-body">
                <div class="preview-phone" style="padding:.7rem">
                  <div class="bubble bubble-us" style="max-width:100%;margin:0">${esc(truncate(t.body, 260))}</div>
                </div>
                ${t.notes ? `<p class="small muted mt-2">${esc(t.notes)}</p>` : ''}
                <p class="xs faint mt-2">${num(t.body.length)} characters · edited ${esc(fmtDateTime(t.updated_at))}</p>
              </div>
              <div class="card-foot">
                <div class="btn-group">
                  <button class="btn btn-sm" data-copy="${t.id}">Copy text</button>
                  <button class="btn btn-sm" data-edit="${t.id}">Edit</button>
                  <button class="btn btn-sm" data-del="${t.id}" data-name="${esc(t.name)}">Delete</button>
                </div>
              </div>
            </div>`).join('')}
        </div>`}`;

  container.querySelector('#btn-new')?.addEventListener('click', () => editor());
  container.querySelector('#btn-new-empty')?.addEventListener('click', () => editor());

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      editor(data.templates.find(t => String(t.id) === btn.dataset.edit));
    });
  });

  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = data.templates.find(x => String(x.id) === btn.dataset.copy);
      try {
        await navigator.clipboard.writeText(t.body);
        toastOk('Message copied. Paste it into a campaign.');
      } catch (e) {
        toastErr('Your browser blocked the clipboard. Select the text manually.');
      }
    });
  });

  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete this template?',
        message: `"${btn.dataset.name}" will be removed. Campaigns already using this wording keep their text.`,
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) return;
      try {
        await api.deleteTemplate(btn.dataset.del);
        toastOk('Template deleted.');
        refresh();
      } catch (err) {
        toastErr(err.message);
      }
    });
  });
}
