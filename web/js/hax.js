// hax backend: talks to the bridge at /ws/hax, which runs `hax --json` one turn at a
// time (see server/hax.py). Records: control records have `type`, conversation items
// have `kind` (hax docs/sessions.md).
//
// Differences from the other agents, by hax's design:
//   - text arrives a whole message at a time, not token by token;
//   - hax runs commands without asking, so there are no approval cards;
//   - a message sent mid-turn waits in the queue; "steer now" pauses hax after the
//     current step and sends it then.

import { Rpc } from './rpc.js';
import { h, renderDiff } from './ui.js';
import { truncate, homeify } from './render.js';

function dayGroup(ts) {
  if (!ts) return 'Older';
  const d = new Date(ts < 1e12 ? ts * 1000 : ts), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Older';
}

const COMMANDS = [
  ['new', 'Start a new session in the same folder'],
  ['model', 'Choose the model and effort'],
  ['stop', 'Interrupt the current turn'],
  ['delete', 'Delete this session'],
  ['diff', 'Show uncommitted changes in this folder'],
];

const parseArgs = (s) => { try { return JSON.parse(s || '{}'); } catch { return s; } };
const selKey = (path) => `sw.hax.sel.${path}`;

export class HaxBackend {
  constructor(view, app) {
    this.view = view;
    this.app = app;
    this.name = 'hax';
    this.appName = 'hax';
    this.rpc = new Rpc('/ws/hax');
    this.sid = null;          // session file path
    this.cwd = null;
    this.run = null;          // id of the running turn
    this.ready = false;
    this.readyWaiters = [];
    this.home = '';
    this.queued = [];         // texts waiting for the turn to end
    this.steerNext = false;
    this.usage = null;        // this session's totals
    this.sel = {};            // provider/model/effort for the next turns
    this.header = null;
    this.rpc.addEventListener('state', (e) => this._onState(e.detail));
    this.rpc.addEventListener('notify', (e) => this._onNotify(e.detail));
    this.rpc.addEventListener('unauthorized', () => this.app.showLogin());
  }

