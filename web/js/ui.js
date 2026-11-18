// Backend-agnostic view: transcript rows, tool calls, prompt cards, status line,
// session sidebar, drawer. Backends (hermes.js, pi.js) drive it.

import { h, renderMarkdown, renderDiff, diffFromStrings, fmtDuration, fmtTokens, relTime, truncate, homeify, copyText } from './render.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ tool display

const TOOL_LABELS = {
  // hermes
  terminal: 'Bash', shell: 'Bash', execute_code: 'Run', process: 'Process',
  read_file: 'Read', write_file: 'Write', patch: 'Update', search_files: 'Search',
  web_search: 'Web Search', web_extract: 'Fetch', browser_navigate: 'Browse', browser_snapshot: 'Browse',
  todo: 'Todo', delegate_task: 'Task', clarify: 'Ask', memory: 'Memory', skill_view: 'Skill',
  skill_manage: 'Skill', session_search: 'Search Sessions', vision_analyze: 'Vision',
  // pi
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Update', grep: 'Search', find: 'Find', ls: 'List',
  subagent: 'Task',
};

export function toolLabel(name) {
  if (!name) return 'Tool';
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('mcp_') || name.includes('__')) return name.replace(/^mcp_/, '').replace(/__/g, ' · ');
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function relPath(p, cwd, home) {
  p = String(p ?? '');
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return homeify(p, home);
}

