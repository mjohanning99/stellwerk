// Hermes backend: speaks hermes-gateway-v1 JSON-RPC (relayed by the bridge at /ws).
// See PROTOCOL.md for the wire reference.

import { Rpc } from './rpc.js';
import { h, renderDiff, stripAnsi } from './ui.js';
import { relTime, truncate, homeify } from './render.js';

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}));

const WINDOW_REQUESTS = new Set(['preview.read', 'preview.act', 'terminal.read', 'window.read', 'theme.apply', 'theme.pick',
  'tour', 'setup_beat', 'display.install.sudo', 'vault.code', 'vault.save_login', 'vault.unlock_prompt']);

function dayGroup(ts) {
  if (!ts) return 'Older';
  const t = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(t), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Older';
}

// Extract a unified diff / old-new pair from a hermes tool call.
function toolDiff(name, args, result, inlineDiff) {
  if (result) {
    try {
      const r = typeof result === 'string' ? JSON.parse(result) : result;
      if (r && typeof r.diff === 'string' && r.diff.trim()) return { diff: r.diff };
    } catch { /* not JSON */ }
  }
  if (inlineDiff) {
    // ANSI pre-rendered: drop header/omitted lines, keep @@ +/- lines
    const lines = stripAnsi(inlineDiff).split('\n').filter((l) => /^(@@|[+\- ]|a\/|---|\+\+\+)/.test(l));
    if (lines.some((l) => l.startsWith('+') || l.startsWith('-'))) return { diff: lines.map((l) => l.replace(/^a\/(.*) → b\/(.*)$/, '+++ $2')).join('\n') };
  }
  if (args && typeof args === 'object') {
    if (args.old_string !== undefined && args.new_string !== undefined) return { oldNew: { old: args.old_string, new: args.new_string, path: args.path } };
    if (name === 'write_file' && typeof args.content === 'string') {
      const lines = args.content.split('\n');
      const shown = lines.slice(0, 400);
      return { diff: `+++ ${args.path || ''}\n@@ -0,0 +1,${lines.length} @@\n` + shown.map((l) => '+' + l).join('\n') + (lines.length > 400 ? `\n\\ … ${lines.length - 400} more lines` : '') };
    }
    if (args.mode === 'patch' && typeof args.patch === 'string') {
      return { diff: args.patch.split('\n').filter((l) => !l.startsWith('*** Begin') && !l.startsWith('*** End')).map((l) => l.replace(/^\*\*\* (Update|Add|Delete) File: (.*)$/, '+++ $2')).join('\n') };
    }
  }
  return {};
}

function toolOutput(result) {
  if (result == null) return '';
  if (typeof result !== 'string') { try { return JSON.stringify(result, null, 2); } catch { return String(result); } }
  try {
    const r = JSON.parse(result);
    if (r && typeof r === 'object') {
      if (typeof r.output === 'string') return r.output + (r.error ? `\n${r.error}` : '') + (r.truncated ? '\n… (truncated)' : '');
      if (typeof r.content === 'string') return r.content;
      if (typeof r.error === 'string') return r.error;
      if (typeof r.result === 'string') return r.result;
      return JSON.stringify(r, null, 2);
    }
  } catch { /* plain text */ }
  return result;
}

export class HermesBackend {
  constructor(view, app) {
    this.view = view;
    this.app = app;
    this.name = 'hermes';
    this.appName = 'Hermes';
    this.rpc = new Rpc('/ws');
    this.sid = null;
    this.s = {};               // live session state: revision, gen, replayEpoch, lastSeq, subId, info, pending
    this.subagents = new Map();
    this.ready = false;
    this.readyWaiters = [];
    this.userRows = [];        // row_ids of user turns in display order
    this.editing = null;       // {index, rowId}
    this.queuedText = new Map(); // admission_id -> {text, images} for prompts shown in the queue
    this.startedAdmissions = new Set();
    this.home = '';
    this.rpc.serverRequestHandler = (m, p, id) => this._serverRequest(m, p, id);
    this.rpc.addEventListener('state', (e) => this._onState(e.detail));
    this.rpc.addEventListener('event', (e) => this._onEvent(e.detail));
    this.rpc.addEventListener('bridge-error', (e) => this.view.toast(`Bridge: ${e.detail.message}`, { err: true, ms: 8000 }));
    this.rpc.addEventListener('unauthorized', () => this.app.showLogin());
  }

  start() { this.rpc.start(); }
  stop() { clearInterval(this._hb); this.rpc.stop(); }

