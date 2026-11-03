/**
 * Thin fetch wrapper. Every call returns the parsed JSON body and throws an
 * Error carrying the server's own message when the request fails, so views can
 * surface a real reason instead of "something went wrong".
 */

async function request(path, { method = 'GET', body = null } = {}) {
  const options = { method, headers: {} };

  if (body !== null && body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (networkErr) {
    throw new Error('Cannot reach the automation server. Is it still running?');
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }
  }

  if (!response.ok || (data && data.success === false)) {
    const err = new Error((data && data.error) || `Request failed (HTTP ${response.status})`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function qs(params = {}) {
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (usable.length === 0) return '';
  return '?' + usable.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export const api = {
  // Dashboard & system
  overview: range => request(`/api/dashboard/overview${qs({ range })}`),
  systemStatus: () => request('/api/dashboard/system-status'),
  logs: params => request(`/api/dashboard/logs${qs(params)}`),
  threads: () => request('/api/dashboard/threads'),
  settings: () => request('/api/dashboard/settings'),
  saveSetting: (key, value) => request('/api/dashboard/settings', { method: 'POST', body: { key, value } }),
  emergencyStop: active => request('/api/dashboard/emergency-stop', { method: 'POST', body: { active } }),
  globalPause: active => request('/api/dashboard/pause', { method: 'POST', body: { active } }),
  rateDelay: delayMs => request('/api/dashboard/rate-delay', { method: 'POST', body: { delayMs } }),

  // Posts & Reels
  posts: range => request(`/api/posts${qs({ range })}`),
  syncPosts: () => request('/api/posts/sync', { method: 'POST', body: {} }),

  // Pull comments back from Meta for anything a webhook never delivered.
  // dryRun defaults to true server-side; the live run sends real replies.
  syncComments: (body = {}) =>
    request('/api/posts/sync-comments', { method: 'POST', body }),
  addPost: post => request('/api/posts/manual', { method: 'POST', body: post }),
  deletePost: postId => request(`/api/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' }),

  // Campaigns
  campaigns: params => request(`/api/campaigns${qs(params)}`),
  campaign: (id, range) => request(`/api/campaigns/${id}${qs({ range })}`),
  campaignStats: (id, range) => request(`/api/campaigns/${id}/stats${qs({ range })}`),
  campaignActivity: (id, params) => request(`/api/campaigns/${id}/activity${qs(params)}`),
  campaignHistory: id => request(`/api/campaigns/${id}/history`),
  createCampaign: body => request('/api/campaigns', { method: 'POST', body }),
  updateCampaign: (id, body) => request(`/api/campaigns/${id}`, { method: 'PUT', body }),
  updateMessages: (id, body) => request(`/api/campaigns/${id}/messages`, { method: 'PATCH', body }),
  setStatus: (id, status, reason) => request(`/api/campaigns/${id}/status`, { method: 'POST', body: { status, reason } }),
  duplicateCampaign: (id, name) => request(`/api/campaigns/${id}/duplicate`, { method: 'POST', body: { name } }),

  // Clears this campaign's own records only. Meta's one-private-reply-per-comment
  // rule is enforced on Meta's side and is not affected by this.
  resetCampaign: id =>
    request(`/api/campaigns/${id}/reset`, { method: 'POST', body: {} }),
  deleteCampaign: id => request(`/api/campaigns/${id}`, { method: 'DELETE' }),

  // Templates
  templates: type => request(`/api/templates${qs({ type })}`),
  createTemplate: body => request('/api/templates', { method: 'POST', body }),
  updateTemplate: (id, body) => request(`/api/templates/${id}`, { method: 'PUT', body }),
  deleteTemplate: id => request(`/api/templates/${id}`, { method: 'DELETE' }),

  // Sandbox
  simulateComment: body => request('/api/test/simulate-comment', { method: 'POST', body }),
  simulateDm: body => request('/api/test/simulate-dm', { method: 'POST', body })
};
