/**
 * Campaign wizard / editor.
 * The same screen creates a campaign step by step and edits an existing one —
 * every step stays reachable afterwards, and saving never changes whether the
 * campaign is running.
 */

import { api } from '../api.js';
import {
  esc, num, truncate, emptyState, loading, toastOk, toastErr, toastWarn,
  confirmDialog, statusPill, openModal, closeModal
} from '../ui.js';
import { setTopbar, go, refreshSystemStatus } from '../app.js';

const STEPS = [
  { key: 'post',     title: 'Choose the Reel',   sub: 'Which post to watch' },
  { key: 'name',     title: 'Name it',           sub: 'For your own reference' },
  { key: 'keywords', title: 'Trigger keywords',  sub: 'What starts the reply' },
  { key: 'public',   title: 'Public reply',      sub: 'Shown under the comment' },
  { key: 'dm',       title: 'First DM',          sub: 'The one Meta allows' },
  { key: 'followup', title: 'Follow-up',         sub: 'Only after they reply' },
  { key: 'preview',  title: 'Preview',           sub: 'Read it end to end' },
  { key: 'save',     title: 'Save or start',     sub: 'Draft, or go live' }
];

const VARIABLES = [
  { token: '{{first_name}}', label: 'First name' },
  { token: '{{username}}',   label: '@username' }
];

// Meta's own limits, so the editor can warn before a message is ever sent.
const LIMITS = {
  public_reply_text: 2200,
  initial_private_reply_text: 1000,
  follow_up_text: 1000,
  follower_reminder_text: 1000,
  report_text: 1000
};

let form = null;
let posts = [];
let step = 0;
let editingId = null;
let dirty = false;

function blank() {
  return {
    name: '',
    post_id: '',
    keywords: [],
    match_type: 'contains',
    public_reply_enabled: 1,
    public_reply_text: 'Thanks @{{username}}! Just sent you a DM with the full breakdown. 📩',
    initial_private_reply_text:
      'Hi {{first_name}}! Thanks for commenting. Reply DONE and I\'ll send you the full research report.',
    follow_up_enabled: 1,
    follow_up_text: '',
    follower_reminder_text: '',
    report_text: ''
  };
}

/* ---------------- step rendering ---------------- */

function charCount(field) {
  const used = (form[field] || '').length;
  const max = LIMITS[field];
  const over = used > max;
  return `<div class="hint ${over ? 'danger-text' : ''}">${num(used)} / ${num(max)} characters${over ? ' — too long for Meta, trim it' : ''}</div>`;
}

function varButtons(field) {
  return `
    <div class="row wrap mt-1">
      <span class="xs muted">Insert:</span>
      ${VARIABLES.map(v => `
        <button type="button" class="btn btn-sm" data-var="${esc(v.token)}" data-target="${field}">
          ${esc(v.label)}
        </button>`).join('')}
    </div>`;
}

function stepPost() {
  if (posts.length === 0) {
    return emptyState({
      title: 'No posts to choose from',
      message: 'Sync your Instagram account or add a post by hand first, then come back and build the campaign.',
      actionLabel: 'Go to Posts & Reels',
      actionAttr: 'data-go="/posts"',
      icon: 'instagram'
    });
  }

  return `
    <p class="muted mb-2">Pick the post or Reel this campaign should watch. One campaign watches one post.</p>
    <div class="field">
      <input type="search" id="post-filter" placeholder="Search your posts…">
    </div>
    <div id="post-options" class="stack" style="gap:.5rem;max-height:420px;overflow:auto">
      ${posts.map(p => `
        <label class="check" style="border:1px solid ${form.post_id === p.post_id ? 'var(--brand)' : 'var(--border)'};
               border-radius:var(--r);padding:.7rem;background:${form.post_id === p.post_id ? 'var(--brand-tint)' : 'var(--surface)'}"
               data-post-option data-caption="${esc((p.caption || p.post_id).toLowerCase())}">
          <input type="radio" name="post" value="${esc(p.post_id)}" ${form.post_id === p.post_id ? 'checked' : ''}>
          <span style="flex:1;min-width:0">
            <span class="strong">${esc(truncate(p.caption || 'Untitled post', 70))}</span>
            <span class="xs muted" style="display:block">
              ${esc(p.post_id)}${p.campaignCount ? ` · ${p.campaignCount} existing campaign(s)` : ''}
            </span>
          </span>
        </label>`).join('')}
    </div>`;
}