  whenReady() { return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r)); }

  _onState({ state }) {
    this.view.setConn(state);
    if (state !== 'open') { this.ready = false; clearInterval(this._hb); }
  }

  async _handshake(payload) {
    try {
      await this.rpc.request('client.capabilities', { server_requests: true });
      this.runtime = await this.rpc.request('runtime.describe', {});
    } catch (e) {
      this.view.toast(`Handshake failed: ${e.message}`, { err: true });
      return;
    }
    clearInterval(this._hb);
    if (payload?.heartbeat) {
      let n = 0;
      this._hb = setInterval(() => { this.rpc.request('gateway.ping', {}, { timeout: 45000 }).catch(() => {}); n++; }, 15000);
    }
    this.ready = true;
    this.readyWaiters.splice(0).forEach((r) => r());
    this.app.refreshSessions();
    if (this.sid) this._reattach();
  }

  // ------------------------------------------------------------ sessions

  // A page of the sidebar: {items, next}. With a query, the server searches titles and
  // message text in Hermes' store (the gateway itself only matches titles).
  async listSessions(query, { limit = 40, cursor = null } = {}) {
    await this.whenReady();
    if (query) {
      const r = await fetch('/api/search/hermes?q=' + encodeURIComponent(query)).then((x) => x.json()).catch(() => ({ available: false }));
      if (r.available) {
        return { next: null, items: r.sessions.map((s) => ({
          id: s.id, title: s.title || truncate(s.snippet || 'Untitled', 70), snippet: s.snippet,
          sub: [s.cwd ? homeify(s.cwd, this.home) : '', s.message_count ? `${s.message_count} msgs` : ''].filter(Boolean).join(' · '),
          time: s.last_active_at, raw: s,
        })) };
      }
    }
    const params = { scope: 'stored', picker: true, limit: Math.min(limit, 200) };
    if (query) params.query = query;
    if (cursor) params.cursor = cursor;
    const [stored, live] = await Promise.all([
      this.rpc.request('session.list', params),
      cursor ? { sessions: [] } : this.rpc.request('session.list', { scope: 'live', picker: true }).catch(() => ({ sessions: [] })),
    ]);
    const liveIds = new Set((live.sessions || []).filter((s) => s.running).map((s) => s.session_id));
    // Hermes only stores sessions once they have messages; a new session you named
    // is live-only until then, so take titled live sessions too (unless searching).
    const liveTitled = query ? [] : (live.sessions || []).filter((s) => s.title);
    const rows = [...liveTitled, ...(stored.sessions || [])].filter((s) => s.message_count > 0 || s.preview || s.title || s.running || s.session_id === this.sid);
    const seen = new Set();
    const items = rows.filter((s) => !seen.has(s.session_id) && seen.add(s.session_id)).map((s) => ({
      id: s.session_id,
      title: s.title || truncate(s.preview || 'Untitled', 70),
      sub: [s.workspace ? homeify(s.workspace, this.home) : '', s.message_count ? `${s.message_count} msgs` : ''].filter(Boolean).join(' · '),
      time: s.last_active_at || s.started_at,
      group: dayGroup(s.last_active_at || s.started_at),
      live: s.running || liveIds.has(s.session_id),
      raw: s,
    }));
    return { items, next: stored.next_cursor || null };
  }

  async newSession(cwd) {
    await this.whenReady();
    await this._detach();
    const params = { source: 'tui', request_id: uuid(), checkpoints: true };
    if (cwd) params.cwd = cwd;
    if (this.runtime?.session_create?.parameters?.includes('client')) params.client = { name: 'stellwerk', version: this.app.me?.version || '0' };
    const snap = await this.rpc.request('session.create', params);
    this._applySnapshot(snap, true);
    return snap.session_id;
  }

  async openSession(id) {
    await this.whenReady();
    if (id !== this.sid) await this._detach();
    this.sid = id;
    const snap = await this.rpc.request('session.resume', { session_id: id, display_projection: true }, { timeout: 60000 });
    this._applySnapshot(snap, true);
  }

  async _reattach() {
    const sid = this.sid;
    try {
      if (this.s.replayEpoch && this.s.lastSeq != null) {
        const ev = await this.rpc.request('session.events.since', { session_id: sid, last_sequence: this.s.lastSeq, replay_epoch: this.s.replayEpoch });
        if (!ev.snapshot_required && !ev.truncated) {
          this._resubscribe = true;
          const snap = await this.rpc.request('session.resume', { session_id: sid, display_projection: true, omit_messages: true });
          this._resubscribe = false;
          this._applyMeta(snap);
          for (const e of ev.events || []) this._onEvent({ type: e.type, payload: e.payload || {}, session_id: e.session_id, raw: e });
          this._renderPrompts(snap);
          return;
        }
      }
      await this.openSession(sid);
    } catch (e) {
      this.view.toast(`Could not reattach: ${e.message}`, { err: true });
    }
  }

  async _detach() {
    if (this.sid && this.s.subId) {
      this.rpc.request('session.detach', { session_id: this.sid, subscription_id: this.s.subId }).catch(() => {});
    }
    this.sid = null;
    this.s = {};
    this.subagents.clear();
    this.app.updateSubagentCount(0);
  }

  _applyMeta(snap) {
    Object.assign(this.s, {
      subId: snap.subscription_id ?? this.s.subId,
      revision: snap.revision ?? this.s.revision,
      gen: snap.execution_generation ?? this.s.gen,
      replayEpoch: snap.replay_epoch ?? this.s.replayEpoch,
      lastSeq: snap.last_sequence ?? this.s.lastSeq,
    });
    if (snap.info) this._mergeInfo(snap.info);
    if (snap.pending) this._setPending(snap.pending);
    this.running = !!snap.running;
    this.view.setBusy(this.running);
  }

  _applySnapshot(snap, rerender) {
    this.sid = snap.session_id;
    this.s = {};
    this.info = {};
    this._applyMeta(snap);
    if (rerender) {
      this.view.clear();
      this.view.beginHistory();
      this._renderHistory(snap.display_messages || snap.messages || [], snap.messages || []);
      this.view.endHistory();
      if (snap.todo_state?.todos?.length) this.todos = snap.todo_state.todos;
      if (snap.running) this.view.note('… a turn is running — new output will stream in');
    }
    this._renderPrompts(snap);
    this.app.setActive(this.sid);
    this.refreshStats();
  }

  _renderPrompts(snap) {
    for (const p of snap.prompts || []) this._showPendingPrompt(p);
    for (const r of snap.open_requests || []) this.rpc._answerServerRequest(r);
  }

  _renderHistory(rows, stored) {
    const v = this.view;
    this.userRows = (stored || []).filter((m) => m.role === 'user' && !m.display_kind).map((m) => m.row_id);
    let ui = 0;
    let tc = 0;
    for (const r of rows) {
      if (r.row_kind === 'compaction') { v.compaction(r.text); continue; }
      if (r.role === 'user') {
        const idx = ui++;
        if (r.display_kind && r.display_kind !== 'skill_invocation') { v.note(`↳ ${r.display_kind.replace(/_/g, ' ')}: ${truncate(r.text || '', 200)}`); continue; }
        v.addUser({ text: r.text || '', onEdit: (t) => this.beginEdit(idx, t) });
      } else if (r.role === 'assistant') {
        if (r.reasoning) v.reasoningBlock(r.reasoning);
        v.assistant(r.text);
      } else if (r.role === 'tool') {
        const id = r.tool_call_id || `h${tc++}`;
        const d = toolDiff(r.name, r.args, r.content);
        v.toolStart(id, { name: r.name, args: r.args, context: r.labels?.[0]?.text || r.context });
        v.toolComplete(id, { name: r.name, output: r.content ? toolOutput(r.content) : '', summary: r.content ? undefined : '', history: true, ...d });
      } else if (r.role === 'system') {
        v.note(r.text);
      }
    }
    v.scrollSoon(true);
  }

  // ------------------------------------------------------------ info / stats

  _mergeInfo(info) {
    this.info = { ...(this.info || {}), ...info };
    const i = this.info;
    if (info.revision != null) this.s.revision = info.revision;
    if (info.execution_generation != null) this.s.gen = info.execution_generation;
    if (i.cwd) this.app.cwd = i.cwd;
    this.view.setStatus({ model: i.model || undefined, effort: i.model ? `effort ${i.reasoning_effort || 'default'}` : undefined, cwd: i.cwd });
    if (i.usage) this._usage(i.usage);
    this.view.setTitle(i.title || this._title || 'New session', [homeify(i.cwd || '', this.home), i.provider && i.provider !== 'auto' ? i.provider : ''].filter(Boolean).join(' · '));
  }

  _usage(u) {
    if (!u) return;
    const ctx = u.context_max || u.context_used ? { used: u.context_used || 0, max: u.context_max, pct: u.context_percent } : undefined;
    this.view.setStatus({ context: ctx, cost: u.cost_usd || (u.total ? `${fmtTok(u.total)} tok` : undefined) });
  }

  async refreshStats() {
    if (!this.sid) return;
    try {
      const st = await this.rpc.request('session.stats', { session_id: this.sid });
      if (st.context_length || st.context_tokens) this.view.setStatus({ context: { used: st.context_tokens || st.last_prompt_tokens || 0, max: st.context_length } });
    } catch { /* optional */ }
  }

  _setPending(pending) {
    this.pending = (pending || []).filter((p) => p.status === 'queued' || p.status === 'unknown');
    this.app.renderQueue(this.pending.map((p) => ({
      id: p.admission_id,
      text: p.text || '(attachment)',
      unknown: p.status === 'unknown',
      actions: [
        ...(p.controls?.includes('steer') ? [{ label: 'steer now', run: () => this.rpc.request('prompt.steer_queued', { session_id: this.sid, admission_id: p.admission_id }) }] : []),
        ...(p.status === 'unknown' ? [{ label: 'resolve', run: () => this.rpc.request('prompt.resolve_unknown', { session_id: this.sid, admission_id: p.admission_id, execution_generation: p.execution_generation ?? this.s.gen }) }] : []),
        { label: '✕', run: () => this.rpc.request('prompt.cancel', { session_id: this.sid, admission_id: p.admission_id }) },
      ],
    })));
  }

  // ------------------------------------------------------------ events

  _onEvent({ type, payload: p, session_id, raw }) {
    if (type === 'gateway.ready') { this._handshake(p); return; }
    if (type === 'sessions.changed') { this.app.refreshSessionsSoon(); return; }
    if (type === 'skin.changed' || type === 'cron.changed' || type === 'projects.changed' || type === 'skills.changed') return;
    if (session_id && this.sid && session_id !== this.sid && !String(this.sid).startsWith(String(session_id).slice(0, 22))) return;
    if (raw?.seq != null) {
      if (raw.replay_epoch && raw.replay_epoch === this.s.replayEpoch && this.s.lastSeq != null && raw.seq <= this.s.lastSeq && !this._resubscribe) return;
      this.s.lastSeq = raw.seq;
      if (raw.replay_epoch) this.s.replayEpoch = raw.replay_epoch;
    }
    if (raw?.execution_generation != null) this.s.gen = raw.execution_generation;
    const v = this.view;

    switch (type) {
      case 'message.start': {
        const adm = raw?.admission_id;
        const q = adm && this.queuedText.get(adm);
        if (q) {
          this.queuedText.delete(adm);
          const idx = this.userRows.length;
          v.addUser({ text: q.text, attachments: q.images.map((a) => a.name), onEdit: (t) => this.beginEdit(idx, t) });
        }
        this.running = true; v.setBusy(true, 'Thinking…');
        if (p.display_kind && p.display_text) v.note(`↳ ${p.display_text}`);
        break;
      }
      case 'message.delta': v.delta(p.text ?? null); v.setBusyText('Responding…'); break;
      case 'message.interim': if (!p.already_streamed && p.text) { v.closeSegment(); v.assistant(p.text); } else v.closeSegment(); break;
      case 'reasoning.delta': v.reasoningDelta(p.text); v.setBusyText('Thinking…'); break;
      case 'reasoning.available': if (p.text && !v.reasoning) v.reasoningBlock(p.text); break;
      case 'thinking.delta': if (p.text) v.setBusyText(truncate(p.text, 60)); break;
      case 'tool.generating': v.closeSegment(); v.setBusyText(`Preparing ${p.name || 'tool'}…`); break;
      case 'tool.start':
        v.toolStart(p.tool_id || p.tool_call_id, { name: p.name || p.tool_name, args: p.args, context: p.labels?.[0]?.text || p.context });
        v.setBusyText(`Running ${p.name || 'tool'}…`);
        break;
      case 'tool.progress': v.toolProgress(p.tool_id, p.message || (p.percent != null ? `${Math.round(p.percent)}%` : `${p.progress}${p.total ? '/' + p.total : ''}`)); break;
      case 'tool.complete': {
        const d = toolDiff(p.name, p.args, p.result, p.inline_diff);
        v.toolComplete(p.tool_id || p.tool_call_id, {
          name: p.name, args: p.args, error: !!p.is_error, output: p.result_text || toolOutput(p.result),
          duration: p.duration_s != null ? p.duration_s * 1000 : undefined, todos: p.todos, ...d,
        });
        if (p.todos) this.todos = p.todos;
        v.setBusyText('Thinking…');
        break;
      }
      case 'todo.updated': this.todos = p.todos; break;
      case 'status.update': if (p.text) v.setBusyText(truncate(p.text, 60)); break;
      case 'agent.print': case 'notice': v.note(p.text || p.message); break;
      case 'notification.show': v.toast(p.text || p.detail || '', { err: p.level === 'error', ms: p.ttl_ms || 4000 }); break;
      case 'session.usage': this._usage(p.usage || p); break;
      case 'session.info': {
        this._mergeInfo(p);
        if (p.pending) this._setPending(p.pending);
        if (p.running !== undefined) { this.running = p.running; v.setBusy(p.running); }
        break;
      }
      case 'session.title': this._title = p.title; this.info.title = p.title; v.setTitle(p.title); this.app.refreshSessionsSoon(); break;
      case 'session.updated': if (p.revision != null) this.s.revision = p.revision; if (p.model) this._mergeInfo({ model: p.model, provider: p.provider }); break;
      case 'message.complete': {
        const streamed = v.segmentText();
        const finalText = p.text && (p.response_transformed || !streamed.trim()) ? p.text : undefined;
        v.closeSegment(finalText);
        if (p.status === 'error' || p.failure_reason) {
          const es = p.error_surface;
          v.note(`✗ ${p.failure_reason || es?.code || 'error'}${es?.provider ? ` (${es.provider}${es.model ? '/' + es.model : ''})` : ''}`, { err: true });
        } else if (p.status === 'interrupted') v.note('└ Interrupted');
        if (p.warning) v.note(`⚠ ${p.warning}`);
        if (p.usage) this._usage(p.usage);
        if (p.usage?.avg_tps) v.setStatus({ tps: { v: p.usage.avg_tps, exact: true } });
        if (p.persisted_turn?.user_row_id) this.userRows.push(p.persisted_turn.user_row_id);
        this.refreshStats();
        this.app.refreshSessionsSoon();
        break;
      }
      case 'approval.request': this._showPendingPrompt({ ...p, kind: 'approval' }); break;
      case 'clarify.request': this._showPendingPrompt({ ...p, kind: 'clarify' }); break;
      case 'approval.settled': case 'clarify.settled': v.removePrompt(`p:${p.prompt_id}`); break;
      case 'approval.cancelled': (p.request_ids || []).forEach((id) => v.removePrompt(`p:${id}`)); break;
      case 'request.cancel': v.removePrompt(`r:${p.id}`); break;
      case 'session.reclaimed': case 'session.replay_gap': if (this.sid) this.openSession(this.sid); break;
      case 'error': v.note(`✗ ${p.message}`, { err: true }); break;
      case 'review.summary': case 'background.complete': case 'btw.complete':
        v.note(`↳ ${type.split('.')[0]}${p.question ? `: ${p.question}` : ''}`); v.assistant(p.text); break;
      default:
        if (type.startsWith('subagent.')) this._subagent(type, p);
    }
  }

  _subagent(type, p) {
    const id = p.subagent_id || `${p.delegation_id}:${p.task_index}`;
    const cur = this.subagents.get(id) || { id, goal: p.goal, status: 'queued', tools: 0 };
    Object.assign(cur, Object.fromEntries(Object.entries(p).filter(([, val]) => val !== undefined && val !== null)));
    if (type === 'subagent.start') cur.status = 'running';
    if (type === 'subagent.complete') cur.status = p.status || 'completed';
    if (type === 'subagent.tool') cur.lastTool = `${p.tool_name || ''} ${p.tool_preview || ''}`.trim();
    this.subagents.set(id, cur);
    const running = [...this.subagents.values()].filter((s) => s.status === 'running' || s.status === 'queued').length;
    this.app.updateSubagentCount(this.subagents.size, running);
    if (type === 'subagent.start') this.view.setBusyText(`Subagent: ${truncate(p.goal || '', 40)}`);
    if (this.app.drawerKind === 'subagents') this.app.openSubagents();
  }

  // ------------------------------------------------------------ prompts

  async _showPendingPrompt(p) {
    const key = `p:${p.prompt_id}`;
    const gen = p.execution_generation ?? this.s.gen;
    if (p.kind === 'approval') {
      const labels = { once: 'Yes', session: 'Yes, and don\'t ask again this session', always: 'Yes, always', deny: 'No, and tell Hermes what to do differently' };
      const choices = (p.choices || ['once', 'deny']).map((c) => ({ label: labels[c] || c, value: c }));
      const choice = await this.view.promptChoice(key, { title: 'Hermes wants to run this — allow?', command: p.command, description: p.description, choices });
      try { await this.rpc.request('approval.respond', { session_id: this.sid, execution_generation: gen, prompt_id: p.prompt_id, choice }); }
      catch (e) { this.view.toast(`Approval failed: ${e.message}`, { err: true }); }
    } else if (p.kind === 'clarify') {
      const res = await this.view.promptForm(key, {
        title: 'Hermes has a question', fields: [{ id: 'a', label: p.question, choices: p.choices, multi: p.multi_select }], cancelLabel: 'Skip',
      });
      try { await this.rpc.request('clarify.respond', { session_id: this.sid, execution_generation: gen, prompt_id: p.prompt_id, answer: res ? res.a : '' }); }
      catch (e) { this.view.toast(`Answer failed: ${e.message}`, { err: true }); }
    }
  }

  async _serverRequest(method, p, id) {
    const key = `r:${id}`;
    if (method === 'sudo') {
      const r = await this.view.promptForm(key, { title: 'Hermes needs your sudo password', description: p.command, fields: [{ id: 'v', secret: true }] });
      return { value: r ? r.v : '' };
    }
    if (method === 'secret') {
      const r = await this.view.promptForm(key, { title: `Hermes needs ${p.env_var || 'a secret'}`, description: p.prompt, fields: [{ id: 'v', secret: true }] });
      return { value: r ? r.v : '' };
    }
    if (method === 'clarify') {
      const r = await this.view.promptForm(key, {
        title: 'Hermes has questions', fields: (p.questions || []).map((q) => ({ id: q.qid, label: q.question, choices: q.choices, multi: q.multi_select })), cancelLabel: 'Skip',
      });
      if (!r) return { answers: {}, outcome: 'cancelled' };
      return { answers: r, outcome: 'submitted' };
    }
    if (method === 'approval') {
      const choices = (p.choices || ['once', 'session', 'deny']).map((c) => ({ label: c, value: c }));
      const choice = await this.view.promptChoice(key, { title: `Allow ${p.tool_name || 'this'}?`, command: p.command, description: p.description, choices });
      return { choice };
    }
    if (WINDOW_REQUESTS.has(method)) {
      const e = new Error('no window shows this session'); e.code = 4404; throw e;
    }
    return undefined; // -> -32601
  }

  // ------------------------------------------------------------ input

  beginEdit(index, text) {
    const rowId = this.userRows[index];
    if (rowId == null) { this.view.toast('This message cannot be edited (no stored row yet)', { err: true }); return; }
    this.editing = { index, rowId };
    this.app.prefill(text, `Editing message ${index + 1} — Enter resends from here, Esc cancels`);
  }
  cancelEdit() { this.editing = null; }

  async submit(text, attachments = []) {
    if (!this.sid) await this.newSession(this.app.cwd);
    if (this.editing) {
      const { rowId } = this.editing;
      this.editing = null;
      if (this.running) await this.interrupt().catch(() => {});
      const r = await this._mutate('rewind', { target_message_id: rowId });
      if (!r) return;
      const snap = await this.rpc.request('session.resume', { session_id: this.sid, display_projection: true });
      this._applySnapshot(snap, true);
    }
    const images = attachments.filter((a) => a.kind === 'image');
    const refs = attachments.filter((a) => a.kind === 'file').map((a) => a.ref).join(' ');
    const full = refs ? `${text}${text ? '\n\n' : ''}${refs}` : text;
    const queued = this.running;
    const row = this.view.addUser({ text: full, attachments: images.map((a) => a.name), queued });
    const idx = this.userRows.length;
    row.querySelector('.user-actions')?.append(h('button', { text: 'edit', onclick: () => this.beginEdit(idx, full) }));
    if (!queued) this.view.setBusy(true, 'Thinking…');
    try {
      const res = await this.rpc.request('prompt.submit', {
        session_id: this.sid, submission_id: uuid(), text: full,
        ...(images.length ? { attachments: images.map((a) => ({ path: a.path, mime: a.mime })) } : {}),
      }, { timeout: 30 * 60 * 1000 });
      if (res.status === 'queued' && this.running) { row.remove(); this.queuedText.set(res.admission_id, { text: full, images }); }
      else { row.classList.remove('queued'); this.startedAdmissions.add(res.admission_id); }
    } catch (e) {
      row.classList.add('queued');
      this.view.note(`✗ ${e.message}`, { err: true });
      this.view.setBusy(this.running);
    }
  }

  async interrupt() {
    if (!this.sid) return;
    await this.rpc.request('session.interrupt', { session_id: this.sid, execution_generation: this.s.gen });
  }

  async steer(text) {
    try {
      const r = await this.rpc.request('session.steer', { session_id: this.sid, execution_generation: this.s.gen, text });
      if (r.status === 'rejected') throw new Error('rejected');
      this.view.note(`↳ steer: ${text}`);
    } catch {
      await this.submit(text);
    }
  }

  async attach(file) {
    if (!this.sid) await this.newSession(this.app.cwd);
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      const r = await this.rpc.request('image.attach_bytes', { session_id: this.sid, content_base64: dataUrl, filename: file.name });
      return { kind: 'image', name: file.name, path: r.path, mime: r.mime || file.type, preview: dataUrl };
    }
    const r = await this.rpc.request('file.attach', { session_id: this.sid, data_url: dataUrl, name: file.name });
    return { kind: 'file', name: file.name, ref: r.ref_text || `@file:${r.path}` };
  }

  // ------------------------------------------------------------ completion & commands

  async complete(text) {
    if (!this.ready) return null;
    if (text.startsWith('/') && !text.includes('\n')) {
      const r = await this.rpc.request('complete.slash', { text, ...(this.sid ? { session_id: this.sid } : {}) });
      return { replaceFrom: r.replace_from ?? 1, items: (r.items || []).filter((i) => !this._terminalOnly(i.display || i.text)).slice(0, 60).map((i) => ({ label: i.display || i.text, desc: i.meta, insert: i.text })) };
    }
    const m = /(?:^|\s)@([^\s]*)$/.exec(text);
    if (m) {
      const r = await this.rpc.request('complete.path', { word: m[1] || './', ...(this.sid ? { session_id: this.sid } : {}), cwd: this.app.cwd });
      return { replaceFrom: text.length - m[1].length, items: (r.items || []).slice(0, 60).map((i) => ({ label: i.display || i.text, desc: i.meta, insert: i.text })) };
    }
    return null;
  }

  _terminalOnly(cmd) {
    const c = this.catalog?.commands?.[cmd];
    return c && c.desktop === 'terminal' && !['/clear', '/new'].includes(cmd);
  }

  async loadCatalog() {
    try { this.catalog = await this.rpc.request('commands.catalog', this.sid ? { session_id: this.sid } : {}); } catch { /* optional */ }
  }

  // returns true if handled
  async command(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/new': case '/clear': case '/reset':
        await this.newSession(this.app.cwd); this.app.refreshSessions(); return true;
      case '/model':
        if (!arg) { this.app.openModelPicker(); return true; }
        await this.setModel(arg.split(/\s+--provider\s+/)[0], (arg.split(/\s+--provider\s+/)[1] || '').trim() || undefined); return true;
      case '/compress': case '/compact':
        await this._mutate('compress', arg ? { focus: arg } : {}); this.view.note('└ Compressing context…'); return true;
      case '/branch': case '/fork': {
        const r = await this._mutate('branch', arg ? { title: arg } : {});
        if (r?.session_id && r.session_id !== this.sid) { await this.openSession(r.branched_session_id || r.new_session_id || r.session_id); }
        this.app.refreshSessions(); return true;
      }
      case '/rename': case '/title':
        if (arg) { await this._mutate('rename', { title: arg }); this.view.setTitle(arg); this.app.refreshSessions(); } return true;
      case '/stop': case '/interrupt': await this.interrupt(); return true;
      case '/diff': case '/rollback': case '/checkpoints': this.app.openChanges(); return true;
      case '/agents': case '/subagents': this.app.openSubagents(); return true;
      default: break;
    }
    if (!this.sid) await this.newSession(this.app.cwd);
    try {
      const r = await this.rpc.request('slash.exec', { session_id: this.sid, command: line.trim() });
      if (r.type === 'send' || r.type === 'skill') { if (r.message) await this.submit(r.message); }
      else if (r.type === 'prefill') this.app.prefill(r.message || '');
      else if (r.type === 'alias' && r.target) return this.command(r.target + (arg ? ' ' + arg : ''));
      const out = r.output || r.notice || r.display || (r.type === 'exec' ? r.message : '');
      if (out) { const el = this.view.note(''); el.replaceWith(Object.assign(document.createElement('pre'), { className: 'row row-note', textContent: stripAnsi(out), style: 'white-space:pre-wrap;margin:0 0 14px' })); }
      if (r.warning) this.view.note(`⚠ ${r.warning}`);
    } catch (e) {
      this.view.note(`✗ ${line.split(' ')[0]}: ${e.data?.detail || e.message}`, { err: true });
    }
    return true;
  }

  async _mutate(operation, payload, extra = {}) {
    // the contract requires expected_generation for these (gateway-contract.generated.ts, session.mutate)
    const needsGen = ['delete', 'rewind', 'reset', 'branch', 'model', 'compress', 'reasoning', 'workspace'].includes(operation);
    const go = (pl) => this.rpc.request('session.mutate', {
      session_id: this.sid, request_id: uuid(), expected_revision: this.s.revision, operation, payload: pl,
      ...(needsGen ? { expected_generation: this.s.gen } : {}), ...extra,
    });
    let r;
    try { r = await go(payload); }
    catch (e) {
      // a refusal carries the current revision/generation: adopt them and retry once
      const d = e.data || {};
      if (['revision_conflict', 'stale_generation'].includes(d.reason) && (d.revision != null || d.execution_generation != null)) {
        if (d.revision != null) this.s.revision = d.revision;
        if (d.execution_generation != null) this.s.gen = d.execution_generation;
        try { r = await go(payload); } catch (e2) { this.view.toast(`${operation} failed: ${e2.data?.detail || e2.message}`, { err: true }); return null; }
      }
      else { this.view.toast(`${operation} failed: ${e.data?.detail || e.message}`, { err: true }); return null; }
    }
    if (r?.confirm_required && r.confirm) {
      if (!window.confirm(r.message || r.warning || `Confirm ${operation}?`)) return null;
      r = await go({ ...payload, confirm: r.confirm });
    }
    if (r?.revision != null) this.s.revision = r.revision;
    if (r?.execution_generation != null) this.s.gen = r.execution_generation;  // reasoning/model bump it
    return r;
  }

  async modelOptions() {
    const r = await this.rpc.request('model.options', this.sid ? { session_id: this.sid } : {});
    const current = this.info?.model || r.model;
    const items = [];
    for (const p of r.providers || []) {
      if (p.authenticated === false) continue;
      for (const m of p.models || []) items.push({ group: p.name, label: m, value: { model: m, provider: p.slug }, current: m === current && (p.is_current || !this.info?.provider || this.info.provider === p.slug) });
    }
    return items;
  }

  async setModel(model, provider) {
    if (!this.sid) await this.newSession(this.app.cwd);
    const r = await this._mutate('model', { model, ...(provider ? { provider } : {}) });
    if (r) { this._mergeInfo({ model: r.model || model, provider: r.provider || provider }); this.view.note(`└ Model set to ${model}`); }
  }

  // Hermes' levels (hermes_constants.VALID_REASONING_EFFORTS, plus none and the default).
  async effortOptions() {
    const cur = this.info?.reasoning_effort || null;
    const levels = [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    return { current: cur, levels: levels.map((l) => ({ id: l, name: l || 'default', desc: l === null ? 'Whatever the model or config says' : l === 'none' ? 'No reasoning' : '' })) };
  }

  async setEffort(level) {
    if (!this.sid) await this.newSession(this.app.cwd);
    const r = await this._mutate('reasoning', { effort: level });
    if (r) { this._mergeInfo({ reasoning_effort: level || '' }); this.view.note(`└ Reasoning effort: ${level || 'default'}`); }
  }

  // Delete any session from the sidebar. A stored session isn't attached on this
  // socket, so we don't know its revision; the refusal carries the current one.
  async deleteById(id) {
    if (id === this.sid) return this.deleteSession();
    const go = (rev, gen) => this.rpc.request('session.mutate', {
      session_id: id, request_id: uuid(), operation: 'delete', payload: {}, expected_revision: rev, expected_generation: gen,
    });
    try { await go(0, 0); }
    catch (e) {
      const d = e.data || {};
      if (!['revision_conflict', 'stale_generation'].includes(d.reason) || d.revision == null) throw new Error(d.detail || e.message);
      await go(d.revision, d.execution_generation ?? 0);
    }
    this.view.toast('Session deleted');
  }

  // This session's usage for the Usage drawer, in the shared shape.
  async sessionUsage() {
    if (!this.sid) return null;
    const st = await this.rpc.request('session.stats', { session_id: this.sid });
    const u = this.info?.usage || {};
    return {
      input: st.input_tokens, output: st.output_tokens, cache_read: st.cache_read_tokens ?? u.cache_read,
      cache_write: st.cache_write_tokens ?? u.cache_write, reasoning: st.reasoning_tokens, calls: st.api_calls,
      cost: u.cost_usd, tps: st.tokens_per_s ?? u.avg_tps, model: st.model,
    };
  }

  async rename(title) { if (this.sid) { await this._mutate('rename', { title }); this.view.setTitle(title); } }
  async deleteSession() {
    if (!this.sid) return;
    const r = await this._mutate('delete', {});
    if (!r) return;
    this.view.toast('Session deleted');
    this.sid = null; this.s = {}; this.view.clear(); this.view.setTitle('');
  }

  // ------------------------------------------------------------ drawers

  async changesPanel() {
    const box = h('div');
    if (!this.sid) { box.append(h('div', { class: 'dr-empty', text: 'No session open.' })); return box; }
    const [sd, list] = await Promise.all([
      this.rpc.request('rollback.session_diff', { session_id: this.sid }).catch((e) => ({ error: e.message })),
      this.rpc.request('rollback.list', { session_id: this.sid }).catch(() => ({ checkpoints: [] })),
    ]);
    const s1 = h('div', { class: 'dr-section' }, h('h3', { text: 'Changes this session' }));
    if (sd.enabled === false || list.enabled === false) s1.append(h('div', { class: 'dr-empty', text: 'Checkpoints are off for this session (sessions created here have them on).' }));
    else if (sd.empty || !sd.diff) s1.append(h('div', { class: 'dr-empty', text: sd.error || 'No file changes yet.' }));
    else { if (sd.stat) s1.append(h('pre', { class: 'dr-meta', text: stripAnsi(sd.stat), style: 'white-space:pre-wrap' })); s1.append(renderDiff(sd.diff)); }
    box.append(s1);
    const s2 = h('div', { class: 'dr-section' }, h('h3', { text: 'Checkpoints' }));
    const cps = list.checkpoints || [];
    if (!cps.length) s2.append(h('div', { class: 'dr-empty', text: 'No checkpoints yet.' }));
    cps.forEach((c) => {
      const item = h('div', { class: 'dr-item' });
      const head = h('div', { class: 'dr-item-head' },
        h('span', { class: 'grow', text: c.message || c.hash.slice(0, 10) }),
        h('span', { class: 'dr-meta', text: relTime(c.timestamp) }),
        h('button', { class: 'btn-ghost', text: 'diff', onclick: async () => {
          const d = await this.rpc.request('rollback.diff', { session_id: this.sid, hash: c.hash });
          item.querySelector('.diff')?.remove(); item.append(renderDiff(d.diff || ''));
        } }),
        h('button', { class: 'btn-ghost', text: 'restore', onclick: async () => {
          if (!confirm(`Restore files to checkpoint "${c.message || c.hash.slice(0, 8)}"? This also rewinds the conversation to before the newest turn.`)) return;
          const r = await this.rpc.request('rollback.restore', { session_id: this.sid, hash: c.hash });
          this.view.toast(r.success ? `Restored ${r.restored_files?.length ?? ''} files` : `Restore failed: ${r.reason || r.error}`, { err: !r.success });
          if (r.success) { this.openSession(this.sid); this.app.openChanges(); }
        } }));
      item.append(head);
      s2.append(item);
    });
    box.append(s2);
    return box;
  }

  async subagentsPanel() {
    const box = h('div');
    let list = { subagents: [] };
    if (this.sid) list = await this.rpc.request('subagent.list', { session_id: this.sid }).catch(() => ({ subagents: [] }));
    const merged = new Map(this.subagents);
    for (const s of list.subagents || []) merged.set(s.subagent_id, { ...(merged.get(s.subagent_id) || {}), ...s, id: s.subagent_id });
    if (!merged.size) { box.append(h('div', { class: 'dr-empty', text: 'No subagents in this session.' })); return box; }
    for (const s of merged.values()) {
      const tail = h('div', { class: 'sub-tail' });
      const item = h('div', { class: 'dr-item' },
        h('div', { class: 'dr-item-head' },
          h('span', { class: `sub-status ${s.status || ''}`, text: s.status || '?' }),
          h('span', { class: 'grow', text: s.goal || s.id }),
          s.status === 'running' ? h('button', { class: 'btn-ghost', text: 'steer', onclick: async () => {
            const t = prompt('Steer subagent:'); if (t) await this.rpc.request('subagent.steer', { session_id: this.sid, subagent_id: s.id, text: t });
          } }) : null,
          s.status === 'running' ? h('button', { class: 'btn-ghost', text: 'stop', onclick: () => this.rpc.request('subagent.interrupt', { session_id: this.sid, subagent_id: s.id }) }) : null,
          h('button', { class: 'btn-ghost', text: 'tail', onclick: async () => {
            const t = await this.rpc.request('subagent.tail', { session_id: this.sid, subagent_id: s.id }).catch((e) => ({ text: e.message }));
            tail.textContent = stripAnsi(t.text || '(nothing yet)');
          } })),
        h('div', { class: 'dr-meta', text: [s.model, s.tool_count != null ? `${s.tool_count} tools` : '', s.lastTool || s.last_tool, s.duration_seconds ? `${Math.round(s.duration_seconds)}s` : ''].filter(Boolean).join(' · ') }),
        s.summary ? h('div', { class: 'sub-tail', text: s.summary }) : null,
        tail);
      box.append(item);
    }
    return box;
  }
}
