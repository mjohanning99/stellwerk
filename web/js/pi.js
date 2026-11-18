// Pi backend: talks to the bridge's Pi process manager at /ws/pi, which owns
// `pi --mode rpc` children. See PI_PROTOCOL.md for the record shapes.

import { Rpc } from './rpc.js';
import { h, renderDiff } from './ui.js';
import { relTime, truncate, homeify, fmtTokens } from './render.js';

const CLIENT_COMMANDS = [
  ['new', 'Start a new session in the same folder'],
  ['model', 'Choose the model'],
  ['thinking', 'Set thinking level: off|minimal|low|medium|high|xhigh|max'],
  ['compact', 'Compact the conversation (optional instructions)'],
  ['fork', 'Fork from an earlier message (pick one)'],
  ['clone', 'Copy this conversation into a new session'],
  ['name', 'Name this session'],
  ['diff', 'Show uncommitted changes in this folder'],
  ['agents', 'Show subagent runs'],
  ['export', 'Export this session to HTML'],
  ['stop', 'Interrupt the current run'],
  ['delete', '(not supported for Pi sessions)'],
];

function dayGroup(ts) {
  if (!ts) return 'Older';
  const d = new Date(ts < 1e12 ? ts * 1000 : ts), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Older';
}

const textOf = (content) => (typeof content === 'string' ? content
  : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const imagesOf = (content) => (Array.isArray(content) ? content.filter((b) => b.type === 'image') : []);

function piToolResult(name, args, result) {
  const details = result?.details || {};
  const out = textOf(result?.content);
  const r = { output: out };
  if (name === 'edit' && details.patch) r.diff = details.patch;
  else if (name === 'write' && args && typeof args.content === 'string') {
    const lines = args.content.split('\n');
    r.diff = `+++ ${args.path || ''}\n@@ -0,0 +1,${lines.length} @@\n` + lines.slice(0, 400).map((l) => '+' + l).join('\n') + (lines.length > 400 ? `\n\\ … ${lines.length - 400} more lines` : '');
    r.summary = `Wrote ${lines.length} line${lines.length === 1 ? '' : 's'} to ${args.path}`;
  }
  if (name === 'subagent' && Array.isArray(details.results)) r.summary = subagentSummary(details);
  return r;
}

function subagentSummary(details) {
  const rs = details.results || [];
  return rs.map((x) => `${x.exitCode === -1 ? '…' : x.exitCode === 0 ? '✓' : '✗'} ${x.agent}: ${truncate(x.task || '', 80)}`).join('\n');
}

export class PiBackend {
  constructor(view, app) {
    this.view = view;
    this.app = app;
    this.name = 'pi';
    this.appName = 'Pi';
    this.rpc = new Rpc('/ws/pi');
    this.handle = null;
    this.sid = null;          // session file path (what the sidebar keys on)
    this.state = null;
    this.ready = false;
    this.readyWaiters = [];
    this.home = '';
    this.streaming = false;
    this.cur = null;          // assistant message being streamed {blocks}
    this.optimistic = [];     // texts of user rows we already painted
    this.status = new Map();  // extension statusKey -> text
    this.widgets = new Map();
    this.subagents = new Map(); // toolCallId -> details
    this.commands = null;
    this.rpc.addEventListener('state', (e) => this._onState(e.detail));
    this.rpc.addEventListener('notify', (e) => this._onNotify(e.detail));
    this.rpc.addEventListener('unauthorized', () => this.app.showLogin());
  }

  start() { this.rpc.start(); }
  stop() {
    if (this.handle) this.rpc.request('pi.detach', { handle: this.handle }).catch(() => {});
    this.rpc.stop();
  }
  whenReady() { return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r)); }

  _onState({ state, hello }) {
    this.view.setConn(state);
    if (state === 'open') {
      if (hello?.home) { this.home = hello.home; this.view.home = hello.home; }
      this.ready = true;
      this.readyWaiters.splice(0).forEach((r) => r());
      this.app.refreshSessions();
      if (this.sid) this.openSession(this.sid).catch(() => {});
      else if (this.handle) this.handle = null;
    } else this.ready = false;
  }

  cmd(command, timeout) {
    if (!this.handle) return Promise.reject(new Error('no Pi session open'));
    return this.rpc.request('pi.cmd', { handle: this.handle, command, ...(timeout ? { timeout } : {}) }, { timeout: (timeout || 600) * 1000 + 5000 })
      .then((rec) => { if (rec.success === false) { const e = new Error(rec.error || `${command.type} failed`); throw e; } return rec.data; });
  }

  // ------------------------------------------------------------ sessions
  async listSessions(query, { limit = 40, cursor = null } = {}) {
    await this.whenReady();
    const r = await this.rpc.request('pi.sessions', { limit, offset: cursor || 0, ...(query ? { query } : {}) });
    const items = (r.sessions || [])
      .map((s) => ({
        id: s.path,
        title: s.name || truncate(s.first || '(no messages)', 70),
        sub: [homeify(s.cwd || '', this.home), s.messages ? `${s.messages} msgs` : ''].filter(Boolean).join(' · '),
        time: s.modified || s.mtime,
        group: dayGroup(s.modified || s.mtime),
        live: s.streaming,
        snippet: s.snippet,
        raw: s,
      }));
    return { items, next: r.next_offset ?? null };
  }

  async _attach(params) {
    if (this.handle) this.rpc.request('pi.detach', { handle: this.handle }).catch(() => {});
    this.handle = null;   // if the open fails, don't keep sending to the old session
    this.view.clear();
    this.view.setBusy(false);
    this.view.note('… starting Pi');
    const r = await this.rpc.request('pi.open', params, { timeout: 90000 });
    this.view.clear();
    this.handle = r.handle;
    this.cwd = r.cwd;
    this.app.cwd = r.cwd;
    this.state = r.state || {};
    this.status.clear(); this.widgets.clear(); this.subagents.clear();
    this.app.updateSubagentCount(0);
    this.sid = this.state.sessionFile || params.session_path || null;
    this._applyState();
    // history (dedupe against the replayed current run)
    let msgs = [];
    try { msgs = (await this.cmd({ type: 'get_messages' })).messages || []; } catch (e) { this.view.note(`✗ ${e.message}`, { err: true }); }
    const replay = r.replay || [];
    const inRun = new Set(replay.filter((x) => x.type === 'message_start' || x.type === 'message_end').map((x) => `${x.message?.role}:${x.message?.timestamp}`));
    this.view.beginHistory();
    this._renderHistory(msgs.filter((m) => !inRun.has(`${m.role}:${m.timestamp}`)));
    this.view.endHistory();
    for (const rec of r.status || []) this._record(rec);
    for (const rec of r.widgets || []) this._record(rec);
    if (r.streaming) { this.streaming = true; this.view.setBusy(true, 'Working…'); }
    for (const rec of replay) this._record(rec, true);
    for (const rec of r.open_ui || []) this._record(rec);
    this.app.setActive(this.sid);
    this.refreshStats();
    return r;
  }

  async newSession(cwd) {
    await this.whenReady();
    this.sid = null;
    await this._attach({ new: true, cwd: cwd || this.app.cwd || this.home });
    this.app.refreshSessionsSoon();
  }

  async openSession(id) {
    await this.whenReady();
    this.sid = id;
    try { await this._attach({ session_path: id }); }
    catch (e) { this.view.clear(); throw e; }
  }

  _applyState() {
    const s = this.state || {};
    const m = s.model;
    this.view.setStatus({
      model: m ? `${m.provider}/${m.id}` : 'no model',
      effort: m?.reasoning && s.thinkingLevel ? `thinking ${s.thinkingLevel}` : '',
      cwd: this.cwd,
    });
    this.view.setTitle(s.sessionName || this._firstUser || 'New session', [homeify(this.cwd || '', this.home), m?.name && m.name !== m.id ? m.name : ''].filter(Boolean).join(' · '));
  }

  async refreshState() {
    try { this.state = await this.cmd({ type: 'get_state' }); if (this.state.sessionFile) this.sid = this.state.sessionFile; this._applyState(); } catch { /* ignore */ }
  }

  async refreshStats() {
    try {
      const st = await this.cmd({ type: 'get_session_stats' });
      const cu = st.contextUsage;
      this.view.setStatus({
        context: cu ? { used: cu.tokens || 0, max: cu.contextWindow, pct: cu.percent != null ? Math.round(cu.percent) : undefined } : null,
        cost: st.cost ? st.cost : (st.tokens?.total ? `${fmtTokens(st.tokens.total)} tok` : ''),
      });
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ rendering history
  _renderHistory(msgs) {
    const v = this.view;
    const pendingTools = new Map();
    let userIdx = 0;
    this._firstUser = null;
    for (const m of msgs) {
      switch (m.role) {
        case 'system': break;
        case 'user': {
          const text = textOf(m.content);
          if (!this._firstUser) this._firstUser = truncate(text, 80);
          const idx = userIdx++;
          v.addUser({ text, attachments: imagesOf(m.content).map(() => 'image'), onEdit: () => this.editFrom(idx) });
          break;
        }
        case 'assistant': {
          for (const b of m.content || []) {
            if (b.type === 'thinking' && b.thinking?.trim()) v.reasoningBlock(b.thinking);
            else if (b.type === 'text') v.assistant(b.text);
            else if (b.type === 'toolCall') { v.toolStart(b.id, { name: b.name, args: b.arguments }); pendingTools.set(b.id, b); }
          }
          if (m.stopReason === 'error' && m.errorMessage) v.note(`✗ ${m.errorMessage}`, { err: true });
          if (m.stopReason === 'aborted') v.note('└ Interrupted');
          break;
        }
        case 'toolResult': {
          const call = pendingTools.get(m.toolCallId);
          const res = piToolResult(m.toolName, call?.arguments, m);
          if (m.toolName === 'subagent' && m.details?.results) this.subagents.set(m.toolCallId, m.details);
          v.toolComplete(m.toolCallId, { name: m.toolName, args: call?.arguments, error: !!m.isError, duration: m.durationMs, ...res });
          break;
        }
        case 'bashExecution':
          v.toolStart(`bx${m.timestamp}`, { name: 'bash', args: { command: '! ' + m.command } });
          v.toolComplete(`bx${m.timestamp}`, { name: 'bash', output: m.output, error: m.exitCode !== 0 && m.exitCode != null, history: true });
          break;
        case 'custom': if (m.display) v.assistant(textOf(m.content)); break;
        case 'compactionSummary': v.compaction(m.summary); break;
        case 'branchSummary': v.note(`↳ summary of abandoned branch: ${truncate(m.summary, 300)}`); break;
        default: break;
      }
    }
    if (this.subagents.size) this.app.updateSubagentCount(this.subagents.size, 0);
    this._applyState();
    v.scrollSoon(true);
  }

  // ------------------------------------------------------------ live records
  _onNotify(f) {
    const p = f.params || {};
    if (f.method === 'pi.event') { if (p.handle === this.handle) this._record(p.record); return; }
    if (f.method === 'pi.exit' && p.handle === this.handle) {
      this.handle = null;
      this.streaming = false;
      this.view.setBusy(false);
      this.view.note(`Pi exited (code ${p.code}).${p.stderr ? '\n' + p.stderr : ''} Send a message to restart it.`, { err: p.code !== 0 });
    }
  }

  _record(r) {
    const v = this.view;
    switch (r.type) {
      case 'agent_start': this.streaming = true; v.setBusy(true, 'Waiting for model…'); break;
      case 'agent_settled':
        this.streaming = false; v.closeSegment(); v.setBusy(false);
        this.refreshStats(); this.refreshState(); this.app.refreshSessionsSoon();
        break;
      case 'turn_start': v.setBusyText('Waiting for model…'); break;
      case 'message_start': {
        const m = r.message || {};
        if (m.role === 'user') {
          const text = textOf(m.content);
          const i = this.optimistic.indexOf(text);
          if (i >= 0) { this.optimistic.splice(i, 1); break; }
          if (!this._firstUser) this._firstUser = truncate(text, 80);
          v.addUser({ text, attachments: imagesOf(m.content).map(() => 'image') });
        } else if (m.role === 'assistant') {
          this.cur = { blocks: [] };
          v.setBusyText('Thinking…');
        } else if (m.role === 'custom' && m.display) v.assistant(textOf(m.content));
        else if (m.role === 'bashExecution') { /* shown via bash command */ }
        break;
      }
      case 'message_update': this._assistantEvent(r.assistantMessageEvent || {}); break;
      case 'message_end': {
        const m = r.message || {};
        if (m.role === 'assistant') {
          const finalText = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          v.closeSegment(v.segmentText() ? undefined : undefined);
          if (!this._streamedText && finalText.trim()) v.assistant(finalText);
          this._streamedText = false;
          for (const b of m.content || []) if (b.type === 'toolCall') v.toolStart(b.id, { name: b.name, args: b.arguments, pending: true });
          if (m.stopReason === 'error') v.note(`✗ ${m.errorMessage || 'model error'}`, { err: true });
          if (m.stopReason === 'aborted') v.note('└ Interrupted');
          if (m.stopReason === 'length') v.note('⚠ reply hit the max token limit');
          if (m.usage?.output && m.durationMs) v.setStatus({ tps: { v: m.usage.output / (m.durationMs / 1000), exact: true } });
          this.cur = null;
        }
        break;
      }
      case 'tool_execution_start':
        v.toolStart(r.toolCallId, { name: r.toolName, args: r.args });
        v.setBusyText(`Running ${r.toolName}…`);
        break;
      case 'tool_execution_update': {
        const pr = r.partialResult || {};
        if (r.toolName === 'subagent' && pr.details?.results) {
          this.subagents.set(r.toolCallId, pr.details);
          v.toolProgress(r.toolCallId, subagentSummary(pr.details));
          this._subagentCount();
        } else {
          const t = textOf(pr.content);
          if (t) v.toolPartial(r.toolCallId, t);
        }
        break;
      }
      case 'tool_execution_end': {
        const res = piToolResult(r.toolName, r.args, r.result);
        if (r.toolName === 'subagent' && r.result?.details?.results) { this.subagents.set(r.toolCallId, r.result.details); this._subagentCount(); }
        v.toolComplete(r.toolCallId, { name: r.toolName, args: r.args, error: !!r.isError, duration: r.durationMs, ...res });
        v.setBusyText('Thinking…');
        break;
      }
      case 'queue_update': this._queue(r.steering || [], r.followUp || []); break;
      case 'compaction_start': v.setBusy(true, `Compacting (${r.reason})…`); break;
      case 'compaction_end':
        if (r.aborted || r.errorMessage) v.note(`✗ compaction: ${r.errorMessage || 'aborted'}`, { err: true });
        else if (r.result?.summary) { v.compaction(r.result.summary); }
        if (!this.streaming) v.setBusy(false);
        this.refreshStats();
        break;
      case 'auto_retry_start': v.note(`↻ retry ${r.attempt}/${r.maxAttempts} in ${Math.round(r.delayMs / 1000)}s: ${truncate(r.errorMessage || '', 160)}`); break;
      case 'auto_retry_end': if (!r.success) v.note(`✗ retries failed: ${r.finalError || ''}`, { err: true }); break;
      case 'session_info_changed': this.state = { ...this.state, sessionName: r.name }; this._applyState(); this.app.refreshSessionsSoon(); break;
      case 'thinking_level_changed': this.state = { ...this.state, thinkingLevel: r.level }; this._applyState(); break;
      case 'extension_error': v.note(`⚠ extension error (${(r.extensionPath || '').split('/').slice(-2).join('/')}): ${r.error}`, { err: true }); break;
      case 'extension_ui_request': this._extensionUi(r); break;
      case 'hw_ui_answered': v.removePrompt(`ui:${r.id}`); break;
      default: break; // entry_appended, turn_end, agent_end, usage...
    }
  }

  _assistantEvent(e) {
    const v = this.view;
    switch (e.type) {
      case 'thinking_delta': v.reasoningDelta(e.delta); v.setBusyText('Thinking…'); break;
      case 'text_start': v.closeReasoning(); break;
      case 'text_delta': v.delta(e.delta); this._streamedText = true; v.setBusyText('Responding…'); break;
      case 'text_end': v.closeSegment(); break;
      case 'toolcall_start': v.closeSegment(); v.toolStart(e.id, { name: e.toolName, pending: true }); v.setBusyText(`Preparing ${e.toolName}…`); break;
      case 'toolcall_end': if (e.toolCall) v.toolStart(e.toolCall.id, { name: e.toolCall.name, args: e.toolCall.arguments, pending: true }); break;
      default: break;
    }
  }

  _queue(steering, followUp) {
    const items = [
      ...steering.map((t) => ({ text: `steer: ${t}` })),
      ...followUp.map((t) => ({ text: t })),
    ];
    if (items.length) items[items.length - 1].actions = [{ label: 'clear queue', run: async () => {
      const r = await this.cmd({ type: 'clear_queue' });
      const restored = [...(r.steering || []), ...(r.followUp || [])].join('\n\n');
      if (restored) this.app.prefill(restored, 'Queue cleared — messages put back in the composer');
    } }];
    this.app.renderQueue(items);
  }

  _subagentCount() {
    let total = 0, running = 0;
    for (const d of this.subagents.values()) for (const x of d.results || []) { total++; if (x.exitCode === -1) running++; }
    this.app.updateSubagentCount(total, running);
    if (this.app.drawerKind === 'subagents') this.app.openSubagents();
  }

  // extension UI (dialogs + status/widgets)
  async _extensionUi(r) {
    const v = this.view;
    const key = `ui:${r.id}`;
    const answer = (fields) => this.rpc.request('pi.ui_response', { handle: this.handle, id: r.id, ...fields }).catch((e) => v.toast(e.message, { err: true }));
    switch (r.method) {
      case 'select': {
        const choice = await v.promptChoice(key, { title: r.title || 'Choose', choices: [...(r.options || []).map((o) => ({ label: o, value: o })), { label: 'Cancel', value: null }] });
        answer(choice === null ? { cancelled: true } : { value: choice });
        break;
      }
      case 'confirm': {
        const ok = await v.promptChoice(key, { title: r.title || 'Confirm', description: r.message, choices: [{ label: 'Yes', value: true }, { label: 'No', value: false }] });
        answer({ confirmed: ok });
        break;
      }
      case 'input': case 'editor': {
        const res = await v.promptForm(key, { title: r.title || 'Input', fields: [{ id: 'v', multiline: r.method === 'editor', value: r.prefill || '', label: r.placeholder }] });
        answer(res ? { value: res.v } : { cancelled: true });
        break;
      }
      case 'notify':
        if (/^TPS:/.test(r.message || '')) break;
        v.toast(r.message || '', { err: r.notifyType === 'error' });
        break;
      case 'setStatus':
        if (r.statusText) this.status.set(r.statusKey, r.statusText); else this.status.delete(r.statusKey);
        this.app.setExtStatus([...this.status.values()].join(' · '));
        break;
      case 'setWidget':
        if (r.widgetLines && r.widgetLines.length) this.widgets.set(r.widgetKey, r.widgetLines); else this.widgets.delete(r.widgetKey);
        this.app.setWidgets([...this.widgets.values()]);
        break;
      case 'set_editor_text': this.app.prefill(r.text || ''); break;
      default: break;
    }
  }

  // ------------------------------------------------------------ input
  async _ensure() {
    if (this.handle) return;
    if (this.sid) await this.openSession(this.sid);
    else await this.newSession(this.app.cwd);
  }

  async submit(text, attachments = []) {
    await this._ensure();
    const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', data: a.data, mimeType: a.mime }));
    const files = attachments.filter((a) => a.kind === 'file');
    const full = files.length ? `${text}${text ? '\n\n' : ''}${files.map((f) => `Attached file: ${f.path}`).join('\n')}` : text;
    const busy = this.streaming;
    if (!this._firstUser) { this._firstUser = truncate(full, 80); this._applyState(); }
    if (!busy) {
      this.optimistic.push(full);
      this.view.addUser({ text: full, attachments: attachments.filter((a) => a.kind === 'image').map((a) => a.name) });
      this.view.setBusy(true, 'Waiting for model…');
    }
    const cmd = { type: 'prompt', message: full, ...(images.length ? { images } : {}), ...(busy ? { streamingBehavior: 'followUp' } : {}) };
    try {
      const r = await this.cmd(cmd);
      if (r?.disposition === 'handled') { this.view.setBusy(this.streaming); this.optimistic = this.optimistic.filter((t) => t !== full); this.refreshState(); }
    } catch (e) {
      this.view.note(`✗ ${e.message}`, { err: true });
      this.view.setBusy(this.streaming);
    }
  }

  async steer(text) { await this.cmd({ type: 'steer', message: text }); }

  async interrupt() {
    if (!this.handle) return;
    const q = await this.cmd({ type: 'clear_queue' }).catch(() => ({}));
    await this.cmd({ type: 'abort' });
    const restored = [...(q?.steering || []), ...(q?.followUp || [])].join('\n\n');
    if (restored) this.app.prefill(restored, 'Queued messages put back in the composer');
  }

  async attach(file) {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      if (this.state?.model && !(this.state.model.input || []).includes('image')) throw new Error(`${this.state.model.id} cannot see images`);
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      return { kind: 'image', name: file.name, data: dataUrl.split(',')[1], mime: file.type, preview: dataUrl };
    }
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload failed');
    return { kind: 'file', name: file.name, path: j.path };
  }

  editFrom(index) {
    this.view.promptChoice('fork', {
      title: 'Edit this message?', description: 'Pi forks a new session from just before it and puts the text back in the composer. The original session stays as it is.',
      choices: [{ label: 'Fork and edit', value: true }, { label: 'Cancel', value: false }],
    }).then(async (ok) => {
      if (!ok) return;
      try {
        const fm = (await this.cmd({ type: 'get_fork_messages' })).messages || [];
        const target = fm[index];
        if (!target) throw new Error('message not found');
        const r = await this.cmd({ type: 'fork', entryId: target.entryId });
        await this._afterSwitch();
        this.app.prefill(r.text || '', 'Forked — edit and send');
      } catch (e) { this.view.toast(`Fork failed: ${e.message}`, { err: true }); }
    });
  }

  async _afterSwitch() {
    await this.refreshState();
    this.view.clear();
    const msgs = (await this.cmd({ type: 'get_messages' })).messages || [];
    this.view.beginHistory();
    this._renderHistory(msgs);
    this.view.endHistory();
    this.app.setActive(this.sid);
    this.app.refreshSessions();
    this.refreshStats();
  }

  // ------------------------------------------------------------ completion & commands
  async _loadCommands() {
    if (this.commands || !this.handle) return this.commands || [];
    try { this.commands = (await this.cmd({ type: 'get_commands' })).commands || []; } catch { this.commands = []; }
    return this.commands;
  }

  async complete(text) {
    if (!this.ready) return null;
    if (text.startsWith('/') && !text.includes(' ')) {
      const q = text.slice(1).toLowerCase();
      const ext = await this._loadCommands();
      const items = [
        ...CLIENT_COMMANDS.map(([n, d]) => ({ label: '/' + n, desc: d, insert: n })),
        ...ext.map((c) => ({ label: '/' + c.name, desc: `${c.description || ''}${c.source !== 'extension' ? ` (${c.source})` : ''}`, insert: c.name })),
      ].filter((i) => i.insert.toLowerCase().includes(q))
        .sort((a, b) => (b.insert.toLowerCase().startsWith(q) - a.insert.toLowerCase().startsWith(q)));
      return { replaceFrom: 1, items: items.slice(0, 60) };
    }
    const m = /(?:^|\s)@([^\s]*)$/.exec(text);
    if (m) {
      const r = await this.rpc.request('pi.complete', { cwd: this.cwd || this.app.cwd, word: m[1] });
      return { replaceFrom: text.length - m[1].length, items: (r.items || []).map((i) => ({ label: i.display, insert: i.text, desc: i.kind })) };
    }
    return null;
  }

  async command(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/new': case '/clear': await this.newSession(this.cwd || this.app.cwd); return true;
      case '/model': if (!arg) { this.app.openModelPicker(); return true; }
        { const [prov, ...id] = arg.includes('/') ? arg.split('/') : [this.state?.model?.provider, arg]; await this.setModel(id.join('/'), prov); } return true;
      case '/thinking': {
        await this._ensure();
        if (!arg) { const r = await this.cmd({ type: 'get_available_thinking_levels' }); this.view.note(`Thinking levels: ${r.levels.join(', ')} (now: ${this.state?.thinkingLevel})`); return true; }
        await this.cmd({ type: 'set_thinking_level', level: arg }); await this.refreshState(); return true;
      }
      case '/compact': case '/compress': await this._ensure(); this.view.setBusy(true, 'Compacting…');
        try { await this.cmd({ type: 'compact', ...(arg ? { customInstructions: arg } : {}) }); } catch (e) { this.view.note(`✗ ${e.message}`, { err: true }); }
        if (!this.streaming) this.view.setBusy(false); this.refreshStats(); return true;
      case '/fork': {
        await this._ensure();
        const fm = (await this.cmd({ type: 'get_fork_messages' })).messages || [];
        if (!fm.length) { this.view.note('Nothing to fork from yet.'); return true; }
        const entryId = await this.view.promptChoice('fork', { title: 'Fork from which message?', choices: [...fm.map((x) => ({ label: truncate(x.text, 120), value: x.entryId })), { label: 'Cancel', value: null }] });
        if (!entryId) return true;
        const r = await this.cmd({ type: 'fork', entryId });
        await this._afterSwitch();
        this.app.prefill(r.text || '');
        return true;
      }
      case '/clone': await this._ensure(); await this.cmd({ type: 'clone' }); await this._afterSwitch(); this.view.note('└ Cloned into a new session'); return true;
      case '/name': case '/rename': if (arg) await this.rename(arg); return true;
      case '/diff': this.app.openChanges(); return true;
      case '/agents': case '/subagents': this.app.openSubagents(); return true;
      case '/stop': await this.interrupt(); return true;
      case '/export': { await this._ensure(); const r = await this.cmd({ type: 'export_html' }); this.view.note(`Exported to ${r.path}`); return true; }
      case '/delete': this.view.toast('Deleting Pi sessions is not supported here — remove the file under ~/.pi/agent/sessions', { err: true }); return true;
      default: break;
    }
    // extension commands, prompt templates, skills: sent as a prompt
    const known = (await this._loadCommands()).some((c) => '/' + c.name === cmd);
    if (!known) { this.view.toast(`Unknown command ${cmd} — sent as text. Use // to send a literal slash.`); }
    await this.submit(line);
    return true;
  }

  async modelOptions() {
    await this._ensure();
    const r = await this.cmd({ type: 'get_available_models' });
    const cur = this.state?.model;
    return (r.models || []).map((m) => ({
      group: m.provider, label: m.id, value: { model: m.id, provider: m.provider },
      desc: [m.name !== m.id ? m.name : '', m.contextWindow ? `${fmtTokens(m.contextWindow)} ctx` : '', (m.input || []).includes('image') ? 'images' : '', m.reasoning ? 'reasoning' : '', m.cost?.input ? `$${m.cost.input}/$${m.cost.output} per M` : 'free'].filter(Boolean).join(' · '),
      current: cur && cur.id === m.id && cur.provider === m.provider,
    }));
  }

  async setModel(model, provider) {
    await this._ensure();
    await this.cmd({ type: 'set_model', provider, modelId: model });
    await this.refreshState();
    this.view.note(`└ Model set to ${provider}/${model}`);
    this.refreshStats();
  }

  async rename(name) { await this._ensure(); await this.cmd({ type: 'set_session_name', name }); await this.refreshState(); this.app.refreshSessions(); }
  async deleteSession() { if (this.sid) await this.deleteById(this.sid); }

  // Pi has no delete command: the bridge stops the session's process and moves
  // its file to Stellwerk's trash folder.
  async deleteById(path) {
    const r = await this.rpc.request('pi.delete', { session_path: path });
    if (path === this.sid) {
      this.sid = null; this.handle = null; this.state = null;
      this.view.clear(); this.view.setTitle('');
    }
    this.view.toast(`Session moved to ${homeify(r.trashed, this.home)}`, { ms: 5000 });
  }

  async sessionUsage() {
    if (!this.handle) return null;
    const st = await this.cmd({ type: 'get_session_stats' });
    const t = st.tokens || {};
    return { input: t.input, output: t.output, cache_read: t.cacheRead, cache_write: t.cacheWrite, reasoning: null,
      calls: st.assistantMessages, cost: st.cost, model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : '' };
  }

  async effortOptions() {
    await this._ensure();
    const r = await this.cmd({ type: 'get_available_thinking_levels' });
    return { current: this.state?.thinkingLevel || null, levels: (r.levels || []).map((l) => ({ id: l, name: l, desc: l === 'off' ? 'No thinking' : '' })),
      note: (r.levels || []).length <= 1 ? 'This model has no thinking levels.' : '' };
  }

  async setEffort(level) {
    await this._ensure();
    await this.cmd({ type: 'set_thinking_level', level });
    await this.refreshState();
    this.view.note(`└ Thinking level: ${this.state?.thinkingLevel || level}`);
  }
  loadCatalog() { /* commands load lazily */ }

  // ------------------------------------------------------------ drawers
  async changesPanel() {
    const box = h('div');
    const cwd = this.cwd || this.app.cwd;
    const r = await fetch('/api/gitdiff?cwd=' + encodeURIComponent(cwd)).then((x) => x.json());
    if (r.error) { box.append(h('div', { class: 'dr-empty', text: r.error })); return box; }
    if (!r.git) { box.append(h('div', { class: 'dr-empty', text: `${homeify(cwd, this.home)} is not a git repository, so there is nothing to diff. Pi has no checkpoints; edits made this session are shown inline in the transcript.` })); return box; }
    box.append(h('div', { class: 'dr-section' }, h('h3', { text: 'git status' }), h('pre', { class: 'dr-meta', style: 'white-space:pre-wrap', text: r.status || 'clean' })));
    const s = h('div', { class: 'dr-section' }, h('h3', { text: 'Uncommitted changes (vs HEAD)' }));
    s.append(r.diff ? renderDiff(r.diff, { home: this.home }) : h('div', { class: 'dr-empty', text: 'No changes to tracked files.' }));
    if (r.untracked?.length) s.append(h('div', { class: 'dr-meta', style: 'margin-top:8px', text: `Untracked: ${r.untracked.join(', ')}` }));
    box.append(s);
    return box;
  }

  async subagentsPanel() {
    const box = h('div');
    const runs = [...this.subagents.values()].flatMap((d) => (d.results || []).map((x) => ({ ...x, mode: d.mode })));
    if (!runs.length) { box.append(h('div', { class: 'dr-empty', text: 'No subagent runs in this session.' })); return box; }
    for (const x of runs) {
      const status = x.exitCode === -1 ? 'running' : x.exitCode === 0 ? 'completed' : 'failed';
      const last = (x.messages || []).filter((m) => m.role === 'assistant').pop();
      const lastText = last ? textOf(last.content) : '';
      const tools = (x.messages || []).flatMap((m) => (m.role === 'assistant' ? (m.content || []).filter((b) => b.type === 'toolCall') : []));
      box.append(h('div', { class: 'dr-item' },
        h('div', { class: 'dr-item-head' }, h('span', { class: `sub-status ${status}`, text: status }), h('span', { class: 'grow', text: `${x.agent}${x.step != null ? ` (step ${x.step})` : ''}` })),
        h('div', { class: 'dr-meta', text: [x.mode, x.model, `${tools.length} tool calls`, x.usage?.cost ? `$${x.usage.cost.toFixed(3)}` : '', x.usage?.turns ? `${x.usage.turns} turns` : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'sub-tail', text: `Task: ${x.task || ''}` }),
        tools.length ? h('div', { class: 'sub-tail', text: tools.slice(-8).map((t) => `• ${t.name} ${truncate(JSON.stringify(t.arguments || {}), 100)}`).join('\n') }) : null,
        lastText ? h('div', { class: 'sub-tail', text: truncate(lastText, 2000) }) : null,
        x.errorMessage ? h('div', { class: 'sub-tail', style: 'color:var(--err)', text: x.errorMessage }) : null));
    }
    return box;
  }
}