function stepName() {
  return `
    <p class="muted mb-2">A name only you see. Something like “Jio IPO report — Oct Reel”.</p>
    <div class="field">
      <label class="lbl" for="f-name">Campaign name</label>
      <input type="text" id="f-name" data-field="name" value="${esc(form.name)}" placeholder="Jio IPO report">
    </div>`;
}

function stepKeywords() {
  return `
    <p class="muted mb-2">When a comment contains one of these words, the automation replies. Case doesn't matter.</p>

    <div class="field">
      <label class="lbl" for="kw-input">Add a keyword</label>
      <div class="row">
        <input type="text" id="kw-input" placeholder="e.g. REPORT" style="flex:1">
        <button type="button" class="btn btn-primary" id="kw-add">Add</button>
      </div>
      <div class="hint">Press Enter to add. Use the words your viewers actually type.</div>
    </div>

    <div class="field">
      <label class="lbl">Current keywords</label>
      <div class="chips" id="kw-chips">
        ${form.keywords.length === 0
          ? '<span class="muted small">None yet — add at least one.</span>'
          : form.keywords.map((k, i) => `
              <span class="chip">${esc(k)}<button type="button" data-kw-remove="${i}" aria-label="Remove">&times;</button></span>`).join('')}
      </div>
    </div>

    <div class="field">
      <label class="lbl" for="f-match">Matching</label>
      <select id="f-match" data-field="match_type">
        <option value="contains" ${form.match_type === 'contains' ? 'selected' : ''}>Comment contains the keyword</option>
        <option value="exact" ${form.match_type === 'exact' ? 'selected' : ''}>Comment is exactly the keyword</option>
      </select>
      <div class="hint">“Contains” catches “send me the report please”. “Exact” only matches a one-word comment.</div>
    </div>`;
}

function stepPublic() {
  return `
    <p class="muted mb-2">Posted as a public reply under their comment, so other viewers see you responded.</p>

    <label class="check mb-2">
      <input type="checkbox" data-field="public_reply_enabled" ${form.public_reply_enabled ? 'checked' : ''}>
      <span>Reply publicly under the comment</span>
    </label>

    <div class="field ${form.public_reply_enabled ? '' : 'hidden'}" id="public-wrap">
      <label class="lbl" for="f-public">Public reply</label>
      <textarea id="f-public" data-field="public_reply_text">${esc(form.public_reply_text)}</textarea>
      ${charCount('public_reply_text')}
      ${varButtons('public_reply_text')}
    </div>`;
}

function stepDm() {
  return `
    <div class="banner banner-info">
      <div class="banner-text">
        <strong>Meta allows exactly one private reply per comment</strong>, and only within 7 days of that comment.
        Everything after this needs the viewer to reply to you first.
      </div>
    </div>

    <div class="field">
      <label class="lbl" for="f-dm">First direct message</label>
      <textarea id="f-dm" data-field="initial_private_reply_text" style="min-height:120px">${esc(form.initial_private_reply_text)}</textarea>
      ${charCount('initial_private_reply_text')}
      ${varButtons('initial_private_reply_text')}
      <div class="hint">Ask them to reply with a word like DONE — their reply is what opens the 24-hour window for anything else.</div>
    </div>`;
}

