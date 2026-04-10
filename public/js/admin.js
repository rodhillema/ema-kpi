/* ============================================================
   EMA Tickets — Admin Dashboard Logic
   Trellis login, ticket queue, detail view, reports, team management
   ============================================================ */

let currentUser = null;
let teamMembers = [];
let currentPage = 0;
const PAGE_SIZE = 25;
let totalTickets = 0;

// ---- Trellis Auth ----

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginError');

  if (!username || !password) {
    errorEl.textContent = 'Enter your username and password';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      document.getElementById('loginPassword').value = '';
      return;
    }

    showApp({ firstName: data.firstName, username });
  } catch (err) {
    errorEl.textContent = 'Connection error — please try again';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
}

function showApp(user) {
  currentUser = user;
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('welcomeUser').textContent = `Hi, ${user.firstName}`;
  initDashboard();
}

async function initDashboard() {
  try {
    teamMembers = await api('/api/team');
    populateAssigneeFilter();
    loadTickets();
  } catch (err) {
    showToast('Failed to initialize dashboard', 'error');
  }
}

function api(url, options = {}) {
  options.headers = { ...options.headers, 'Content-Type': 'application/json' };
  return fetch(url, options).then(res => {
    if (res.status === 401) {
      // Session expired — show login
      doLogout();
      throw new Error('Session expired');
    }
    if (!res.ok) return res.json().then(e => { throw new Error(e.error); });
    return res.json();
  });
}

// ---- Navigation ----

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('[data-tab]').forEach(t => {
    if (t.dataset.tab === tab) t.classList.add('active');
  });
  document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${tab}`).classList.remove('hidden');
}

function showView(view) {
  const tab = document.getElementById(`${view}Tab`);
  if (tab) tab.style.display = '';
  switchTab(view);
  if (view === 'reports') loadReports();
  if (view === 'team') loadTeamView();
}

function backToQueue() {
  document.getElementById('detailTab').style.display = 'none';
  document.getElementById('reportsTab').style.display = 'none';
  document.getElementById('teamTab').style.display = 'none';
  switchTab('queue');
}

// ---- Ticket Queue ----

function populateAssigneeFilter() {
  const sel = document.getElementById('filterAssignee');
  teamMembers.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
}

async function loadTickets() {
  const params = new URLSearchParams();
  const status = document.getElementById('filterStatus').value;
  const type = document.getElementById('filterType').value;
  const priority = document.getElementById('filterPriority').value;
  const assignee = document.getElementById('filterAssignee').value;

  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (priority) params.set('priority', priority);
  if (assignee) params.set('assignee', assignee);
  params.set('limit', PAGE_SIZE);
  params.set('offset', currentPage * PAGE_SIZE);

  try {
    const data = await api(`/api/tickets?${params}`);
    totalTickets = data.total;
    renderTicketTable(data.tickets);
    updatePagination();
  } catch (err) {
    showToast('Failed to load tickets', 'error');
  }
}

function renderTicketTable(tickets) {
  const tbody = document.getElementById('ticketTableBody');
  if (tickets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No tickets found</td></tr>';
    document.getElementById('ticketCount').textContent = '0 tickets';
    return;
  }

  tbody.innerHTML = tickets.map(t => {
    const primary = t.assignees ? t.assignees.find(a => a.isPrimary) : null;
    const assigneeName = primary ? primary.name : (t.assignees && t.assignees.length > 0 ? t.assignees[0].name : '—');
    const date = new Date(t.createdAt).toLocaleDateString();
    return `
      <tr onclick="openTicket('${t.id}')">
        <td><strong>${esc(t.ticketNumber)}</strong></td>
        <td>${esc(t.title)}</td>
        <td><span class="badge badge-${t.type}">${t.type === 'staff_request' ? 'Request' : 'Bug'}</span></td>
        <td><span class="badge badge-${t.priority}">${t.priority}</span></td>
        <td><span class="badge badge-${t.status}">${t.status.replace('_', ' ')}</span></td>
        <td>${esc(assigneeName)}</td>
        <td class="text-sm text-muted">${date}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('ticketCount').textContent = `${totalTickets} ticket${totalTickets !== 1 ? 's' : ''}`;
}

function updatePagination() {
  document.getElementById('prevPageBtn').disabled = currentPage === 0;
  document.getElementById('nextPageBtn').disabled = (currentPage + 1) * PAGE_SIZE >= totalTickets;
}