  start() { this.rpc.start(); }
  stop() { this.rpc.stop(); }
  whenReady() { return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r)); }

  _onState({ state, hello }) {
    this.view.setConn(state);
    if (state === 'open') {
      if (hello?.home) { this.home = hello.home; this.view.home = hello.home; }
      this.ready = true;
      this.readyWaiters.splice(0).forEach((r) => r());
      this.app.refreshSessions();
      if (this.sid) this.openSession(this.sid).catch(() => {});
    } else this.ready = false;
  }

  // ------------------------------------------------------------ sessions

  async listSessions(query, { limit = 40, cursor = null } = {}) {
    await this.whenReady();
    const r = await this.rpc.request('hax.sessions', { limit, offset: cursor || 0, ...(query ? { query } : {}) });
    const items = (r.sessions || []).map((s) => ({
      id: s.path,
      title: truncate(s.first || '(no messages)', 70),
      sub: [homeify(s.cwd || '', this.home), s.messages ? `${s.messages} msgs` : ''].filter(Boolean).join(' · '),
      time: s.mtime, group: dayGroup(s.mtime), live: s.streaming, snippet: s.snippet, raw: s,
    }));
    return { items, next: r.next_offset ?? null };
  }

  async newSession(cwd) {
    await this.whenReady();
    this.sid = null; this.run = null; this.header = null; this.usage = null; this.queued = [];
    this.cwd = cwd || this.app.cwd;
    this.app.cwd = this.cwd;
    this.sel = {};
    this.view.clear();
    this.view.setBusy(false);
    this.app.renderQueue([]);
    this._status();
    this.view.setTitle('New session', homeify(this.cwd, this.home));
    this.app.setActive(null);
  }

  async openSession(path) {
    await this.whenReady();
    const r = await this.rpc.request('hax.open', { path });
    this.sid = path;
    this.header = r.header || {};
    this.cwd = this.header.cwd || this.cwd;
    this.app.cwd = this.cwd;
    try { this.sel = JSON.parse(localStorage.getItem(selKey(path)) || 'null') || {}; } catch { this.sel = {}; }
    this.current = r.selection || {};
    this.usage = null;
    this.run = r.running || null;
    this.view.clear();
    this.view.beginHistory();
    for (const it of r.items || []) this._item(it, true);
    this.view.endHistory();
    if (this.run) {
      this.view.setBusy(true, 'Working…');
      for (const rec of r.replay || []) this._record(rec, true);
    } else this.view.setBusy(false);
    const first = (r.items || []).find((i) => i.kind === 'user' && !i.origin);
    this.view.setTitle(first ? truncate(first.text || '', 80) : 'Session', homeify(this.cwd || '', this.home));
    this._status();
    this.app.setActive(path);
  }

  // ------------------------------------------------------------ records

  _onNotify(f) {
    const p = f.params || {};
    if (f.method === 'hax.event' && p.run === this.run) {
      if (p.path && !this.sid) { this.sid = p.path; this._saveSel(); this.app.setActive(p.path); }
      this._record(p.record);
    } else if (f.method === 'hax.exit' && p.run === this.run) {
      this._finished(p);
    }
  }

  _record(rec, replay = false) {
    if (rec.type === 'session') {
      this.current = { provider: rec.provider, model: rec.model, effort: rec.effort, preset: rec.preset };
      this._status();
    } else if (rec.type === 'result') {
      if (rec.outcome === 'error') this.view.note(`✗ ${rec.error || 'hax failed'}`, { err: true });
      else if (rec.outcome === 'interrupted') this.view.note('└ Interrupted');
      else if (rec.outcome === 'max_turns') this.view.note('⚠ stopped at the turn limit');
      this._lastOutcome = rec.outcome;
      if (rec.cost != null) this.view.setStatus({ cost: rec.cost || undefined });
    } else if (rec.kind) {
      this._item(rec, replay);
    }
  }

  _item(it, history = false) {
    const v = this.view;
    switch (it.kind) {
      case 'user':
        if (it.origin && it.origin !== 'continuation') { v.note(`↳ ${it.origin.replace(/_/g, ' ')}${it.text ? `: ${truncate(it.text, 200)}` : ''}`); break; }
        if (!history && this._echo != null && it.text === this._echo) { this._echo = null; break; }   // already shown
        v.addUser({ text: it.text || '' });
        break;
      case 'assistant':
        if (it.text) v.assistant(it.text);
        if (!history) v.setBusyText('Working…');
        break;
      case 'reasoning':
        if (it.reasoning_text) v.reasoningBlock(it.reasoning_text);
        break;
      case 'tool_call':
        v.toolStart(it.call_id, { name: it.tool_name, args: parseArgs(it.arguments) });
        if (!history) v.setBusyText(`Running ${it.tool_name}…`);
        break;
      case 'tool_result':
        v.toolComplete(it.call_id, { output: typeof it.output === 'string' ? it.output : JSON.stringify(it.output), history });
        break;
      case 'turn_usage': {
        const u = it.usage || {};
        const t = (this.usage ||= { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, cost: 0 });
        t.input += u.input || 0; t.output += u.output || 0; t.cache_read += u.cached || 0; t.cache_write += u.cache_write || 0;
        t.calls += 1; t.cost += u.cost_total ?? u.cost ?? 0;
        if (!history && u.output && u.elapsed_ms) v.setStatus({ tps: { v: u.output / (u.elapsed_ms / 1000), exact: true } });
        v.setStatus({ cost: t.cost ? t.cost : (t.input + t.output ? `${Math.round((t.input + t.output) / 100) / 10}k tok` : undefined) });
        break;
      }
      default: break;
    }
  }

  _finished({ code, stderr, path }) {
    this.run = null;
    if (path && !this.sid) { this.sid = path; this._saveSel(); this.app.setActive(path); }
    if (code && code !== 130 && this._lastOutcome !== 'error') {
      const msg = (stderr || '').trim().split('\n').slice(-3).join('\n');
      this.view.note(`✗ hax exited with status ${code}${msg ? `: ${msg}` : ''}`, { err: true });
    }
    this._lastOutcome = null;
    this.view.closeSegment?.();
    this.view.setBusy(false);
    this.app.refreshSessionsSoon();
    if (this.queued.length) {
      const next = this.queued.shift();
      this._renderQueue();
      this._send(next);
    }
  }

  // ------------------------------------------------------------ sending

  async submit(text, attachments = []) {
    const files = attachments.map((a) => a.path).filter(Boolean);
    const full = files.length ? `${text}${text ? '\n\n' : ''}${files.map((p) => `@${p}`).join(' ')}` : text;
    if (this.run) { this.queued.push(full); this._renderQueue(); return; }
    await this._send(full);
  }

  async _send(text) {
    await this.whenReady();
    if (!this.cwd) this.cwd = this.app.cwd;
    this._echo = text;
    this.view.addUser({ text });
    this.view.setBusy(true, 'Waiting for hax…');
    try {
      const r = await this.rpc.request('hax.send', { ...(this.sid ? { path: this.sid } : { cwd: this.cwd }), text, ...this.sel });
      this.run = r.run;
    } catch (e) {
      this.view.note(`✗ ${e.message}`, { err: true });
      this.view.setBusy(false);
    }
  }

  _renderQueue() {
    this.app.renderQueue(this.queued.map((t, i) => ({
      text: t,
      actions: [
        { label: 'steer now', run: async () => {
          // pause after the current step; the queue sends this text as soon as hax stops
          this.queued.splice(i, 1); this.queued.unshift(t); this._renderQueue();
          if (this.run) await this.rpc.request('hax.pause', { run: this.run });
        } },
        { label: '✕', run: async () => { this.queued.splice(i, 1); this._renderQueue(); } },
      ],
    })));
  }

  async interrupt() { if (this.run) await this.rpc.request('hax.interrupt', { run: this.run }); }
  async steer(text) { this.queued.unshift(text); this._renderQueue(); if (this.run) await this.rpc.request('hax.pause', { run: this.run }); }

  async attach(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload failed');
    return { kind: /^image\//.test(file.type) ? 'image' : 'file', name: file.name, path: j.path };
  }

  // ------------------------------------------------------------ completion and commands

  async complete(text) {
    if (!this.ready) return null;
    if (text.startsWith('/') && !text.includes(' ')) {
      const q = text.slice(1).toLowerCase();
      return { replaceFrom: 1, items: COMMANDS.filter(([n]) => n.includes(q)).map(([n, d]) => ({ label: '/' + n, desc: d, insert: n, argless: true })) };
    }
    const m = /(?:^|\s)@([^\s]*)$/.exec(text);
    if (m) {
      const r = await this.rpc.request('hax.complete', { cwd: this.cwd || this.app.cwd, word: m[1] });
      return { replaceFrom: text.length - m[1].length, items: (r.items || []).map((i) => ({ label: i.display, insert: i.text, desc: i.kind })) };
    }
    return null;
  }

  async command(line) {
    const [cmd] = line.trim().split(/\s+/);
    switch (cmd) {
      case '/new': await this.newSession(this.cwd || this.app.cwd); return true;
      case '/model': this.app.openModelPicker(); return true;
      case '/stop': await this.interrupt(); return true;
      case '/diff': this.app.openChanges(); return true;
      case '/delete': await this.deleteSession(); return true;
      default:
        // hax's own slash commands only exist in its interactive mode; send as text
        await this.submit(line);
        return true;
    }
  }

  // ------------------------------------------------------------ model and effort

  _status() {
    const s = { ...this.current, ...this.sel };
    this.view.setStatus({ model: s.model ? `${s.provider ? s.provider + '/' : ''}${s.model}` : 'hax default', effort: s.effort ? `effort ${s.effort}` : 'effort default', cwd: this.cwd || '' });
  }

  _saveSel() {
    if (!this.sid) return;
    try { localStorage.setItem(selKey(this.sid), JSON.stringify(this.sel)); } catch { /* private mode */ }
  }

  async modelOptions() {
    const r = await this.rpc.request('hax.models', {});
    const cur = { ...this.current, ...this.sel };
    const items = (r.presets || []).map((p) => ({
      group: 'Presets', label: p.name, desc: [p.provider && `${p.provider}/${p.model}`, p.effort && `effort ${p.effort}`, p.description].filter(Boolean).join(' · '),
      value: { model: p.model, provider: p.provider, effort: p.effort }, current: p.model === cur.model && (!p.provider || p.provider === cur.provider),
    }));
    const c = r.current || {};
    if (c.model && !items.some((i) => i.value.model === c.model)) items.unshift({ group: 'Default', label: c.model, desc: c.provider || '', value: { model: c.model, provider: c.provider }, current: c.model === cur.model });
    if (cur.model && !items.some((i) => i.value.model === cur.model)) items.unshift({ group: 'This session', label: cur.model, desc: cur.provider || '', value: { model: cur.model, provider: cur.provider }, current: true });
    items.push({ group: 'Other', label: 'Another model…', desc: 'Type a provider/model id', value: { ask: true } });
    return items;
  }

  async setModel(model, provider, item) {
    let m = model, p = provider;
    if (!m) {
      const id = prompt('Model id (optionally provider/model):', `${this.sel.provider || this.current?.provider || ''}/${this.sel.model || this.current?.model || ''}`.replace(/^\//, ''));
      if (!id) return;
      [p, m] = id.includes('/') && !id.startsWith('/') ? [id.split('/')[0], id.split('/').slice(1).join('/')] : [undefined, id];
    }
    this.sel = { ...this.sel, model: m, ...(p ? { provider: p } : {}) };
    if (item?.effort) this.sel.effort = item.effort;
    this._saveSel();
    this._status();
    this.view.note(`└ Model for the next turns: ${p ? p + '/' : ''}${m}`);
  }

  async effortOptions() {
    const r = await this.rpc.request('hax.models', {});
    const cur = this.sel.effort || this.current?.effort || null;
    return { current: cur, levels: [{ id: null, name: 'default', desc: 'Whatever the model or config says' }, ...(r.efforts || []).map((l) => ({ id: l, name: l }))] };
  }

  async setEffort(level) {
    this.sel = { ...this.sel, effort: level || undefined };
    if (!level) delete this.sel.effort;
    this._saveSel();
    this._status();
    this.view.note(`└ Reasoning effort for the next turns: ${level || 'default'}`);
  }

  // ------------------------------------------------------------ the rest

  async rename() { this.view.toast('hax sessions have no names; the first message is the title', { err: true }); }

  async deleteById(path) {
    const r = await this.rpc.request('hax.delete', { path });
    if (path === this.sid) { this.sid = null; this.view.clear(); this.view.setTitle(''); }
    this.view.toast(`Session moved to ${homeify(r.trashed, this.home)}`, { ms: 5000 });
  }

  async deleteSession() { if (this.sid) await this.deleteById(this.sid); }

  async sessionUsage() {
    if (!this.usage) return this.sid ? { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: null, calls: 0, cost: 0 } : null;
    return { ...this.usage, reasoning: null };
  }

  async changesPanel() {
    const box = h('div');
    const cwd = this.cwd || this.app.cwd;
    const r = await fetch('/api/gitdiff?cwd=' + encodeURIComponent(cwd)).then((x) => x.json());
    if (r.error) { box.append(h('div', { class: 'dr-empty', text: r.error })); return box; }
    if (!r.git) { box.append(h('div', { class: 'dr-empty', text: `${homeify(cwd, this.home)} is not a git repository, so there is nothing to diff.` })); return box; }
    box.append(h('div', { class: 'dr-section' }, h('h3', { text: 'git status' }), h('pre', { class: 'dr-meta', style: 'white-space:pre-wrap', text: r.status || 'clean' })));
    const s = h('div', { class: 'dr-section' }, h('h3', { text: 'Uncommitted changes (vs HEAD)' }));
    s.append(r.diff ? renderDiff(r.diff, { home: this.home }) : h('div', { class: 'dr-empty', text: 'No changes to tracked files.' }));
    box.append(s);
    return box;
  }

  async subagentsPanel() { return h('div', { class: 'dr-empty', text: 'hax runs subagents as background tasks; they are not shown here yet.' }); }
  cancelEdit() {}
}