function stepFollowup() {
  return `
    <div class="banner banner-warn">
      <div class="banner-text">
        These only send <strong>after the viewer replies to your DM</strong>, inside Meta's 24-hour messaging window.
        If they never reply, nothing below is sent — that is Meta's rule, not a setting.
      </div>
    </div>

    <label class="check mb-2">
      <input type="checkbox" data-field="follow_up_enabled" ${form.follow_up_enabled ? 'checked' : ''}>
      <span>Send follow-up messages once they reply</span>
    </label>

    <div id="followup-wrap" class="${form.follow_up_enabled ? '' : 'hidden'}">
      <div class="field">
        <label class="lbl" for="f-report">The report message</label>
        <textarea id="f-report" data-field="report_text">${esc(form.report_text)}</textarea>
        ${charCount('report_text')}
        ${varButtons('report_text')}
        <div class="hint">Sent once they reply and the follow check passes. Put your link here.</div>
      </div>

      <div class="field">
        <label class="lbl" for="f-reminder">If they haven't followed yet</label>
        <textarea id="f-reminder" data-field="follower_reminder_text">${esc(form.follower_reminder_text)}</textarea>
        ${charCount('follower_reminder_text')}
        ${varButtons('follower_reminder_text')}
        <div class="hint">Sent at most once, politely. Meta only lets us check a follow after they message you.</div>
      </div>

      <div class="field">
        <label class="lbl" for="f-followup">Fallback message</label>
        <textarea id="f-followup" data-field="follow_up_text">${esc(form.follow_up_text)}</textarea>
        ${charCount('follow_up_text')}
        <div class="hint">Used when no report message is set.</div>
      </div>
    </div>`;
}

function preview(text) {
  return esc(String(text || '').replace(/\{\{\s*first_name\s*\}\}/g, 'Rahul').replace(/\{\{\s*username\s*\}\}/g, 'rahul_invests'));
}

function stepPreview() {
  const post = posts.find(p => p.post_id === form.post_id);
  const issues = validate();

  return `
    <p class="muted mb-2">This is the whole journey, with a sample viewer called Rahul.</p>

    ${issues.length ? `
      <div class="banner banner-warn">
        <div class="banner-text"><strong>Before this can run:</strong> ${esc(issues.join(', '))}.</div>
      </div>` : `
      <div class="banner banner-ok">
        <div class="banner-text">Everything needed is filled in. You can start this campaign.</div>
      </div>`}

    <dl class="kv mb-3">
      <dt>Watching</dt><dd>${esc(truncate(post?.caption || form.post_id || 'No post selected', 60))}</dd>
      <dt>Triggers on</dt>
      <dd><div class="chips">${form.keywords.map(k => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted">No keywords</span>'}</div></dd>
    </dl>

    <div class="preview-phone">
      <div class="bubble-label">On the Reel</div>
      <div class="bubble bubble-them">${esc(form.keywords[0] || 'REPORT')} please! 🙏</div>
      ${form.public_reply_enabled && form.public_reply_text
        ? `<div class="bubble bubble-us">${preview(form.public_reply_text)}</div>`
        : '<p class="xs muted mb-2">No public reply — nothing is posted under the comment.</p>'}

      <div class="divider"></div>
      <div class="bubble-label">In direct messages</div>
      <div class="bubble bubble-us">${preview(form.initial_private_reply_text) || '<span class="muted">No message set</span>'}</div>

      ${form.follow_up_enabled ? `
        <div class="bubble bubble-them">DONE</div>
        ${form.report_text || form.follow_up_text
          ? `<div class="bubble bubble-us">${preview(form.report_text || form.follow_up_text)}</div>`
          : '<p class="xs muted">No report message set yet.</p>'}
        ${form.follower_reminder_text ? `
          <div class="bubble-label mt-2">If they haven't followed</div>
          <div class="bubble bubble-us">${preview(form.follower_reminder_text)}</div>` : ''}
      ` : '<p class="xs muted mt-2">Follow-up is off — only the first DM is sent.</p>'}
    </div>`;
}

