/**
 * Mission Control UI — Kovix 2.0 Phase 3.
 *
 * 3-pane "Mission Control" layout:
 *   ┌────────────┬──────────────────────┬────────────────────┐
 *   │ Left Pane  │   Center Pane        │   Right Pane       │
 *   │ (Context)  │   (Milestone Map)    │   (Agent Console)  │
 *   │            │                      │                    │
 *   │ File tree  │ Milestones with      │ Chat: LLM text +   │
 *   │ from       │ status icons:        │ tool calls.        │
 *   │ list_files │ 🔵 PLANNED           │                    │
 *   │            │ 🟡 EXECUTING (pulse) │ Approval cards     │
 *   │            │ 🟢 VERIFIED          │ with Approve/Reject│
 *   │            │ 🔴 FAILED            │ buttons.           │
 *   │            │                      │                    │
 *   │            │                      │ Prompt input +     │
 *   │            │                      │ Start button.      │
 *   └────────────┴──────────────────────┴────────────────────┘
 *
 * Aesthetic: dark-mode native (Linear/Vercel family). CSS Grid layout,
 * system font stack, mono for code, indigo accent for primary actions.
 *
 * The HTML is a self-contained string loaded via data: URL. The renderer
 * communicates with the main process through the `kovixAPI` bridge exposed
 * by preload.ts (contextBridge). No direct Node access in the renderer.
 */