export function toolArg(name, args, context, home, cwd) {
  if (context) return relPath(String(context), cwd, home);
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args : '';
  const a = args;
  const pick = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.goal ?? a.task ?? a.question ?? a.name;
  if (pick !== undefined) return a.command ?? a.cmd ? String(pick) : relPath(String(pick), cwd, home);
  if (Array.isArray(a.tasks)) return `${a.tasks.length} tasks`;
  try { return truncate(JSON.stringify(a), 120); } catch { return ''; }
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const HISTORY_KEEP = 150;

// Text with each case-insensitive occurrence of q wrapped in <mark>.
function highlight(text, q) {
  text = String(text ?? '');
  if (!q) return text;
  const out = [];
  const low = text.toLowerCase(), ql = q.toLowerCase();
  let i = 0, j;
  while ((j = low.indexOf(ql, i)) >= 0) {
    if (j > i) out.push(text.slice(i, j));
    out.push(h('mark', { text: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}   // rows drawn when a session opens; older ones on request

// The end of the last complete block in text[from..]: the last blank line that is not
// inside a ``` or ~~~ fence. `from` is always such a point, so fences are counted from there.
export function stableCut(text, from) {
  let i = text.lastIndexOf('\n\n');
  while (i > from) {
    const fences = (text.slice(from, i).match(/^ {0,3}(```|~~~)/gm) || []).length;
    if (fences % 2 === 0) return i + 2;
    i = text.lastIndexOf('\n\n', i - 1);
  }
  return from;
}

// ------------------------------------------------------------ view

export class View {
  constructor() {
    this.rowsEl = $('rows');
    this.scroller = $('transcript');
    this.emptyEl = $('empty');
    this.promptsEl = $('prompts');
    this.tools = new Map();       // tool id -> {el, ...}
    this.segment = null;          // current streaming assistant segment
    this.reasoning = null;
    this.prompts = new Map();     // key -> {el, resolve}
    this.home = '';
    this.stick = true;
    this.scroller.addEventListener('scroll', () => {
      const s = this.scroller;
      this.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
    });
    this._raf = null;
  }

  // ---- transcript
  clear() {
    this._hist = null;
    this._older = null;
    this.rowsEl.replaceChildren();
    this.tools.clear();
    this.segment = null;
    this.reasoning = null;
    this.clearPrompts();
    this._empty();
  }

  _empty() { this.emptyEl.hidden = this.rowsEl.childElementCount > 0 || !!this._older?.length; }

  _append(el) {
    if (this._hist) { this._hist.push(el); return el; }
    this.rowsEl.append(el);
    this._empty();
    this.scrollSoon();
    return el;
  }

  // ---- history: build every row, but only draw the newest ones. Older rows wait
  // (with their markdown unrendered) behind a "Show earlier messages" button.
  beginHistory() { this._hist = []; }

  endHistory(keep = HISTORY_KEEP) {
    const all = this._hist || [];
    this._hist = null;
    this._older = all.slice(0, Math.max(0, all.length - keep));
    this._attach(all.slice(-keep), false);
    this._olderButton();
    this._empty();
    this.scrollSoon(true);
  }

  _attach(els, prepend) {
    for (const el of els) el._render?.();
    if (prepend) this.rowsEl.prepend(...els); else this.rowsEl.append(...els);
  }

  _olderButton() {
    this.rowsEl.querySelector(':scope > .older')?.remove();
    const n = this._older?.length || 0;
    if (!n) return;
    const btn = h('button', { class: 'older btn-ghost', text: `Show ${n} earlier message${n === 1 ? '' : 's'}`, onclick: () => this.showOlder() });
    this.rowsEl.prepend(btn);
  }

  showOlder(count = HISTORY_KEEP) {
    if (!this._older?.length) return;
    const batch = this._older.splice(Math.max(0, this._older.length - count));
    const s = this.scroller;
    const fromBottom = s.scrollHeight - s.scrollTop;
    this.rowsEl.querySelector(':scope > .older')?.remove();
    this._attach(batch, true);
    this._olderButton();
    s.scrollTop = s.scrollHeight - fromBottom;   // keep the view where it was
  }

  scrollSoon(force) {
    if (force) this.stick = true;
    if (!this.stick) return;
    cancelAnimationFrame(this._sraf);
    this._sraf = requestAnimationFrame(() => { this.scroller.scrollTop = this.scroller.scrollHeight; });
  }

  addUser({ text, attachments = [], queued = false, onEdit, onCopy = true, key }) {
    const actions = h('div', { class: 'user-actions' });
    if (onCopy) actions.append(h('button', { title: 'Copy', 'aria-label': 'Copy message', text: 'copy', onclick: () => copyText(text) }));
    if (onEdit) actions.append(h('button', { title: 'Edit & resend from here', 'aria-label': 'Edit and resend from here', text: 'edit', onclick: () => onEdit(text) }));
    const el = h('div', { class: `row row-user${queued ? ' queued' : ''}`, dataset: key ? { key } : {} },
      text, attachments.length ? h('div', {}, attachments.map((a) => h('span', { class: 'att', text: '📎 ' + a }))) : null, actions);
    this.closeSegment();
    return this._append(el);
  }

  // streaming assistant text
  delta(text) {
    if (text == null) { this.closeSegment(); return; }
    if (!this.segment) {
      const md = h('div', { class: 'md' });
      const el = h('div', { class: 'row row-assistant streaming' }, md);
      this.segment = { el, md, text: '', done: 0, tail: [] };
      this._append(el);
    }
    this.segment.text += text;
    this._streamTick(text.length);
    this._renderSegmentSoon();
  }

  _renderSegmentSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (this.segment) { this._renderSegment(this.segment); this.scrollSoon(); }
    });
  }

  // Streaming render that stays cheap for long replies: paragraphs that are complete
  // (up to the last blank line outside a code fence) are rendered once and kept; only
  // the paragraph still being written is re-rendered each frame. closeSegment() does
  // one full render at the end, so anything split oddly mid-stream comes out right.
  _renderSegment(s) {
    const cut = stableCut(s.text, s.done);
    for (const n of s.tail) n.remove();
    s.tail = [];
    if (cut > s.done) {
      const box = document.createElement('div');
      renderMarkdown(box, s.text.slice(s.done, cut), { final: true });
      s.md.append(...box.childNodes);
      s.done = cut;
    }
    const box = document.createElement('div');
    renderMarkdown(box, s.text.slice(s.done), { final: false });
    s.tail = [...box.childNodes];
    s.md.append(...s.tail);
  }

  closeSegment(finalText) {
    const s = this.segment;
    this.closeReasoning();
    if (!s) return;
    this.segment = null;
    if (finalText) s.text = finalText;
    s.el.classList.remove('streaming');
    if (!s.text.trim()) { s.el.remove(); this._empty(); return; }
    renderMarkdown(s.md, s.text, { final: true });
  }

  assistant(text) {
    if (!text || !String(text).trim()) return null;
    this.closeSegment();
    const md = h('div', { class: 'md' });
    const el = h('div', { class: 'row row-assistant' }, md);
    if (this._hist) el._render = () => { renderMarkdown(md, text); el._render = null; };
    else renderMarkdown(md, text);
    return this._append(el);
  }

  segmentText() { return this.segment?.text || ''; }

  // reasoning
  reasoningDelta(text) {
    if (!text) return;
    if (!this.reasoning) {
      const body = h('div', { class: 'reasoning-body' });
      const sum = h('summary', { text: '✻ Thinking…' });
      const el = h('details', { class: 'row row-reasoning' }, sum, body);
      if (this.segment) { this.rowsEl.insertBefore(el, this.segment.el); } else this._append(el);
      this.reasoning = { el, body, sum, text: '', t0: Date.now() };
    }
    this.reasoning.text += text;
    this._streamTick(text.length);
    this.reasoning.body.textContent = this.reasoning.text;
    this.scrollSoon();
  }

  closeReasoning() {
    const r = this.reasoning;
    if (!r) return;
    this.reasoning = null;
    r.sum.textContent = `✻ Thought for ${fmtDuration(Date.now() - r.t0)}`;
  }

  reasoningBlock(text) {
    if (!text || !String(text).trim()) return;
    const el = h('details', { class: 'row row-reasoning' }, h('summary', { text: '✻ Thinking' }), h('div', { class: 'reasoning-body', text }));
    this._append(el);
  }

  // tools
  toolStart(id, { name, args, context, pending = false }) {
    this.closeSegment();
    let t = this.tools.get(id);
    if (t) { this._toolHead(t, name, args, context); return t; }
    const nameEl = h('span', { class: 'tool-name' });
    const argEl = h('span', { class: 'tool-arg' });
    const durEl = h('span', { class: 'tool-dur' });
    const head = h('div', { class: 'tool-head', role: 'button', tabindex: '0', 'aria-expanded': 'false' }, nameEl, argEl, durEl);
    const body = h('div', { class: 'tool-body' });
    const el = h('div', { class: `row row-tool ${pending ? 'pending' : 'running'}` }, head, body);
    t = { id, el, head, body, nameEl, argEl, durEl, name, args, t0: Date.now(), expanded: false };
    head.addEventListener('click', () => this._toggleTool(t));
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._toggleTool(t); } });
    this._toolHead(t, name, args, context);
    this.tools.set(id, t);
    this._append(el);
    return t;
  }

  _toolHead(t, name, args, context) {
    t.name = name || t.name;
    if (args !== undefined) t.args = args;
    t.nameEl.textContent = toolLabel(t.name);
    const arg = toolArg(t.name, t.args, context, this.home, this.cwd);
    t.argEl.textContent = arg ? `(${truncate(arg.replace(/\s+/g, ' '), 300)})` : '';
    t.argEl.title = arg;
  }

  toolProgress(id, text) {
    const t = this.tools.get(id);
    if (!t) return;
    let p = t.body.querySelector('.tool-summary');
    if (!p) { p = h('div', { class: 'tool-summary' }); t.body.prepend(p); }
    p.textContent = truncate(stripAnsi(text), 400);
    this.scrollSoon();
  }

  // Partial output while a tool runs (pi streams these).
  toolPartial(id, output) {
    const t = this.tools.get(id);
    if (!t) return;
    t.partial = String(output ?? '');
    let o = t.body.querySelector('.tool-out.live');
    if (!o) { o = h('div', { class: 'tool-out live' }); t.body.append(o); }
    const lines = stripAnsi(t.partial).split('\n');
    o.textContent = lines.slice(-12).join('\n');
    o.scrollTop = o.scrollHeight;
    this.scrollSoon();
  }

  toolComplete(id, { name, args, output = '', error = false, duration, diff, oldNew, todos, summary, image, history = false }) {
    let t = this.tools.get(id) || this.toolStart(id, { name, args });
    if (args !== undefined || name) this._toolHead(t, name, args);
    t.el.classList.remove('running', 'pending');
    if (error) t.el.classList.add('failed');
    t.durEl.textContent = duration != null ? fmtDuration(duration) : history ? '' : fmtDuration(Date.now() - t.t0);
    t.body.replaceChildren();
    t.output = stripAnsi(output || '');
    t.error = error;

    if (todos && todos.length) {
      t.body.append(this._todoList(todos));
      this.scrollSoon();
      return t;
    }
    const diffText = diff ? stripAnsi(diff) : (oldNew ? diffFromStrings(oldNew.old, oldNew.new, oldNew.path) : null);
    if (diffText && !error) {
      const adds = (diffText.match(/^\+(?!\+\+)/gm) || []).length;
      const dels = (diffText.match(/^-(?!--)/gm) || []).length;
      t.body.append(h('div', { class: 'tool-summary', text: summary || `${adds ? `Added ${adds} line${adds === 1 ? '' : 's'}` : ''}${adds && dels ? ', ' : ''}${dels ? `removed ${dels} line${dels === 1 ? '' : 's'}` : ''}` || 'Updated' }));
      t.body.append(renderDiff(diffText, { cwd: this.cwd, home: this.home }));
      this.scrollSoon();
      return t;
    }
    const lines = t.output ? t.output.replace(/\n$/, '').split('\n') : [];
    const sum = summary ?? (error ? truncate(lines[0] || 'Error', 200) : this._defaultSummary(t.name, lines));
    if (sum) t.body.append(h('div', { class: `tool-summary${error ? ' err' : ''}`, text: sum }));
    else if (!lines.length) t.body.remove(), t.body = h('div', { class: 'tool-body', hidden: true }), t.el.append(t.body);
    if (image) t.body.append(h('img', { src: image, style: 'max-width:100%;border-radius:6px;margin-top:4px' }));
    if (lines.length) {
      const more = h('button', { type: 'button', class: 'tool-more', text: t.expanded ? '' : `… ${lines.length} line${lines.length === 1 ? '' : 's'} (click to expand)` });
      more.addEventListener('click', () => this._toggleTool(t));
      t.body.append(more);
      if (t.expanded || (error && lines.length <= 12)) this._expand(t, true);
    }
    this.scrollSoon();
    return t;
  }

  _defaultSummary(name, lines) {
    const n = lines.length;
    const label = toolLabel(name);
    if (label === 'Read') return `Read ${n} line${n === 1 ? '' : 's'}`;
    if (label === 'Search' || label === 'Find') return n ? `Found ${n} result${n === 1 ? '' : 's'}` : 'No matches';
    if (!n) return '(no output)';
    return truncate(lines[0], 200) + (n > 1 ? ` (+${n - 1} lines)` : '');
  }

  _toggleTool(t) { this._expand(t, !t.expanded); }

  _expand(t, on) {
    t.expanded = on;
    t.head?.setAttribute('aria-expanded', String(on));
    t.body.querySelectorAll('.tool-out:not(.live), .tool-args').forEach((e) => e.remove());
    const more = t.body.querySelector('.tool-more');
    if (on) {
      if (t.args && typeof t.args === 'object' && Object.keys(t.args).length) {
        t.body.append(h('div', { class: 'tool-args', text: JSON.stringify(t.args, null, 2) }));
      }
      if (t.output) t.body.append(h('div', { class: `tool-out${t.error ? ' err' : ''}`, text: t.output }));
      if (more) more.textContent = 'collapse';
    } else if (more) {
      const n = t.output ? t.output.replace(/\n$/, '').split('\n').length : 0;
      more.textContent = n ? `… ${n} line${n === 1 ? '' : 's'} (click to expand)` : '';
    }
  }

  _todoList(todos) {
    return h('ul', { class: 'todo-list' }, todos.map((td) => {
      const st = td.status || (td.done ? 'completed' : 'pending');
      return h('li', { class: st === 'completed' ? 'done' : st === 'in_progress' ? 'active' : '', text: td.content || td.text || td.title || String(td) });
    }));
  }

  note(text, { err = false } = {}) {
    if (!text) return null;
    this.closeSegment();
    return this._append(h('div', { class: `row row-note${err ? ' err' : ''}`, text }));
  }

  compaction(text) {
    const el = h('details', { class: 'row row-compaction' }, h('summary', { text: '— conversation compacted —' }), h('div', { class: 'md', style: 'text-align:left' }));
    if (this._hist) el._render = () => { renderMarkdown(el.lastChild, text || ''); el._render = null; };
    else renderMarkdown(el.lastChild, text || '');
    return this._append(el);
  }

  // ---- prompt cards
  clearPrompts() {
    for (const [, p] of this.prompts) p.el.remove();
    this.prompts.clear();
  }

  removePrompt(key) {
    const p = this.prompts.get(key);
    if (p) { p.el.remove(); this.prompts.delete(key); }
  }

  // choices: [{label, value, hint}] ; returns Promise<value>
  promptChoice(key, { title, command, description, choices }) {
    this.removePrompt(key);
    return new Promise((resolve) => {
      const btns = choices.map((c, i) => h('button', { class: 'prompt-choice', onclick: () => { this.removePrompt(key); resolve(c.value); } },
        h('span', { class: 'num', text: `${i + 1}.` }), c.label, c.hint ? h('span', { class: 'pi-desc', text: '  ' + c.hint, style: 'color:var(--faint)' }) : null));
      const el = h('div', { class: 'prompt-card', role: 'group', 'aria-label': title },
        h('div', { class: 'prompt-title', text: title }),
        command ? h('div', { class: 'prompt-cmd', text: command }) : null,
        description ? h('div', { class: 'prompt-desc', text: description }) : null,
        h('div', { class: 'prompt-choices' }, btns));
      el.addEventListener('keydown', (e) => {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= btns.length) { e.preventDefault(); btns[n - 1].click(); }
      });
      this.prompts.set(key, { el, resolve });
      this.promptsEl.append(el);
      this.announce(`${title}${command ? `: ${command}` : ''}. ${btns.length} choices; press 1 to ${btns.length}.`);
      btns[0]?.focus({ preventScroll: true });
      this.scrollSoon(true);
    });
  }

  // fields: [{id, label, choices?, multi?, secret?, multiline?, value?}] ; returns Promise<{id:value}|null>
  promptForm(key, { title, description, fields, submitLabel = 'Submit', cancelLabel = 'Cancel' }) {
    this.removePrompt(key);
    return new Promise((resolve) => {
      const inputs = {};
      const body = fields.map((f) => {
        const wrap = h('div', {}, f.label ? h('div', { class: 'prompt-q', text: f.label }) : null);
        if (f.choices && f.choices.length) {
          const sel = new Set();
          const list = h('div', { class: 'prompt-choices' });
          f.choices.forEach((c, i) => {
            const b = h('button', { class: 'prompt-choice' }, h('span', { class: 'num', text: f.multi ? '☐' : `${i + 1}.` }), c);
            b.addEventListener('click', () => {
              if (f.multi) {
                if (sel.has(c)) sel.delete(c); else sel.add(c);
                b.firstChild.textContent = sel.has(c) ? '☒' : '☐';
              } else {
                inputs[f.id] = () => c;
                if (fields.length === 1) { finish(true); return; }
                list.querySelectorAll('.prompt-choice').forEach((x) => x.style.background = '');
                b.style.background = 'var(--accent-soft)';
              }
            });
            list.append(b);
          });
          const other = h('input', { class: 'prompt-input', placeholder: 'Or type an answer…' });
          inputs[f.id] = () => (f.multi ? (sel.size ? [...sel].join(', ') : other.value) : other.value);
          const orig = inputs[f.id];
          if (!f.multi) {
            other.addEventListener('input', () => { inputs[f.id] = orig; });
          }
          wrap.append(list, other);
        } else {
          const inp = f.multiline
            ? h('textarea', { class: 'prompt-input', rows: 6 })
            : h('input', { class: 'prompt-input', type: f.secret ? 'password' : 'text', autocomplete: f.secret ? 'off' : 'on' });
          if (f.value) inp.value = f.value;
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !f.multiline) { e.preventDefault(); finish(true); } });
          inputs[f.id] = () => inp.value;
          wrap.append(inp);
        }
        return wrap;
      });
      const finish = (ok) => {
        this.removePrompt(key);
        if (!ok) { resolve(null); return; }
        const out = {};
        for (const f of fields) out[f.id] = inputs[f.id]();
        resolve(out);
      };
      const el = h('div', { class: 'prompt-card', role: 'group', 'aria-label': title },
        h('div', { class: 'prompt-title', text: title }),
        description ? h('div', { class: 'prompt-desc', text: description }) : null,
        body,
        h('div', { class: 'prompt-actions' },
          cancelLabel ? h('button', { class: 'btn', text: cancelLabel, onclick: () => finish(false) }) : null,
          h('button', { class: 'btn btn-primary', text: submitLabel, onclick: () => finish(true) })));
      this.prompts.set(key, { el, resolve });
      this.promptsEl.append(el);
      this.announce(title);
      el.querySelector('input,textarea,button')?.focus({ preventScroll: true });
      this.scrollSoon(true);
    });
  }

  // ---- status line
  setStatus({ model, effort, cwd, context, cost, tps, busy } = {}) {
    if (tps !== undefined) this._showTps(tps?.v, tps?.exact);
    if (model !== undefined) $('st-model').textContent = model ? `◆ ${model}` : '';
    if (effort !== undefined) $('st-effort').textContent = effort ? `◔ ${effort}` : '';
    if (cwd !== undefined) { this.cwd = cwd || ''; $('st-cwd').textContent = homeify(cwd || '', this.home); }
    if (context !== undefined) {
      const el = $('st-context');
      el.replaceChildren();
      if (context && (context.max || context.used)) {
        const pct = context.pct ?? (context.max ? Math.round((context.used / context.max) * 100) : null);
        const bar = h('span', { class: `ctx-bar${pct >= 90 ? ' full' : pct >= 70 ? ' hot' : ''}` }, h('i', { style: `width:${Math.min(100, pct || 0)}%` }));
        el.append(bar, `${fmtTokens(context.used)}${context.max ? '/' + fmtTokens(context.max) : ''}`);
      }
    }
    if (cost !== undefined) $('st-cost').textContent = cost ? (typeof cost === 'number' ? `$${cost.toFixed(cost < 1 ? 3 : 2)}` : cost) : '';
    if (busy !== undefined) this.setBusy(busy);
  }

  // Screen-reader announcements (a polite live region; the transcript itself is not
  // live, so streaming text isn't read out token by token).
  announce(text) {
    const el = $('announce');
    if (!el || !text) return;
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 50);
  }

  setBusy(busy, text) {
    const was = !!this.busy;
    this.busy = !!busy;
    if (was !== this.busy) this.announce(this.busy ? `${this.appName || 'The agent'} is working` : `${this.appName || 'The agent'} finished`);
    document.querySelector('.composer').classList.toggle('busy', this.busy);
    const send = $('send');
    send.classList.toggle('stop', this.busy && !$('input').value.trim());
    send.textContent = this.busy && !$('input').value.trim() ? '■' : '↵';
    send.title = this.busy ? 'Interrupt (Esc) — or type to steer/queue' : 'Send (Enter)';
    send.setAttribute('aria-label', this.busy && !$('input').value.trim() ? 'Interrupt' : 'Send');
    const st = $('st-busy');
    if (!this.busy) { st.textContent = ''; clearInterval(this._spin); this._spin = null; return; }
    this._busyText = text || this._busyText || 'Working…';
    if (!this._spin) {
      const frames = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳'];
      const spin = h('span', { class: 'st-spin', 'aria-hidden': 'true' });
      const rest = h('span');
      st.replaceChildren(spin, rest);
      let i = 0; const t0 = Date.now();
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._spin = setInterval(() => {
        spin.textContent = still ? '✻' : frames[i++ % frames.length];
        rest.textContent = `${this._busyText} ${fmtDuration(Date.now() - t0)} · esc to interrupt`;
      }, 140);
    }
  }

  setBusyText(text) { if (text) this._busyText = text; }

  // ---- tokens per second. While text streams in, estimate from characters (≈4 per
  // token) within the current burst (a gap of 1.5 s starts a new one, so tool runs
  // don't drag the average down); adapters replace it with the exact figure.
  _streamTick(n) {
    const now = performance.now();
    const b = this._burst;
    if (!b || now - b.last > 1500) { this._burst = { t0: now, last: now, chars: n }; return; }
    b.last = now; b.chars += n;
    const secs = (now - b.t0) / 1000;
    if (secs > 0.6 && now - (this._tpsAt || 0) > 300) { this._tpsAt = now; this._showTps(b.chars / 4 / secs, false); }
  }

  _showTps(v, exact) {
    const el = $('st-tps');
    if (!v || !isFinite(v)) { el.textContent = ''; return; }
    el.textContent = `${exact ? '' : '≈'}${v >= 100 ? Math.round(v) : v.toFixed(1)} tok/s`;
    el.classList.toggle('est', !exact);
  }

  // ---- header
  setTitle(title, sub) {
    $('session-title').textContent = title || 'New session';
    $('session-sub').textContent = sub || '';
    document.title = title ? `${title} · ${this.appName || 'Hermes'}` : (this.appName || 'Hermes');
  }

  setConn(state) {
    const c = $('conn');
    c.className = 'conn ' + ({ open: 'ok', connecting: 'wait', closed: 'bad' }[state] || '');
    const label = { open: 'connected', connecting: 'connecting…', closed: 'disconnected' }[state] || 'not connected';
    c.title = `Connection: ${label}`;
    c.setAttribute('aria-label', `Connection: ${label}`);
    if (state === 'closed' && this._connWas === 'open') this.announce('Connection lost, reconnecting');
    this._connWas = state;
  }

  // ---- sidebar
  setSessions(items, activeId, onPick, onDelete, { query = '', more = null } = {}) {
    const list = $('session-list');
    const keep = list.scrollTop;
    this._sessObs?.disconnect();
    list.replaceChildren();
    if (!items.length) {
      list.append(h('div', { class: 'dr-empty', style: 'padding:8px', role: 'status', text: query ? `No conversations match “${query}”` : 'No sessions yet' }));
      return;
    }
    if (query) list.append(h('div', { class: 'side-group', role: 'status', text: `${items.length}${more ? '+' : ''} result${items.length === 1 && !more ? '' : 's'}` }));
    let lastGroup = null;
    for (const s of items) {
      const g = query ? '' : (s.group || '');
      if (g !== lastGroup) { if (g) list.append(h('div', { class: 'side-group', text: g })); lastGroup = g; }
      const el = h('button', { class: `session-item${s.id === activeId ? ' active' : ''}`, onclick: () => onPick(s), 'aria-current': s.id === activeId ? 'true' : null },
        h('div', { class: 'si-title' }, s.live ? h('span', { class: 'si-live', text: '● ', 'aria-label': 'running' }) : null, highlight(s.title || 'Untitled', query)),
        query && s.snippet ? h('div', { class: 'si-snip' }, highlight(s.snippet, query)) : null,
        h('div', { class: 'si-meta', text: [relTime(s.time), s.sub].filter(Boolean).join(' · ') }));
      const del = onDelete ? h('button', { class: 'si-del', title: 'Delete session', 'aria-label': `Delete ${s.title || 'session'}`, text: '✕',
        onclick: (e) => { e.stopPropagation(); onDelete(s); } }) : null;
      list.append(h('div', { class: `session-row${s.id === activeId ? ' active' : ''}` }, el, del));
    }
    if (more) {
      const btn = h('button', { class: 'btn-ghost side-more', text: 'Load more', onclick: () => { btn.textContent = 'Loading…'; more(); } });
      list.append(btn);
      // load the next page as soon as the button scrolls into view
      this._sessObs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { this._sessObs.disconnect(); btn.textContent = 'Loading…'; more(); } }, { root: list, rootMargin: '200px' });
      this._sessObs.observe(btn);
    }
    list.scrollTop = keep;
  }

  // ---- drawer
  openDrawer(title, contentEl) {
    const d = $('drawer');
    const opening = d.hidden;
    if (opening) this._drawerReturn = document.activeElement;
    const moveFocus = opening || d.contains(document.activeElement) === false;
    $('drawer-title').textContent = title;
    $('drawer-body').replaceChildren(contentEl);
    d.hidden = false;
    if (opening && moveFocus) $('drawer-title').focus({ preventScroll: true });
  }
  closeDrawer() {
    const d = $('drawer');
    if (d.hidden) return;
    const inside = d.contains(document.activeElement);
    d.hidden = true;
    if (inside && this._drawerReturn?.isConnected) this._drawerReturn.focus({ preventScroll: true });
    this._drawerReturn = null;
  }
  drawerOpen() { return !$('drawer').hidden; }

  toast(text, { err = false, ms = 3500 } = {}) {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast${err ? ' err' : ''}`;
    t.setAttribute('role', err ? 'alert' : 'status');
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => { t.hidden = true; }, ms);
  }
}

export { h, renderDiff, stripAnsi };