function stepSave() {
  const issues = validate();

  return `
    <p class="muted mb-3">Saving keeps everything in the database. Nothing is lost when you close the dashboard or restart the app.</p>

    <div class="stack">
      <div class="card">
        <div class="card-body">
          <h3 class="mb-1">Save as a draft</h3>
          <p class="small muted mb-2">Keeps your work safe. Nothing is sent until you start it.</p>
          <button class="btn btn-block" id="btn-save-draft">Save draft</button>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h3 class="mb-1">Save and start</h3>
          <p class="small muted mb-2">
            ${issues.length
              ? 'Fill in the missing pieces first: ' + esc(issues.join(', ')) + '.'
              : 'The automation begins answering new matching comments right away.'}
          </p>
          <button class="btn btn-primary btn-block" id="btn-save-start" ${issues.length ? 'disabled' : ''}>
            Save and start automation
          </button>
        </div>
      </div>
    </div>`;
}

const RENDERERS = {
  post: stepPost,
  name: stepName,
  keywords: stepKeywords,
  public: stepPublic,
  dm: stepDm,
  followup: stepFollowup,
  preview: stepPreview,
  save: stepSave
};

/* ---------------- validation ---------------- */

function validate() {
  const issues = [];
  if (!form.post_id) issues.push('choose a post');
  if (!form.name.trim()) issues.push('add a name');
  if (form.keywords.length === 0) issues.push('add a keyword');
  if (!form.initial_private_reply_text.trim()) issues.push('write the first DM');
  if (form.public_reply_enabled && !form.public_reply_text.trim()) issues.push('write the public reply');

  for (const [field, max] of Object.entries(LIMITS)) {
    if ((form[field] || '').length > max) {
      issues.push(`shorten the ${field.replace(/_/g, ' ')}`);
    }
  }
  return issues;
}

function stepDone(key) {
  switch (key) {
    case 'post':     return Boolean(form.post_id);
    case 'name':     return Boolean(form.name.trim());
    case 'keywords': return form.keywords.length > 0;
    case 'public':   return !form.public_reply_enabled || Boolean(form.public_reply_text.trim());
    case 'dm':       return Boolean(form.initial_private_reply_text.trim());
    case 'followup': return !form.follow_up_enabled || Boolean((form.report_text || form.follow_up_text || '').trim());
    default:         return false;
  }
}

/* ---------------- persistence ---------------- */

function payload() {
  return {
    name: form.name.trim(),
    post_id: form.post_id,
    keywords: form.keywords,
    match_type: form.match_type,
    public_reply_enabled: form.public_reply_enabled ? 1 : 0,
    public_reply_text: form.public_reply_text,
    initial_private_reply_text: form.initial_private_reply_text,
    follow_up_enabled: form.follow_up_enabled ? 1 : 0,
    follow_up_text: form.follow_up_text,
    follower_reminder_text: form.follower_reminder_text,
    report_text: form.report_text
  };
}

async function save({ activate = false } = {}) {
  if (!form.name.trim() || !form.post_id) {
    toastErr('A campaign needs a name and a post before it can be saved.');
    return null;
  }

  try {
    let saved;
    if (editingId) {
      const result = await api.updateCampaign(editingId, payload());
      saved = result.campaign;
    } else {
      const result = await api.createCampaign({ ...payload(), status: 'DRAFT' });
      saved = result.campaign;
      editingId = saved.id;
    }

    dirty = false;

    if (activate) {
      try {
        await api.setStatus(saved.id, 'ACTIVE');
        toastOk('Campaign saved and running. New matching comments will be answered.');
      } catch (err) {
        const detail = err.data?.errors?.length ? `: ${err.data.errors.join(', ')}` : '';
        toastWarn(`Saved as a draft, but it could not start${detail}`, 'Not started');
      }
    } else {
      toastOk(editingId ? 'Changes saved. The campaign status is unchanged.' : 'Saved as a draft.');
    }

    refreshSystemStatus();
    return saved;
  } catch (err) {
    toastErr(err.message);
    return null;
  }
}

/* ---------------- main render ---------------- */