export const MISSION_CONTROL_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kovix — Mission Control</title>
<style>
  /* ─── Design tokens ─── */
  :root {
    --bg:          #09090b;
    --surface:     #111113;
    --surface-2:   #18181b;
    --surface-3:   #1f1f23;
    --border:      #27272a;
    --border-2:    #3f3f46;
    --text:        #fafafa;
    --text-2:      #a1a1aa;
    --text-3:      #71717a;
    --accent:      #6366f1;
    --accent-2:    #818cf8;
    --accent-soft: rgba(99, 102, 241, 0.12);
    --success:     #22c55e;
    --warning:     #eab308;
    --error:       #ef4444;
    --radius:      8px;
    --radius-sm:   6px;
    --mono:        "SF Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", ui-monospace, monospace;
    --sans:        -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.5;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }

  /* ─── Top bar ─── */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 44px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .topbar-logo {
    width: 22px;
    height: 22px;
    display: block;
  }
  .topbar-title {
    font-weight: 600;
    font-size: 13px;
    letter-spacing: -0.01em;
  }
  .topbar-mode {
    color: var(--text-3);
    font-size: 12px;
    padding: 2px 8px;
    background: var(--surface-2);
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .provider-chip {
    font-size: 11px;
    color: var(--text-2);
    background: var(--surface-2);
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .workspace-chip {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--mono);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── 3-pane grid ─── */
  .mission-control {
    display: grid;
    grid-template-columns: 240px 1fr 420px;
    height: calc(100vh - 44px);
    overflow: hidden;
  }

  .pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
  }
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .pane-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }
  .pane-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .pane-body::-webkit-scrollbar { width: 6px; }
  .pane-body::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 3px; }
  .pane-body::-webkit-scrollbar-track { background: transparent; }

  /* ─── Left pane: file tree ─── */
  .pane-left { border-right: 1px solid var(--border); }
  .file-tree {
    padding: 6px 0;
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 14px;
    cursor: default;
    color: var(--text-2);
    font-size: 12px;
    user-select: none;
  }
  .file-item:hover { background: var(--surface-2); color: var(--text); }
  .file-item .icon { font-size: 13px; opacity: 0.7; width: 14px; text-align: center; }
  .file-item.dir .icon { color: var(--accent-2); opacity: 1; }
  .file-empty {
    padding: 20px 14px;
    color: var(--text-3);
    font-size: 11px;
    text-align: center;
  }

  /* ─── Center pane: milestone map ─── */
  .pane-center {
    background: var(--bg);
  }
  .milestone-list {
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .milestone {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .milestone.executing {
    border-color: var(--warning);
    box-shadow: 0 0 0 1px var(--warning), 0 0 12px rgba(234, 179, 8, 0.15);
    animation: pulse-border 2s ease-in-out infinite;
  }
  @keyframes pulse-border {
    0%, 100% { box-shadow: 0 0 0 1px var(--warning), 0 0 8px rgba(234, 179, 8, 0.1); }
    50%      { box-shadow: 0 0 0 1px var(--warning), 0 0 20px rgba(234, 179, 8, 0.3); }
  }
  .milestone.verified { border-color: rgba(34, 197, 94, 0.3); }
  .milestone.failed { border-color: rgba(239, 68, 68, 0.3); }

  .milestone-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .milestone-icon {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
  }
  .milestone.planned .milestone-icon { background: var(--accent-2); }
  .milestone.executing .milestone-icon { background: var(--warning); }
  .milestone.verified .milestone-icon { background: var(--success); }
  .milestone.failed .milestone-icon { background: var(--error); }

  .milestone-id {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .milestone-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
  }
  .milestone-desc {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
  }
  .milestone-status {
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
  }
  .milestone.executing .milestone-status { color: var(--warning); }
  .milestone.verified .milestone-status { color: var(--success); }
  .milestone.failed .milestone-status { color: var(--error); }

  .empty-state {
    padding: 60px 20px;
    text-align: center;
    color: var(--text-3);
  }
  .empty-state h3 {
    font-size: 14px;
    color: var(--text-2);
    margin-bottom: 6px;
    font-weight: 500;
  }
  .empty-state p {
    font-size: 12px;
    line-height: 1.6;
  }

  /* ─── Right pane: agent console ─── */
  .pane-right {
    border-left: 1px solid var(--border);
    background: var(--surface);
  }
  .console-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .console-body::-webkit-scrollbar { width: 6px; }
  .console-body::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 3px; }

  .console-msg {
    font-size: 12px;
    line-height: 1.5;
    word-wrap: break-word;
  }
  .console-msg .role {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
    margin-bottom: 3px;
  }
  .console-msg.llm .role { color: var(--accent-2); }
  .console-msg.tool .role { color: var(--warning); }
  .console-msg.tool .content {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-2);
    background: var(--surface-2);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .console-msg.tool .content.ok { border-left: 2px solid var(--success); }
  .console-msg.tool .content.err { border-left: 2px solid var(--error); }
  .console-msg.llm .content { color: var(--text); }

  /* ─── Approval card ─── */
  .approval-card {
    background: var(--surface-2);
    border: 1px solid var(--warning);
    border-radius: var(--radius);
    padding: 14px;
    box-shadow: 0 0 0 1px rgba(234, 179, 8, 0.15), 0 4px 12px rgba(0,0,0,0.3);
  }
  .approval-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .approval-badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--warning);
    background: rgba(234, 179, 8, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
  }
  .approval-tool {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }
  .approval-path {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-2);
    margin-bottom: 10px;
    padding: 6px 10px;
    background: var(--bg);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .approval-code {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
    margin-bottom: 12px;
    line-height: 1.6;
  }
  .approval-code::-webkit-scrollbar { width: 5px; }
  .approval-code::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 3px; }
  .approval-actions {
    display: flex;
    gap: 8px;
  }
  .btn {
    flex: 1;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { background: var(--surface-3); border-color: var(--border-2); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-approve {
    background: var(--success);
    border-color: var(--success);
    color: #052e16;
  }
  .btn-approve:hover { background: #16a34a; border-color: #16a34a; }
  .btn-reject {
    background: transparent;
    border-color: var(--error);
    color: var(--error);
  }
  .btn-reject:hover { background: rgba(239, 68, 68, 0.1); }

  .approval-resolved {
    font-size: 11px;
    color: var(--text-3);
    text-align: center;
    padding: 6px 0 0;
  }
  .approval-resolved.approved { color: var(--success); }
  .approval-resolved.rejected { color: var(--error); }

  /* ─── Prompt input ─── */
  .console-input {
    border-top: 1px solid var(--border);
    padding: 12px 14px;
    flex-shrink: 0;
    background: var(--surface);
  }
  .console-input textarea {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--sans);
    font-size: 12px;
    padding: 10px 12px;
    resize: none;
    min-height: 60px;
    max-height: 120px;
    outline: none;
    transition: border-color 0.15s;
  }
  .console-input textarea:focus { border-color: var(--accent); }
  .console-input textarea::placeholder { color: var(--text-3); }
  .console-input-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
  }
  .console-input-hint {
    font-size: 10px;
    color: var(--text-3);
  }
  .btn-start {
    padding: 6px 16px;
    background: var(--accent);
    border: 1px solid var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-start:hover { background: var(--accent-2); border-color: var(--accent-2); }
  .btn-start:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <svg class="topbar-logo" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0E1430"/><stop offset="100%" stop-color="#06080F"/></linearGradient>
        <linearGradient id="hex" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#22D3EE"/><stop offset="100%" stop-color="#3B82F6"/></linearGradient>
        <linearGradient id="k" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#F0F9FF"/><stop offset="100%" stop-color="#A5F3FC"/></linearGradient>
      </defs>
      <rect x="0" y="0" width="1024" height="1024" rx="220" ry="220" fill="url(#bg)"/>
      <polygon points="512,150 822,329 822,687 512,866 202,687 202,329" fill="none" stroke="url(#hex)" stroke-width="22" stroke-linejoin="round"/>
      <polygon points="512,235 748,371 748,645 512,781 276,645 276,371" fill="#0B1228" stroke="#1E293B" stroke-width="3" stroke-linejoin="round"/>
      <g fill="url(#k)"><rect x="416" y="320" width="68" height="384" rx="18"/><polygon points="484,512 484,608 700,320 700,420"/><polygon points="484,512 484,608 700,704 700,604"/></g>
      <circle cx="800" cy="232" r="22" fill="#22D3EE"/><circle cx="800" cy="232" r="10" fill="#0B1228"/>
    </svg>
    <span class="topbar-title">Kovix</span>
    <span class="topbar-mode">Mission Control</span>
  </div>
  <div class="topbar-right">
    <span class="provider-chip" id="provider-chip">—</span>
    <span class="workspace-chip" id="workspace-chip">—</span>
  </div>
</div>

<div class="mission-control">

  <!-- Left Pane: Context (file tree) -->
  <div class="pane pane-left">
    <div class="pane-header">
      <span class="pane-title">Workspace</span>
    </div>
    <div class="pane-body" id="file-tree">
      <div class="file-empty">Loading…</div>
    </div>
  </div>

  <!-- Center Pane: Milestone Map -->
  <div class="pane pane-center">
    <div class="pane-header">
      <span class="pane-title">Milestones</span>
    </div>
    <div class="pane-body">
      <div class="empty-state" id="empty-state">
        <h3>No active mission</h3>
        <p>Enter a task in the console to the right.<br/>The Lead Architect will decompose it into milestones.</p>
      </div>
      <div class="milestone-list" id="milestone-list" style="display:none;"></div>
    </div>
  </div>

  <!-- Right Pane: Agent Console -->
  <div class="pane pane-right">
    <div class="pane-header">
      <span class="pane-title">Console</span>
    </div>
    <div class="console-body" id="console-body"></div>
    <div class="console-input">
      <textarea id="prompt-input" placeholder="Describe what you want Kovix to build…" rows="3"></textarea>
      <div class="console-input-row">
        <span class="console-input-hint" id="status-hint">Ready</span>
        <button class="btn-start" id="start-btn" type="button">Start</button>
      </div>
    </div>
  </div>

</div>

<script>
(function() {
  'use strict';

  // ─── DOM refs ──────────────────────────────────────────────────
  const fileTree = document.getElementById('file-tree');
  const emptyState = document.getElementById('empty-state');
  const milestoneList = document.getElementById('milestone-list');
  const consoleBody = document.getElementById('console-body');
  const promptInput = document.getElementById('prompt-input');
  const startBtn = document.getElementById('start-btn');
  const statusHint = document.getElementById('status-hint');
  const providerChip = document.getElementById('provider-chip');
  const workspaceChip = document.getElementById('workspace-chip');

  // ─── Status helpers ────────────────────────────────────────────
  const STATUS_LABELS = { PLANNED: 'Planned', EXECUTING: 'Executing', VERIFIED: 'Verified', FAILED: 'Failed' };
  const STATUS_CLASSES = { PLANNED: 'planned', EXECUTING: 'executing', VERIFIED: 'verified', FAILED: 'failed' };

  function setStatus(text) { statusHint.textContent = text; }

  // ─── Render: file tree ─────────────────────────────────────────
  function renderFileTree(entries) {
    if (!entries || entries.length === 0) {
      fileTree.innerHTML = '<div class="file-empty">Empty workspace</div>';
      return;
    }
    fileTree.innerHTML = '<div class="file-tree">' + entries.map(function(e) {
      var isDir = e.endsWith('/');
      var icon = isDir ? '\\u{1F4C1}' : '\\u{1F4C4}';
      return '<div class="file-item' + (isDir ? ' dir' : '') + '"><span class="icon">' + icon + '</span><span>' + escapeHtml(e.replace(/\\/$/, '')) + '</span></div>';
    }).join('') + '</div>';
  }

  // ─── Render: milestones ────────────────────────────────────────
  function renderMilestones(milestones) {
    if (!milestones || milestones.length === 0) {
      emptyState.style.display = '';
      milestoneList.style.display = 'none';
      milestoneList.innerHTML = '';
      return;
    }
    emptyState.style.display = 'none';
    milestoneList.style.display = '';
    milestoneList.innerHTML = milestones.map(function(m) {
      var cls = STATUS_CLASSES[m.status] || '';
      var label = STATUS_LABELS[m.status] || m.status;
      return '<div class="milestone ' + cls + '">' +
        '<div class="milestone-header">' +
          '<span class="milestone-icon"></span>' +
          '<span class="milestone-id">#' + escapeHtml(m.id) + '</span>' +
          '<span class="milestone-title">' + escapeHtml(m.title) + '</span>' +
          '<span class="milestone-status">' + label + '</span>' +
        '</div>' +
        '<div class="milestone-desc">' + escapeHtml(m.description) + '</div>' +
      '</div>';
    }).join('');
  }

  // ─── Render: console messages ──────────────────────────────────
  function appendLLMText(text) {
    var div = document.createElement('div');
    div.className = 'console-msg llm';
    div.innerHTML = '<div class="role">Kovix</div><div class="content">' + escapeHtml(text) + '</div>';
    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  function appendToolCall(name, args) {
    var div = document.createElement('div');
    div.className = 'console-msg tool';
    var argStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
    div.innerHTML = '<div class="role">tool_call</div><div class="content">' +
      '<strong>' + escapeHtml(name) + '</strong>\\n' + escapeHtml(argStr) + '</div>';
    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  function appendToolResult(callId, result) {
    var div = document.createElement('div');
    div.className = 'console-msg tool';
    div.innerHTML = '<div class="role">tool_result</div><div class="content ' + (result.ok ? 'ok' : 'err') + '">' +
      escapeHtml(result.output) + '</div>';
    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  // ─── Render: approval card ─────────────────────────────────────
  function appendApprovalCard(payload) {
    var div = document.createElement('div');
    div.className = 'approval-card';
    div.id = 'approval-' + payload.callId;

    var path = (payload.args && payload.args.path) ? payload.args.path : '(no path)';
    var content = (payload.args && payload.args.content !== undefined) ? payload.args.content : JSON.stringify(payload.args, null, 2);

    div.innerHTML =
      '<div class="approval-header">' +
        '<span class="approval-badge">\\u26A0 Action Required</span>' +
        '<span class="approval-tool">' + escapeHtml(payload.name) + '</span>' +
      '</div>' +
      '<div class="approval-path">' + escapeHtml(path) + '</div>' +
      '<div class="approval-code">' + escapeHtml(content) + '</div>' +
      '<div class="approval-actions">' +
        '<button class="btn btn-approve" data-callid="' + payload.callId + '" data-action="approve">Approve</button>' +
        '<button class="btn btn-reject" data-callid="' + payload.callId + '" data-action="reject">Reject</button>' +
      '</div>';

    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;

    // Wire the buttons.
    var approveBtn = div.querySelector('.btn-approve');
    var rejectBtn = div.querySelector('.btn-reject');
    approveBtn.addEventListener('click', function() {
      window.kovixAPI.mission.approve(payload.callId);
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      var resolved = document.createElement('div');
      resolved.className = 'approval-resolved approved';
      resolved.textContent = '\\u2713 Approved — executing…';
      div.querySelector('.approval-actions').style.display = 'none';
      div.appendChild(resolved);
    });
    rejectBtn.addEventListener('click', function() {
      window.kovixAPI.mission.reject(payload.callId);
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      var resolved = document.createElement('div');
      resolved.className = 'approval-resolved rejected';
      resolved.textContent = '\\u2717 Rejected — agent will adapt';
      div.querySelector('.approval-actions').style.display = 'none';
      div.appendChild(resolved);
    });
  }

  // ─── Escape helper ─────────────────────────────────────────────
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── Event wiring ──────────────────────────────────────────────
  // Listen for events pushed from the main process.
  window.kovixAPI.mission.onPlanReady(function(plan) {
    renderMilestones(plan);
    setStatus('Plan ready — ' + plan.length + ' milestone(s)');
  });
  window.kovixAPI.mission.onMilestoneStarted(function(id) {
    var plan = window.__kovixPlan || [];
    var m = plan.find(function(x) { return x.id === id; });
    if (m) { m.status = 'EXECUTING'; renderMilestones(plan); }
    setStatus('Executing milestone #' + id);
  });
  window.kovixAPI.mission.onMilestoneVerified(function(id) {
    var plan = window.__kovixPlan || [];
    var m = plan.find(function(x) { return x.id === id; });
    if (m) { m.status = 'VERIFIED'; renderMilestones(plan); }
    setStatus('Milestone #' + id + ' verified');
  });
  window.kovixAPI.mission.onMilestoneFailed(function(id) {
    var plan = window.__kovixPlan || [];
    var m = plan.find(function(x) { return x.id === id; });
    if (m) { m.status = 'FAILED'; renderMilestones(plan); }
    setStatus('Milestone #' + id + ' failed');
  });
  window.kovixAPI.mission.onLLMText(function(text) {
    appendLLMText(text);
  });
  window.kovixAPI.mission.onToolCall(function(payload) {
    appendToolCall(payload.name, payload.args);
  });
  window.kovixAPI.mission.onToolResult(function(payload) {
    appendToolResult(payload.callId, payload.result);
  });
  window.kovixAPI.mission.onApprovalRequired(function(payload) {
    appendApprovalCard(payload);
    setStatus('Action required — ' + payload.name);
  });
  window.kovixAPI.mission.onFileTree(function(entries) {
    renderFileTree(entries);
  });
  window.kovixAPI.mission.onComplete(function(result) {
    setStatus(result.ok ? 'Complete' : 'Failed: ' + (result.error || ''));
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
  });

  // ─── Start button ──────────────────────────────────────────────
  startBtn.addEventListener('click', async function() {
    var prompt = promptInput.value.trim();
    if (!prompt) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Running…';
    consoleBody.innerHTML = '';
    setStatus('Planning…');
    // Refresh the plan cache + render.
    window.__kovixPlan = [];
    try {
      var result = await window.kovixAPI.mission.start(prompt);
      if (result && result.plan) {
        window.__kovixPlan = result.plan;
        renderMilestones(result.plan);
      }
    } catch (err) {
      setStatus('Error: ' + (err.message || err));
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  });

  // Enter key (Cmd/Ctrl+Enter) to start.
  promptInput.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      startBtn.click();
    }
  });

  // ─── Initial load: provider label + workspace + file tree ─────
  (async function init() {
    try {
      var label = await window.kovixAPI.getProviderLabel();
      providerChip.textContent = label || 'No provider';
    } catch (e) { providerChip.textContent = 'No provider'; }

    try {
      var ws = await window.kovixAPI.workspace.get();
      workspaceChip.textContent = ws.dir || '—';
      workspaceChip.title = ws.dir || '';
    } catch (e) { workspaceChip.textContent = '—'; }

    try {
      var tree = await window.kovixAPI.mission.getFileTree();
      renderFileTree(tree);
    } catch (e) { renderFileTree([]); }
  })();

})();
</script>
</body>
</html>`;