function prevPage() { if (currentPage > 0) { currentPage--; loadTickets(); } }
function nextPage() { if ((currentPage + 1) * PAGE_SIZE < totalTickets) { currentPage++; loadTickets(); } }

// ---- Ticket Detail ----

async function openTicket(id) {
  try {
    const ticket = await api(`/api/tickets/${id}`);
    renderTicketDetail(ticket);
    document.getElementById('detailTab').style.display = '';
    switchTab('detail');
  } catch (err) {
    showToast('Failed to load ticket', 'error');
  }
}

function renderTicketDetail(t) {
  const detail = document.getElementById('ticketDetail');
  const createdDate = new Date(t.createdAt).toLocaleString();
  const resolvedDate = t.resolvedAt ? new Date(t.resolvedAt).toLocaleString() : '—';

  detail.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h2>${esc(t.ticketNumber)} — ${esc(t.title)}</h2>
          <span class="badge badge-${t.type}">${t.type === 'staff_request' ? 'Request' : 'Bug'}</span>
          <span class="badge badge-${t.status}">${t.status.replace('_', ' ')}</span>
          <span class="badge badge-${t.priority}">${t.priority}</span>
        </div>
      </div>

      <!-- Status / Priority controls -->
      <div class="detail-section">
        <h3>Update</h3>
        <div class="flex gap-md" style="flex-wrap:wrap">
          <div class="form-group" style="min-width:150px">
            <label>Status</label>
            <select id="editStatus" onchange="updateTicketField('${t.id}','status',this.value)">
              ${['open','in_progress','resolved','closed'].map(s =>
                `<option value="${s}" ${t.status===s?'selected':''}>${s.replace('_',' ')}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group" style="min-width:150px">
            <label>Priority</label>
            <select id="editPriority" onchange="updateTicketField('${t.id}','priority',this.value)">
              ${['low','medium','high'].map(p =>
                `<option value="${p}" ${t.priority===p?'selected':''}>${p}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- Submitter info -->
      <div class="detail-section">
        <h3>Submitter</h3>
        <div class="field-row"><span class="field-label">Name</span><span class="field-value">${esc(t.submitterName)}</span></div>
        <div class="field-row"><span class="field-label">Email</span><span class="field-value">${esc(t.submitterEmail)}</span></div>
        ${t.submitterRole ? `<div class="field-row"><span class="field-label">Role</span><span class="field-value">${esc(t.submitterRole)}</span></div>` : ''}
        <div class="field-row"><span class="field-label">Submitted</span><span class="field-value">${createdDate}</span></div>
        ${t.advocateId ? `<div class="field-row"><span class="field-label">Advocate ID</span><span class="field-value">${esc(t.advocateId)}${t.advocateName ? ' — ' + esc(t.advocateName) : ''}</span></div>` : ''}
      </div>

      <!-- Description -->
      ${t.description ? `
      <div class="detail-section">
        <h3>Description</h3>
        <p>${esc(t.description)}</p>
      </div>` : ''}

      <!-- Dynamic field values -->
      ${t.fieldValues && Object.keys(t.fieldValues).length > 0 ? `
      <div class="detail-section">
        <h3>Form Responses</h3>
        ${Object.entries(t.fieldValues).map(([k, v]) =>
          `<div class="field-row"><span class="field-label">${esc(k)}</span><span class="field-value">${esc(Array.isArray(v) ? v.join(', ') : String(v))}</span></div>`
        ).join('')}
      </div>` : ''}

      <!-- Attachments -->
      ${t.attachments && t.attachments.length > 0 ? `
      <div class="detail-section">
        <h3>Attachments</h3>
        ${t.attachments.map(a => `
          <div class="flex gap-sm mb-1" style="align-items:center">
            ${a.mimeType && a.mimeType.startsWith('image/') ? `<img src="${esc(a.cloudinaryUrl)}" style="max-width:120px;max-height:80px;border-radius:4px">` : ''}
            <a href="${esc(a.cloudinaryUrl)}" target="_blank" class="text-sm">${esc(a.filename)}</a>
          </div>
        `).join('')}
      </div>` : ''}

      <!-- Resolution note -->
      <div class="detail-section">
        <h3>Resolution Note</h3>
        <div class="form-group">
          <textarea id="resolutionNote" rows="2" placeholder="Add resolution notes...">${esc(t.resolutionNote || '')}</textarea>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="saveResolution('${t.id}')">Save Note</button>
      </div>

      <!-- Assignees -->
      <div class="detail-section">
        <h3>Assignees</h3>
        <div id="assigneeList">
          ${renderAssignees(t.id, t.assignees || [])}
        </div>
        <div class="flex gap-sm mt-1" style="align-items:flex-end">
          <select id="addAssigneeSelect" class="form-group" style="margin:0;max-width:200px">
            <option value="">Add assignee...</option>
            ${teamMembers.filter(m => !(t.assignees||[]).find(a => a.teamMemberId === m.id)).map(m =>
              `<option value="${m.id}">${esc(m.name)}</option>`
            ).join('')}
          </select>
          <button class="btn btn-secondary btn-sm" onclick="addAssignee('${t.id}')">Add</button>
        </div>
      </div>

      <!-- Time Logs -->
      <div class="detail-section">
        <h3>Time Log</h3>
        <div id="timeLogList">
          ${renderTimeLogs(t.timeLogs || [])}
        </div>
        <div class="flex gap-sm mt-1" style="align-items:flex-end;flex-wrap:wrap">
          <select id="timeLogMember" style="max-width:160px">
            ${teamMembers.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
          </select>
          <input type="number" id="timeLogMinutes" placeholder="Minutes" min="1" style="max-width:100px">
          <input type="text" id="timeLogNote" placeholder="Note (optional)" style="max-width:200px">
          <button class="btn btn-secondary btn-sm" onclick="addTimeLog('${t.id}')">Log Time</button>
        </div>
      </div>

      <!-- Comments -->
      <div class="detail-section">
        <h3>Comments</h3>
        <div id="commentList">
          ${renderComments(t.comments || [])}
        </div>
        <div class="mt-1">
          <div class="flex gap-sm" style="align-items:flex-end">
            <select id="commentMember" style="max-width:160px">
              ${teamMembers.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
            </select>
          </div>
          <textarea id="commentBody" rows="2" placeholder="Add a comment..." class="mt-1"></textarea>
          <button class="btn btn-secondary btn-sm mt-1" onclick="addComment('${t.id}')">Post Comment</button>
        </div>
      </div>

      <!-- Resolved info -->
      ${t.resolvedAt ? `
      <div class="detail-section">
        <h3>Resolved</h3>
        <p class="text-sm text-muted">${resolvedDate}</p>
      </div>` : ''}
    </div>
  `;
}

function renderAssignees(ticketId, assignees) {
  if (assignees.length === 0) return '<p class="text-sm text-muted">No assignees yet</p>';
  return assignees.map(a => `
    <div class="flex-between" style="padding:0.3rem 0;border-bottom:1px solid var(--border)">
      <span>${esc(a.name)} ${a.isPrimary ? '<span class="badge badge-open">Primary</span>' : ''}</span>
      <div class="flex gap-sm">
        <button class="btn btn-secondary btn-sm" onclick="togglePrimary('${ticketId}','${a.teamMemberId}',${!a.isPrimary})">${a.isPrimary ? 'Remove primary' : 'Make primary'}</button>
        <button class="btn btn-sm" style="color:var(--danger)" onclick="removeAssignee('${ticketId}','${a.teamMemberId}')">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderTimeLogs(logs) {
  if (logs.length === 0) return '<p class="text-sm text-muted">No time logged</p>';
  const total = logs.reduce((sum, l) => sum + l.minutes, 0);
  return logs.map(l => `
    <div class="time-entry">
      <span><strong>${esc(l.name)}</strong> — ${l.minutes} min${l.note ? ' — ' + esc(l.note) : ''}</span>
      <span class="text-sm text-muted">${new Date(l.loggedAt).toLocaleDateString()}</span>
    </div>
  `).join('') + `<div class="text-sm mt-1" style="font-weight:700">Total: ${total} min (${(total/60).toFixed(1)} hrs)</div>`;
}

function renderComments(comments) {
  if (comments.length === 0) return '<p class="text-sm text-muted">No comments yet</p>';
  return comments.map(c => `
    <div class="comment">
      <div class="comment-header">
        <strong>${esc(c.name)}</strong>
        <span>${new Date(c.createdAt).toLocaleString()}</span>
      </div>
      <p>${esc(c.body)}</p>
    </div>
  `).join('');
}

// ---- Ticket Actions ----

async function updateTicketField(id, field, value) {
  try {
    await api(`/api/tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value })
    });
    showToast(`${field} updated`, 'success');
  } catch (err) {
    showToast(`Failed to update ${field}`, 'error');
  }
}

async function saveResolution(id) {
  const note = document.getElementById('resolutionNote').value.trim();
  try {
    await api(`/api/tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolutionNote: note })
    });
    showToast('Resolution note saved', 'success');
  } catch (err) {
    showToast('Failed to save note', 'error');
  }
}

async function addAssignee(ticketId) {
  const sel = document.getElementById('addAssigneeSelect');
  const memberId = sel.value;
  if (!memberId) return;
  try {
    await api(`/api/tickets/${ticketId}/assignees`, {
      method: 'POST',
      body: JSON.stringify({ teamMemberId: memberId, isPrimary: false })
    });
    showToast('Assignee added', 'success');
    openTicket(ticketId);
  } catch (err) {
    showToast('Failed to add assignee', 'error');
  }
}

async function removeAssignee(ticketId, memberId) {
  try {
    await api(`/api/tickets/${ticketId}/assignees/${memberId}`, { method: 'DELETE' });
    showToast('Assignee removed', 'success');
    openTicket(ticketId);
  } catch (err) {
    showToast('Failed to remove assignee', 'error');
  }
}

async function togglePrimary(ticketId, memberId, isPrimary) {
  try {
    await api(`/api/tickets/${ticketId}/assignees/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isPrimary })
    });
    openTicket(ticketId);
  } catch (err) {
    showToast('Failed to update', 'error');
  }
}

async function addTimeLog(ticketId) {
  const memberId = document.getElementById('timeLogMember').value;
  const minutes = parseInt(document.getElementById('timeLogMinutes').value);
  const note = document.getElementById('timeLogNote').value.trim();
  if (!memberId || !minutes || minutes <= 0) {
    showToast('Select a member and enter minutes', 'error');
    return;
  }
  try {
    await api(`/api/timelogs/ticket/${ticketId}`, {
      method: 'POST',
      body: JSON.stringify({ teamMemberId: memberId, minutes, note: note || null })
    });
    showToast('Time logged', 'success');
    document.getElementById('timeLogMinutes').value = '';
    document.getElementById('timeLogNote').value = '';
    openTicket(ticketId);
  } catch (err) {
    showToast('Failed to log time', 'error');
  }
}

async function addComment(ticketId) {
  const memberId = document.getElementById('commentMember').value;
  const body = document.getElementById('commentBody').value.trim();
  if (!memberId || !body) {
    showToast('Select a member and enter a comment', 'error');
    return;
  }
  try {
    await api(`/api/comments/ticket/${ticketId}`, {
      method: 'POST',
      body: JSON.stringify({ teamMemberId: memberId, body })
    });
    showToast('Comment posted', 'success');
    document.getElementById('commentBody').value = '';
    openTicket(ticketId);
  } catch (err) {
    showToast('Failed to post comment', 'error');
  }
}

// ---- Reports ----

async function loadReports() {
  const content = document.getElementById('reportsContent');
  content.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading reports...</div>';

  try {
    const [summary, time, resolution, workload] = await Promise.all([
      api('/api/reports/summary'),
      api('/api/reports/time'),
      api('/api/reports/resolution'),
      api('/api/reports/workload')
    ]);

    content.innerHTML = `
      <!-- Status Summary -->
      <div class="card">
        <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Tickets by Status</h3>
        <div class="flex gap-md" style="flex-wrap:wrap">
          ${summary.byStatus.map(s => `
            <div style="text-align:center;min-width:80px">
              <div style="font-size:2rem;font-family:'Shrikhand';color:var(--accent)">${s.count}</div>
              <span class="badge badge-${s.status}">${s.status.replace('_',' ')}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Type & Priority -->
      <div class="flex gap-md" style="flex-wrap:wrap">
        <div class="card" style="flex:1;min-width:250px">
          <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">By Type</h3>
          ${summary.byType.map(t => `
            <div class="flex-between mb-1">
              <span class="badge badge-${t.type}">${t.type === 'staff_request' ? 'Request' : 'Bug'}</span>
              <strong>${t.count}</strong>
            </div>
          `).join('')}
        </div>
        <div class="card" style="flex:1;min-width:250px">
          <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">By Priority</h3>
          ${summary.byPriority.map(p => `
            <div class="flex-between mb-1">
              <span class="badge badge-${p.priority}">${p.priority}</span>
              <strong>${p.count}</strong>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Time by Member -->
      <div class="card">
        <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Time by Team Member</h3>
        ${time.length === 0 ? '<p class="text-sm text-muted">No time logged yet</p>' : `
        <table>
          <thead><tr><th>Member</th><th>Hours</th><th>Tickets Worked</th></tr></thead>
          <tbody>${time.map(t => `
            <tr style="cursor:default">
              <td>${esc(t.name)}</td>
              <td>${t.totalHours} hrs</td>
              <td>${t.ticketsWorked}</td>
            </tr>
          `).join('')}</tbody>
        </table>`}
      </div>

      <!-- Resolution Time -->
      <div class="card">
        <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Avg Resolution Time</h3>
        ${resolution.length === 0 ? '<p class="text-sm text-muted">No resolved tickets yet</p>' : `
        <table>
          <thead><tr><th>Type</th><th>Resolved</th><th>Avg Hours</th></tr></thead>
          <tbody>${resolution.map(r => `
            <tr style="cursor:default">
              <td>${r.type === 'staff_request' ? 'Request' : 'Bug'}</td>
              <td>${r.resolved}</td>
              <td>${r.avgHours} hrs</td>
            </tr>
          `).join('')}</tbody>
        </table>`}
      </div>

      <!-- Workload -->
      <div class="card">
        <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Current Workload</h3>
        ${workload.length === 0 ? '<p class="text-sm text-muted">No active assignments</p>' : `
        <table>
          <thead><tr><th>Member</th><th>Open</th><th>In Progress</th><th>Total Active</th></tr></thead>
          <tbody>${workload.map(w => `
            <tr style="cursor:default">
              <td>${esc(w.name)}</td>
              <td>${w.openCount}</td>
              <td>${w.inProgressCount}</td>
              <td>${w.totalAssigned}</td>
            </tr>
          `).join('')}</tbody>
        </table>`}
      </div>
    `;
  } catch (err) {
    content.innerHTML = '<div class="empty-state">Failed to load reports</div>';
  }
}

// ---- Team Management ----

async function loadTeamView() {
  const content = document.getElementById('teamContent');
  try {
    teamMembers = await api('/api/team');
    content.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted)">Team Members</h3>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            ${teamMembers.map(m => `
              <tr style="cursor:default">
                <td>${esc(m.name)}</td>
                <td class="text-sm">${esc(m.email)}</td>
                <td><span class="badge">${m.role}</span></td>
                <td>${m.isActive ? '<span class="badge badge-resolved">Active</span>' : '<span class="badge badge-closed">Inactive</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 style="font-family:'Oswald';text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Add Team Member</h3>
        <div class="flex gap-sm" style="flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="margin:0;flex:1;min-width:150px">
            <label>Name</label>
            <input type="text" id="newMemberName" placeholder="Full name">
          </div>
          <div class="form-group" style="margin:0;flex:1;min-width:200px">
            <label>Email</label>
            <input type="email" id="newMemberEmail" placeholder="email@example.com">
          </div>
          <div class="form-group" style="margin:0;min-width:120px">
            <label>Role</label>
            <select id="newMemberRole">
              <option value="tech">Tech</option>
              <option value="admin">Admin</option>
              <option value="staff">Staff</option>
            </select>
          </div>
          <button class="btn btn-primary btn-sm" onclick="addTeamMember()">Add</button>
        </div>
      </div>
    `;
  } catch (err) {
    content.innerHTML = '<div class="empty-state">Failed to load team</div>';
  }
}

async function addTeamMember() {
  const name = document.getElementById('newMemberName').value.trim();
  const email = document.getElementById('newMemberEmail').value.trim();
  const role = document.getElementById('newMemberRole').value;
  if (!name || !email) {
    showToast('Name and email are required', 'error');
    return;
  }
  try {
    await api('/api/team', {
      method: 'POST',
      body: JSON.stringify({ name, email, role })
    });
    showToast('Team member added', 'success');
    loadTeamView();
  } catch (err) {
    showToast(err.message || 'Failed to add member', 'error');
  }
}

// ---- Utilities ----

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function showToast(message, type) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// Check for existing session on load, otherwise show login
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json();
      showApp(data.user);
      return;
    }
  } catch (_) {}
  document.getElementById('loginUsername').focus();
});