export async function render(container, { params }) {
  editingId = params[0] || null;
  dirty = false;

  const query = Object.fromEntries(new URLSearchParams((window.location.hash.split('?')[1] || '')));

  container.innerHTML = loading('Loading…');

  try {
    const postsData = await api.posts('all');
    posts = postsData.posts;

    if (editingId) {
      const { campaign } = await api.campaign(editingId);
      form = {
        name: campaign.name || '',
        post_id: campaign.post_id || '',
        keywords: campaign.keywordList || [],
        match_type: campaign.match_type || 'contains',
        public_reply_enabled: campaign.public_reply_enabled ? 1 : 0,
        public_reply_text: campaign.public_reply_text || '',
        initial_private_reply_text: campaign.initial_private_reply_text || '',
        follow_up_enabled: campaign.follow_up_enabled ? 1 : 0,
        follow_up_text: campaign.follow_up_text || '',
        follower_reminder_text: campaign.follower_reminder_text || '',
        report_text: campaign.report_text || '',
        status: campaign.status
      };
      step = 0;
      setTopbar(`Edit: ${campaign.name}`, 'Changes save without changing whether it runs');
    } else {
      form = blank();
      if (query.post) form.post_id = query.post;
      step = query.post ? 1 : 0;
      setTopbar('New campaign', 'Eight short steps');
    }
  } catch (err) {
    container.innerHTML = `<div class="banner banner-danger"><div class="banner-text">${esc(err.message)}</div></div>`;
    return;
  }

  paint(container);
}

function paint(container) {
  const current = STEPS[step];
  const isEdit = Boolean(editingId);

  container.innerHTML = `
    <div class="page-head">
      <div class="page-head-text">
        <div class="row wrap mb-1">
          <a href="#/campaigns" class="small muted">&larr; All campaigns</a>
        </div>
        <h1>${isEdit ? esc(form.name || 'Edit campaign') : 'New campaign'}</h1>
        <p>${isEdit
          ? `Status: ${form.status ? STATUS_TEXT(form.status) : ''} — saving edits never starts or stops a campaign.`
          : 'Your work is saved only when you press save, so nothing goes live by accident.'}</p>
      </div>
      <div class="btn-group">
        <button class="btn" id="btn-quick-save">Save${isEdit ? '' : ' draft'}</button>
        ${isEdit ? `<a class="btn" href="#/campaigns/${editingId}">View activity</a>` : ''}
      </div>
    </div>

    <div class="wizard">
      <div class="wizard-steps">
        ${STEPS.map((s, i) => `
          <div class="wizard-step ${i === step ? 'active' : ''} ${stepDone(s.key) ? 'done' : ''}" data-step="${i}">
            <div class="wizard-num">${stepDone(s.key) ? '✓' : i + 1}</div>
            <div class="wizard-step-text">
              <div class="wizard-step-title">${esc(s.title)}</div>
              <div class="wizard-step-sub">${esc(s.sub)}</div>
            </div>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-head">
          <h2>${esc(current.title)}</h2>
          <span class="xs muted">Step ${step + 1} of ${STEPS.length}</span>
        </div>
        <div class="card-body" id="step-body">${RENDERERS[current.key]()}</div>
        <div class="card-foot">
          <div class="row-between">
            <button class="btn" id="btn-prev" ${step === 0 ? 'disabled' : ''}>Back</button>
            <button class="btn btn-primary" id="btn-next" ${step === STEPS.length - 1 ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      </div>
    </div>`;

  bindStep(container);
}

function STATUS_TEXT(status) {
  const map = { ACTIVE: 'running', PAUSED: 'paused', DRAFT: 'a draft', STOPPED: 'stopped', ERROR: 'in error' };
  return map[status] || status.toLowerCase();
}

/* ---------------- event wiring ---------------- */

function bindStep(container) {
  // Step navigation
  container.querySelectorAll('[data-step]').forEach(el => {
    el.addEventListener('click', () => {
      step = Number(el.dataset.step);
      paint(container);
    });
  });

  container.querySelector('#btn-prev').addEventListener('click', () => {
    if (step > 0) { step -= 1; paint(container); }
  });
  container.querySelector('#btn-next').addEventListener('click', () => {
    if (step < STEPS.length - 1) { step += 1; paint(container); }
  });

  container.querySelector('#btn-quick-save').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const saved = await save();
    e.currentTarget.disabled = false;
    if (saved && !editingId) go(`/campaigns/${saved.id}/edit`);
  });

  // Plain fields
  container.querySelectorAll('[data-field]').forEach(input => {
    const field = input.dataset.field;

    const handler = () => {
      form[field] = input.type === 'checkbox' ? (input.checked ? 1 : 0) : input.value;
      dirty = true;

      // Toggling a section shows or hides its fields without a full repaint.
      if (field === 'public_reply_enabled') {
        container.querySelector('#public-wrap')?.classList.toggle('hidden', !input.checked);
      }
      if (field === 'follow_up_enabled') {
        container.querySelector('#followup-wrap')?.classList.toggle('hidden', !input.checked);
      }
      if (input.tagName === 'TEXTAREA') updateCount(input, field);
    };

    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', handler);
  });

  // Variable insertion at the cursor
  container.querySelectorAll('[data-var]').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.target;
      const area = container.querySelector(`[data-field="${field}"]`);
      if (!area) return;

      const start = area.selectionStart ?? area.value.length;
      const end = area.selectionEnd ?? area.value.length;
      area.value = area.value.slice(0, start) + btn.dataset.var + area.value.slice(end);

      form[field] = area.value;
      dirty = true;

      area.focus();
      area.selectionStart = area.selectionEnd = start + btn.dataset.var.length;
      updateCount(area, field);
    });
  });

  // Post selection
  container.querySelectorAll('input[name="post"]').forEach(radio => {
    radio.addEventListener('change', () => {
      form.post_id = radio.value;
      dirty = true;
      paint(container);
    });
  });

  const postFilter = container.querySelector('#post-filter');
  if (postFilter) {
    postFilter.addEventListener('input', () => {
      const term = postFilter.value.trim().toLowerCase();
      container.querySelectorAll('[data-post-option]').forEach(opt => {
        opt.classList.toggle('hidden', term && !opt.dataset.caption.includes(term));
      });
    });
  }

  // Keywords
  const kwInput = container.querySelector('#kw-input');
  const addKeyword = () => {
    const value = kwInput.value.trim();
    if (!value) return;
    if (form.keywords.some(k => k.toLowerCase() === value.toLowerCase())) {
      toastWarn('That keyword is already in the list.');
      kwInput.value = '';
      return;
    }
    form.keywords.push(value);
    dirty = true;
    kwInput.value = '';
    paint(container);
    container.querySelector('#kw-input')?.focus();
  };

  if (kwInput) {
    container.querySelector('#kw-add').addEventListener('click', addKeyword);
    kwInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
    });
  }

  container.querySelectorAll('[data-kw-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      form.keywords.splice(Number(btn.dataset.kwRemove), 1);
      dirty = true;
      paint(container);
    });
  });

  // Save step
  container.querySelector('#btn-save-draft')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const saved = await save();
    if (saved) go(`/campaigns/${saved.id}`);
    else e.currentTarget.disabled = false;
  });

  container.querySelector('#btn-save-start')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const saved = await save({ activate: true });
    if (saved) go(`/campaigns/${saved.id}`);
    else e.currentTarget.disabled = false;
  });

  container.querySelectorAll('[data-go]').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.go)));
}

/** Live character counter under a textarea. */
function updateCount(area, field) {
  const hint = area.parentElement.querySelector('.hint');
  const max = LIMITS[field];
  if (!hint || !max) return;

  const used = area.value.length;
  const over = used > max;
  hint.textContent = `${num(used)} / ${num(max)} characters${over ? ' — too long for Meta, trim it' : ''}`;
  hint.classList.toggle('danger-text', over);
}
