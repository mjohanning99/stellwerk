// Stellwerk: app shell. Wires login, backend switching, composer, popups,
// drawers to the backend adapters (hermes.js, pi.js) through the View.

import { View, h } from './ui.js';
import { HermesBackend } from './hermes.js';
import { PiBackend } from './pi.js';
import { homeify, truncate, fmtTokens } from './render.js';
import {
  LOOKS, MODES, SCHEMES, ACCENTS, UI_FONTS, CODE_FONTS, TEXT_SIZES,
  normalizeLook, readPrefs, applyAppearance, resolveScheme, contrast, token,
} from './theme.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sw.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const coarse = matchMedia('(pointer: coarse)').matches;
const SESSION_PAGE = 40;
const BACKENDS = { hermes: { sym: '☤', name: 'Hermes' }, pi: { sym: 'π', name: 'Pi' } };

class App {
  constructor() {
    this.view = new View();
    this.backends = {};
    this.backend = null;
    this.attachments = [];
    this.popup = null;   // {items, sel, replaceFrom, mode}
    this.cwd = store.get('cwd', '');
    this.drawerKind = null;
    this.home = '';
    this.me = {};
  }

  enabledBackends() {
    const b = this.me.backends || {};
    return Object.keys(BACKENDS).filter((n) => b[n]?.enabled);
  }

  // ------------------------------------------------------------ boot
  async boot() {
    const oldLook = store.get('look', null);   // looks that no longer exist map to Flat or Nachtzug
    if (oldLook !== null && oldLook !== normalizeLook(oldLook)) store.set('look', normalizeLook(oldLook));
    this.applyAppearance();
    // follow the system: contrast preference (when no scheme was picked) and the browser bar colour
    matchMedia('(prefers-contrast: more)').addEventListener('change', () => this.applyAppearance());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyAppearance());
    const me =await fetch('/api/me').then((r) => r.json()).catch(() => ({ authed: false }));
    if (!me.authed) { this.showLogin(me); return; }
    this.me = me;
    this.home = me.home || '';
    this.view.home = this.home;
    if (!this.cwd) this.cwd = me.default_cwd || '';
    $('login').hidden = true;
    $('app').hidden = false;
    this.bindUi();
    this.switchBackend(store.get('backend', 'hermes'));
  }

  showLogin(me = {}) {
    this.backend?.stop();
    $('app').hidden = true;
    $('login').hidden = false;
    if (me.password_set === false && me.error) {
      // open mode, but reached through a host name we don't trust
      $('login-pw').hidden = true;
      document.querySelector('#login-form button').hidden = true;
      $('login-err').textContent = me.error;
      return;
    }
    $('login-pw').focus();
    $('login-form').onsubmit = async (e) => {
      e.preventDefault();
      $('login-err').textContent = '';
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('login-pw').value }) });
      if (r.ok) location.reload();
      else $('login-err').textContent = (await r.json().catch(() => ({}))).error || 'Login failed';
    };
  }

  // ------------------------------------------------------------ appearance (theme.js)
  // Applies every stored appearance setting; the mode key and the browser bar follow.
  applyAppearance() {
    const p = readPrefs();
    applyAppearance(p);
    requestAnimationFrame(() => {
      document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.body).backgroundColor;
    });
    const t = p.mode;
    const k = document.getElementById('theme-toggle');
    if (k) { k.textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐'; k.title = `Mode: ${t || 'follow the system'} (click to change)`; k.setAttribute('aria-label', `Colour mode: ${t || 'follow the system'}`); }
  }

  setAppearance(key, value) {
    store.set(key, value);
    this.applyAppearance();
  }

  applyTheme(t) { this.setAppearance('theme', t || null); }

  applyLook(look) { this.setAppearance('look', normalizeLook(look)); }

  // The sidebar head: a switch when two agents are on, a name plate when one is.
  renderBrand() {
    const on = this.enabledBackends();
    const cur = this.backend?.name;
    let el;
    if (on.length > 1) {
      el = h('div', { class: 'be-switch' }, ...on.map((n) => h('button', {
        dataset: { be: n }, title: BACKENDS[n].name, class: n === cur ? 'on' : '', onclick: () => this.switchBackend(n),
      }, h('span', { class: 'sym', text: BACKENDS[n].sym }), BACKENDS[n].name)));
    } else {
      const n = on[0];
      el = h('div', { class: 'brand' }, n ? h('span', { class: 'sym', text: BACKENDS[n].sym }) : null, n ? BACKENDS[n].name : 'Stellwerk');
    }
    document.querySelector('.side-head > .be-switch, .side-head > .brand').replaceWith(el);
    $('new-session').hidden = !on.length;
    $('session-search').hidden = !on.length;
    $('logout').hidden = !this.me.password_set;
  }

  setNoBackend(none) {
    $('app').classList.toggle('no-backend', none);
    $('no-backend').hidden = !none;
    $('empty').hidden = none;
    document.title = none ? 'Stellwerk' : `${this.backend.appName} · Stellwerk`;
  }

  // ------------------------------------------------------------ backends
  switchBackend(name) {
    const on = this.enabledBackends();
    if (!on.includes(name)) name = on[0] || null;
    if (this.backend && this.backend.name === name) return;
    this.backend?.stop();
    this._sItems = []; this._sNext = null; this._sQuery = null;
    if (!name) {
      this.backend = null;
      this.view.clear();
      this.view.setTitle('');
      $('session-list').replaceChildren();
      this.view.setConn('idle');
      this.closeDrawer();
      this.renderBrand();
      this.setNoBackend(true);
      return;
    }
    this.view.clear();
    this.view.setTitle('');
    this.view.setStatus({ model: '', effort: '', cwd: this.cwd, context: null, cost: '' });
    this.renderQueue([]);
    this.setExtStatus('');
    this.setWidgets([]);
    this.clearAttachments();
    this.closeDrawer();
    const B = name === 'pi' ? PiBackend : HermesBackend;
    const b = new B(this.view, this);
    b.home = this.home;
    b.rpc.backendName = name;
    b.rpc.addEventListener('disabled', () => this.reloadMe());
    this.backends[name] = b;
    this.backend = b;
    this.view.appName = b.appName;
    store.set('backend', name);
    this.renderBrand();
    this.setNoBackend(false);
    $('input').placeholder = `Message ${b.appName}…`;
    document.querySelector('.empty > div:nth-child(2)').textContent = `What should ${b.appName} work on?`;
    document.querySelector('#empty .empty-mark').textContent = BACKENDS[name].sym;
    $('btn-subagents').hidden = true;
    b.start();
    b.whenReady().then(async () => {
      if (b !== this.backend) return;
      b.loadCatalog?.();
      const last = store.get(`last.${name}`, null);
      if (last) {
        try { await b.openSession(last); } catch { store.set(`last.${name}`, null); }
      }
    });
  }

  setActive(id) {
    this.activeId = id;
    store.set(`last.${this.backend.name}`, id);
    this.refreshSessionsSoon();
  }

  // Settings changed (here or in another tab): pick up the new backend list.
  async reloadMe() {
    const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
    if (!me) return;
    if (!me.authed) { this.showLogin(me); return; }
    this.me = me;
    const on = this.enabledBackends();
    if (!this.backend || !on.includes(this.backend.name)) this.switchBackend(store.get('backend', on[0]));
    else this.renderBrand();
  }

  // The sidebar holds pages of sessions. A refresh reloads as many as are shown, so
  // scrolled-in pages survive it; "more" appends the next page.
  async refreshSessions({ more = false } = {}) {
    const b = this.backend;
    if (!b) return;
    const q = $('session-search').value.trim();
    if (more && (!this._sNext || this._sLoading)) return;
    this._sLoading = more;
    try {
      const shown = q === this._sQuery ? (this._sItems?.length || 0) : 0;
      const res = more
        ? await b.listSessions(q, { limit: SESSION_PAGE, cursor: this._sNext })
        : await b.listSessions(q, { limit: Math.min(Math.max(SESSION_PAGE, shown), 200) });
      if (b !== this.backend || $('session-search').value.trim() !== q) return;
      const items = more ? [...this._sItems, ...res.items] : res.items;
      const seen = new Set();
      this._sItems = items.filter((s) => !seen.has(s.id) && seen.add(s.id));
      this._sQuery = q;
      this._sNext = res.next ?? null;
      this.view.setSessions(this._sItems, this.activeId, (s) => this.pickSession(s), (s) => this.deleteSessionRow(s),
        { query: q, more: this._sNext != null ? () => this.refreshSessions({ more: true }) : null });
    } catch (e) { /* not ready yet */ }
    finally { this._sLoading = false; }
  }

  refreshSessionsSoon() { clearTimeout(this._rs); this._rs = setTimeout(() => this.refreshSessions(), 400); }

  async pickSession(s) {
    this.closeSidebar();
    if (!this.backend) return;
    if (s.id === this.activeId && this.backend.sid) return;
    try { await this.backend.openSession(s.id, s); } catch (e) { this.view.toast(`Open failed: ${e.message}`, { err: true }); }
  }

  async deleteSessionRow(s) {
    const b = this.backend;
    const how = b.name === 'pi' ? 'It is moved to Stellwerk\'s trash folder.' : 'This cannot be undone.';
    if (!confirm(`Delete “${s.title || 'Untitled'}”?\n\n${how}`)) return;
    try {
      await b.deleteById(s.id);
      if (s.id === store.get(`last.${b.name}`, null)) store.set(`last.${b.name}`, null);
      if (s.id === this.activeId) this.activeId = null;
    } catch (e) { this.view.toast(`Delete failed: ${e.message}`, { err: true }); }
    this.refreshSessions();
  }

  setExtStatus(text) { $('st-ext').textContent = text || ''; }

  setWidgets(list) {
    $('widgets').replaceChildren(...list.map((lines) => h('div', { class: 'widget', text: lines.join('\n') })));
  }

  updateSubagentCount(total, running = 0) {
    $('btn-subagents').hidden = !total;
    $('subagent-count').textContent = running ? `${running}/${total}` : String(total);
  }

  // ------------------------------------------------------------ ui wiring
  bindUi() {
    this.renderBrand();
    $('btn-settings').onclick = () => (this.drawerKind === 'settings' ? this.closeDrawer() : this.openSettings());
    $('no-backend-settings').onclick = () => this.openSettings();

    $('new-session').onclick = () => this.openNewSession();
    $('session-search').oninput = () => this.refreshSessionsSoon();
    $('menu').onclick = () => {
      const open = $('app').classList.toggle('side-open');
      $('menu').setAttribute('aria-expanded', String(open));
      if (open) setTimeout(() => $('session-search').focus(), 200);
    };
    $('scrim').onclick = () => this.closeSidebar();
    $('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); };
    $('theme-toggle').onclick = () => {
      const order = [null, 'light', 'dark'];
      const next = order[(order.indexOf(readPrefs().mode) + 1) % order.length];
      this.applyTheme(next);
      if (this.drawerKind === 'settings') this.openSettings();
    };
    $('btn-changes').onclick = () => (this.drawerKind === 'changes' ? this.closeDrawer() : this.openChanges());
    $('btn-subagents').onclick = () => (this.drawerKind === 'subagents' ? this.closeDrawer() : this.openSubagents());
    $('drawer-close').onclick = () => this.closeDrawer();
    $('st-model').onclick = () => this.openModelPicker();
    $('st-cost').onclick = $('st-tps').onclick = () => (this.drawerKind === 'usage' ? this.closeDrawer() : this.openUsage());
    $('st-effort').onclick = () => (this.drawerKind === 'effort' ? this.closeDrawer() : this.openEffortPicker());
    $('session-title').onclick = async () => {
      if (!this.backend.sid) return;
      const t = prompt('Rename session:', $('session-title').textContent);
      if (t && t.trim()) { await this.backend.rename(t.trim()); this.refreshSessions(); }
    };

    const input = $('input');
    input.addEventListener('input', () => { this.autosize(); this.view.setBusy(this.view.busy); this.updatePopupSoon(); });
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); files.forEach((f) => this.addAttachment(f)); }
    });
    $('send').onclick = () => {
      if (!this.backend) return;
      if (this.view.busy && !input.value.trim() && !this.attachments.length) this.backend.interrupt().catch((e) => this.view.toast(e.message, { err: true }));
      else this.send();
    };
    $('file-input').onchange = (e) => { [...e.target.files].forEach((f) => this.addAttachment(f)); e.target.value = ''; };
    const main = document.querySelector('.main');
    main.addEventListener('dragover', (e) => { e.preventDefault(); });
    main.addEventListener('drop', (e) => { e.preventDefault(); [...(e.dataTransfer?.files || [])].forEach((f) => this.addAttachment(f)); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.activeElement !== input) {
        if ($('app').classList.contains('side-open') && matchMedia('(max-width: 860px)').matches) this.closeSidebar();
        else if (this.drawerKind) this.closeDrawer();
        else if (this.view.busy) this.backend?.interrupt().catch(() => {});
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); this.drawerKind === 'settings' ? this.closeDrawer() : this.openSettings(); }
      if (!this.backend) return;
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.openNewSession(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('app').classList.add('side-open'); $('session-search').focus(); }
    });
    window.addEventListener('focus', () => this.refreshSessionsSoon());
    input.focus();
  }

  closeSidebar() {
    const was = $('app').classList.contains('side-open');
    $('app').classList.remove('side-open');
    $('menu').setAttribute('aria-expanded', 'false');
    if (was && $('sidebar').contains(document.activeElement)) $('menu').focus();
  }

  autosize() {
    const i = $('input');
    i.style.height = 'auto';
    i.style.height = Math.min(i.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  prefill(text, hint) {
    const i = $('input');
    i.value = text;
    this.autosize();
    i.focus();
    i.setSelectionRange(text.length, text.length);
    if (hint) this.view.toast(hint, { ms: 5000 });
  }

  onKey(e) {
    const i = $('input');
    if (!this.backend) return;
    if (this.popup && !this.popup.hidden) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); this.movePopup(1); return; }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); this.movePopup(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey && this.popup.items.length) {
        e.preventDefault();
        const exec = this.popup.mode === 'slash' && this.popup.items[this.popup.sel]?.insert && !e.altKey;
        this.acceptPopup(exec);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); this.hidePopup(); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.backend.editing) { this.backend.cancelEdit(); i.value = ''; this.autosize(); this.view.toast('Edit cancelled'); return; }
      if (this.view.busy) this.backend.interrupt().catch((er) => this.view.toast(er.message, { err: true }));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!coarse || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.send();
      return;
    }
    if (e.key === 'ArrowUp' && !i.value) {
      const last = [...document.querySelectorAll('.row-user')].pop();
      if (last) { e.preventDefault(); this.prefill(last.firstChild.textContent); }
    }
  }

  async send() {
    if (!this.backend) return;
    const i = $('input');
    const text = i.value.trim();
    const atts = this.attachments.slice();
    if (!text && !atts.length) return;
    this.hidePopup();
    i.value = '';
    this.autosize();
    this.clearAttachments();
    this.view.setBusy(this.view.busy);
    try {
      if (text.startsWith('/') && !atts.length && !text.startsWith('//')) {
        if (text === '/help' || text === '/?') { this.showHelp(); return; }
        if (text === '/delete') {
          if (confirm('Delete this session permanently?')) { await this.backend.deleteSession(); store.set(`last.${this.backend.name}`, null); this.refreshSessions(); }
          return;
        }
        await this.backend.command(text);
      } else {
        await this.backend.submit(text.replace(/^\/\//, '/'), atts);
      }
    } catch (e) {
      this.view.note(`✗ ${e.message}`, { err: true });
    }
    this.view.scrollSoon(true);
  }

  showHelp() {
    this.view.note([
      'Keys: Enter send · Shift+Enter newline · Esc interrupt / cancel edit · ↑ (empty) recall last · Ctrl+K sessions · Ctrl+Alt+N new session',
      'Type / for commands, @ for files. While a turn runs, Enter queues; use "steer now" on a queued message to inject it.',
      'Client commands: /new /model /compact /branch /rename <t> /diff /agents /delete /stop',
    ].join('\n'));
  }

  // ------------------------------------------------------------ attachments
  async addAttachment(file) {
    const chip = h('span', { class: 'chip' }, h('span', { text: `⏳ ${file.name}` }));
    $('attachments').append(chip);
    try {
      const a = await this.backend.attach(file);
      this.attachments.push(a);
      chip.replaceChildren(
        a.preview ? h('img', { src: a.preview, alt: '' }) : null,
        h('span', { text: a.name }),
        h('button', { text: '✕', onclick: () => { this.attachments = this.attachments.filter((x) => x !== a); chip.remove(); } }));
    } catch (e) {
      chip.remove();
      this.view.toast(`Attach failed: ${e.message}`, { err: true });
    }
  }

  clearAttachments() { this.attachments = []; $('attachments').replaceChildren(); }

  // ------------------------------------------------------------ queue
  renderQueue(items) {
    const q = $('queue');
    q.replaceChildren(...items.map((it) => h('div', { class: 'queue-item' },
      h('span', { class: 'q-tag', text: it.unknown ? 'paused' : 'queued' }), h('span', { text: truncate(it.text, 200), title: it.text }),
      ...(it.actions || []).map((a) => h('button', { class: 'btn-ghost', text: a.label, onclick: () => a.run().catch((e) => this.view.toast(e.message, { err: true })) })))));
  }

  // ------------------------------------------------------------ popup
  updatePopupSoon() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => this.updatePopup(), 90);
  }

  async updatePopup() {
    const i = $('input');
    const text = i.value.slice(0, i.selectionStart);
    if (!(text.startsWith('/') && !text.includes(' ')) && !/(?:^|\s)@[^\s]*$/.test(text)) { this.hidePopup(); return; }
    let res;
    try { res = await this.backend.complete(text); } catch { res = null; }
    if (!res || !res.items?.length || i.value.slice(0, i.selectionStart) !== text) { this.hidePopup(); return; }
    this.popup = { items: res.items, sel: 0, replaceFrom: res.replaceFrom, mode: text.startsWith('/') ? 'slash' : 'path', hidden: false };
    this.renderPopup();
  }

  renderPopup() {
    const p = this.popup;
    const el = $('popup');
    el.replaceChildren(...p.items.map((it, idx) => {
      const row = h('div', { class: `pop-item${idx === p.sel ? ' sel' : ''}`, role: 'option', id: `pop-${idx}`, 'aria-selected': String(idx === p.sel) },
        h('span', { class: 'pi-name', text: it.label }), it.desc ? h('span', { class: 'pi-desc', text: it.desc }) : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); p.sel = idx; this.acceptPopup(false); });
      return row;
    }));
    el.hidden = false;
    $('input').setAttribute('aria-activedescendant', `pop-${p.sel}`);
    el.children[p.sel]?.scrollIntoView({ block: 'nearest' });
  }

  movePopup(d) {
    const p = this.popup;
    p.sel = (p.sel + d + p.items.length) % p.items.length;
    this.renderPopup();
  }

  acceptPopup(execute) {
    const p = this.popup;
    const it = p.items[p.sel];
    const i = $('input');
    const before = i.value.slice(0, p.replaceFrom);
    const after = i.value.slice(i.selectionStart);
    const ins = it.insert;
    const dirLike = p.mode === 'path' && ins.endsWith('/');
    i.value = before + ins + (dirLike ? '' : ' ') + after;
    const pos = (before + ins).length + (dirLike ? 0 : 1);
    i.setSelectionRange(pos, pos);
    this.hidePopup();
    this.autosize();
    if (dirLike) this.updatePopupSoon();
    if (execute && p.mode === 'slash' && it.argless) this.send();
  }

  hidePopup() {
    if (this.popup) this.popup.hidden = true;
    $('popup').hidden = true;
    $('input').removeAttribute('aria-activedescendant');
  }

  // ------------------------------------------------------------ drawers
  async openChanges() {
    this.drawerKind = 'changes';
    const title = this.backend.name === 'pi' ? 'Changes' : 'Changes & checkpoints';
    this.view.openDrawer(title, h('div', { class: 'dr-empty', text: 'Loading…' }));
    try { const el = await this.backend.changesPanel(); if (this.drawerKind === 'changes') this.view.openDrawer(title, el); }
    catch (e) { this.view.openDrawer(title, h('div', { class: 'dr-empty', text: e.message })); }
  }

  async openSubagents() {
    this.drawerKind = 'subagents';
    if (!this.view.drawerOpen()) this.view.openDrawer('Subagents', h('div', { class: 'dr-empty', text: 'Loading…' }));
    try { const el = await this.backend.subagentsPanel(); if (this.drawerKind === 'subagents') this.view.openDrawer('Subagents', el); }
    catch (e) { this.view.openDrawer('Subagents', h('div', { class: 'dr-empty', text: e.message })); }
  }

  closeDrawer() { this.drawerKind = null; this.view.closeDrawer(); }

  // Model sheet: reasoning effort on top, then recently used models, then everything.
  async openModelPicker() {
    const b = this.backend;
    if (!b) return;
    this.drawerKind = 'model';
    const effortBox = h('div', { class: 'mp-effort' });
    const search = h('input', { class: 'side-search', type: 'search', placeholder: 'Filter models…', 'aria-label': 'Filter models', style: 'margin:0 0 10px;width:100%' });
    const list = h('div');
    this.view.openDrawer('Model', h('div', {}, effortBox, search, list));
    list.append(h('div', { class: 'dr-empty', text: 'Loading…' }));
    b.effortOptions?.().then((o) => {
      if (this.drawerKind !== 'model' || !o?.levels || o.levels.length < 2) return;
      effortBox.replaceChildren(
        h('div', { class: 'side-group', style: 'padding-left:0', text: b.name === 'pi' ? 'Thinking level' : 'Reasoning effort' }),
        this.seg(o.levels.map((l) => ({ id: l.id, name: l.name, title: l.desc || l.name })), o.current, async (id) => {
          try { await b.setEffort(id); } catch (e) { this.view.toast(e.message, { err: true }); }
          this.openModelPicker();
        }, 'Reasoning effort'));
    }).catch(() => {});
    let items = [];
    try { items = await b.modelOptions(); } catch (e) { list.replaceChildren(h('div', { class: 'dr-empty', text: e.message })); return; }
    if (this.drawerKind !== 'model') return;
    const key = (it) => `${it.value.provider || ''}/${it.value.model}`;
    const recentKey = `recentModels.${b.name}`;
    const recent = store.get(recentKey, []);
    const pick = async (it) => {
      this.closeDrawer();
      store.set(recentKey, [key(it), ...recent.filter((k) => k !== key(it))].slice(0, 5));
      try { await b.setModel(it.value.model, it.value.provider); } catch (e) { this.view.toast(e.message, { err: true }); }
    };
    const row = (it, withGroup) => {
      const meta = [withGroup ? it.group : '', it.desc].filter(Boolean).join(' · ');
      return h('button', { class: `session-item${it.current ? ' active' : ''}`, 'aria-current': it.current ? 'true' : null, onclick: () => pick(it) },
        h('div', { class: 'si-title', text: it.label }), meta ? h('div', { class: 'si-meta', text: meta }) : null);
    };
    const render = () => {
      const q = search.value.toLowerCase();
      list.replaceChildren();
      if (!q) {
        const rec = recent.map((k) => items.find((it) => key(it) === k)).filter(Boolean);
        const cur = items.find((it) => it.current);
        const top = [...(cur && !rec.includes(cur) ? [cur] : []), ...rec];
        if (top.length) { list.append(h('div', { class: 'side-group', text: 'Current and recent' }), ...top.map((it) => row(it, true))); }
      }
      let g = null;
      for (const it of items.filter((x) => !q || x.label.toLowerCase().includes(q) || (x.group || '').toLowerCase().includes(q))) {
        if (it.group !== g) { g = it.group; list.append(h('div', { class: 'side-group', text: g })); }
        list.append(row(it, false));
      }
      if (!list.childElementCount) list.append(h('div', { class: 'dr-empty', text: 'No model matches.' }));
    };
    search.oninput = render;
    render();
    if (!matchMedia('(pointer: coarse)').matches) search.focus();
  }


  // ------------------------------------------------------------ settings
  async openSettings() {
    this.closeSidebar();
    this.drawerKind = 'settings';
    if (!this.view.drawerOpen() || $('drawer-title').textContent !== 'Settings') this.view.openDrawer('Settings', h('div', { class: 'dr-empty', text: 'Loading…' }));
    let st;
    try {
      const r = await fetch('/api/settings');
      if (r.status === 401) { this.reloadMe(); return; }
      st = await r.json();
    } catch (e) { this.view.openDrawer('Settings', h('div', { class: 'dr-empty', text: e.message })); return; }
    if (this.drawerKind !== 'settings') return;
    const body = $('drawer-body');
    const scroll = body.scrollTop;
    this.view.openDrawer('Settings', h('div', { class: 'settings' },
      this.settingsAgents(st), this.settingsLook(), this.settingsPassword(st), this.settingsAbout(st)));
    body.scrollTop = scroll;
  }

  async postSettings(path, payload) {
    const r = await fetch(`/api/settings/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
    return j;
  }

  seg(options, current, onPick, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...options.map((o) => h('button', {
      class: o.id === current ? 'on' : '', text: o.name, title: o.title || o.name, disabled: o.disabled || null,
      'aria-pressed': String(o.id === current), onclick: () => { if (o.id !== current) onPick(o.id); },
    })));
  }

  settingsAgents(st) {
    const rows = Object.entries(BACKENDS).map(([name, meta]) => {
      const b = st.backends[name];
      const status = b.available
        ? h('div', { class: 'set-meta', text: `${homeify(b.path, this.home)}` })
        : h('div', { class: 'set-meta set-warn', text: b.command ? `${b.command} was not found` : `${meta.name.toLowerCase()} was not found on PATH` });
      const cmd = h('input', { class: 'field', value: b.command, placeholder: `${meta.name.toLowerCase()} (found on PATH)`, spellcheck: 'false', autocomplete: 'off' });
      const saveCmd = async () => {
        if (cmd.value.trim() === b.command) return;
        try { await this.postSettings('backends', { name, command: cmd.value.trim() }); this.view.toast(`${meta.name}: command saved`); }
        catch (e) { this.view.toast(e.message, { err: true }); }
        await this.reloadMe(); this.openSettings();
      };
      cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCmd(); } });
      const details = h('details', { class: 'set-details', open: (!b.available || b.command) ? '' : null },
        h('summary', { text: 'Command' }),
        h('div', { class: 'set-line' }, cmd, h('button', { class: 'key', text: 'Save', onclick: saveCmd })),
        h('div', { class: 'set-hint', text: 'Leave it empty to find the agent on PATH or in ~/.local/bin.' }));
      return h('div', { class: 'set-card' },
        h('div', { class: 'set-row' },
          h('span', { class: 'set-sym', text: meta.sym }),
          h('div', { class: 'grow' }, h('div', { class: 'set-name', text: meta.name }), status),
          this.seg([{ id: true, name: 'On', disabled: !b.available }, { id: false, name: 'Off' }], b.enabled, async (v) => {
            try { await this.postSettings('backends', { name, enabled: v }); } catch (e) { this.view.toast(e.message, { err: true }); }
            await this.reloadMe(); this.openSettings();
          }, `${meta.name} on or off`)),
        details);
    });
    return h('section', { class: 'dr-section' }, h('h3', { text: 'Agents' }), ...rows,
      h('div', { class: 'set-hint', text: 'An agent that is off disappears from the sidebar and the server refuses its connections. Sessions that are already open keep running until you close them.' }));
  }

  // Settings → Appearance. Changes apply at once and redraw only this section, keeping focus.
  settingsLook() {
    const p = readPrefs();
    const flat = p.look === 'flat';
    const set = (key, value) => { this.setAppearance(key, value); this.refreshLook(); };
    const pair = (key, label, control) => h('div', { class: 'set-pair', dataset: { k: key } },
      h('label', { class: 'set-label', text: label, for: control.id || null }), control);
    const segPair = (key, label, options, current) => h('div', { class: 'set-pair', dataset: { k: key } },
      h('span', { class: 'set-label', text: label }), this.seg(options, current, (v) => set(key, v), label));
    const select = (key, options, current) => {
      const el = h('select', { class: 'field', id: `set-${key}` }, ...options.map((o) => h('option', {
        value: o.id ?? '', text: o.name, selected: o.id === current ? '' : null,
      })));
      el.onchange = () => set(key, options[el.selectedIndex].id);
      return el;
    };
    const sec = h('section', { class: 'dr-section set-appearance' }, h('h3', { text: 'Appearance' }),
      segPair('look', 'Look', LOOKS, p.look));
    if (flat) {
      const auto = resolveScheme(null) === 'contrast' ? 'High contrast' : 'Neutral';
      sec.append(pair('scheme', 'Colour scheme',
        select('scheme', [{ id: null, name: `Automatic (${auto})` }, ...SCHEMES], p.scheme)));
    }
    sec.append(segPair('theme', 'Mode', MODES, p.mode));
    if (flat) sec.append(...this.accentRows(p, set));
    sec.append(
      pair('uiFont', 'Interface font', select('uiFont',
        UI_FONTS.map((o) => (o.id ? o : { ...o, name: flat ? 'Theme default (System)' : 'Theme default (Grotesk and Antiqua)' })), p.uiFont)),
      pair('codeFont', 'Code font', select('codeFont', CODE_FONTS, p.codeFont)),
      segPair('textSize', 'Text size', TEXT_SIZES, p.textSize),
      h('div', { class: 'set-hint', text: flat
        ? 'Saved in this browser. Without a picked scheme, High contrast follows the system’s “more contrast” setting.'
        : 'Saved in this browser.' }));
    return sec;
  }

  accentRows(p, set) {
    const custom = p.accent?.startsWith('#') ? p.accent : null;
    const swatch = (a) => h('button', {
      class: `swatch${p.accent === a.id ? ' on' : ''}`, style: `--sw: var(--acc-${a.id})`, title: a.name,
      'aria-label': a.name, 'aria-pressed': String(p.accent === a.id), onclick: () => set('accent', a.id),
    });
    const now = token('--accent');
    const picker = h('input', { type: 'color', id: 'set-accent-custom', value: /^#[0-9a-f]{6}$/i.test(now) ? now : '#2c5bd0' });
    picker.oninput = () => this.setAppearance('accent', picker.value);   // live while dragging
    picker.onchange = () => set('accent', picker.value);
    const row = h('div', { class: 'set-pair', dataset: { k: 'accent' } },
      h('span', { class: 'set-label', text: 'Accent' }),
      h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' },
        h('button', {
          class: `swatch default${p.accent ? '' : ' on'}`, text: 'Scheme', title: 'The colour scheme’s own accent',
          'aria-pressed': String(!p.accent), onclick: () => set('accent', null),
        }),
        ...ACCENTS.map(swatch),
        h('label', { class: `swatch-custom${custom ? ' on' : ''}`, title: 'Pick any colour' }, picker, 'Custom')));
    const ratio = contrast(now, token('--bg'));
    if (ratio === null || ratio >= 3) return [row];
    return [row, h('div', { class: 'set-warn', role: 'status',
      text: `This accent has only ${ratio.toFixed(1)}:1 contrast with the background (3:1 is the minimum); highlights and lit keys will be hard to see.` })];
  }

  refreshLook() {
    const old = document.querySelector('.set-appearance');
    if (!old) return;
    const focused = document.activeElement;
    const key = old.contains(focused) ? focused.closest('[data-k]')?.dataset.k : null;
    const sec = this.settingsLook();
    old.replaceWith(sec);
    if (key) sec.querySelector(`[data-k="${key}"] :is(select, input, .on)`)?.focus();
  }

  settingsPassword(st) {
    const sec = h('section', { class: 'dr-section' }, h('h3', { text: 'Password' }));
    const err = h('div', { class: 'set-err', role: 'alert' });
    const field = (ph, ac) => h('input', { class: 'field', type: 'password', placeholder: ph, autocomplete: ac });
    const cur = st.password_set ? field('Current password', 'current-password') : null;
    const pw1 = field(st.password_set ? 'New password' : 'Password', 'new-password');
    const pw2 = field('Repeat it', 'new-password');
    const run = async (payload, done) => {
      err.textContent = '';
      try { await this.postSettings('password', payload); }
      catch (e) { err.textContent = e.message; return; }
      this.view.toast(done, { ms: 5000 });
      await this.reloadMe();
      this.openSettings();
    };
    const save = (e) => {
      e.preventDefault();
      if (pw1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; pw1.focus(); return; }
      if (pw1.value !== pw2.value) { err.textContent = 'The two passwords differ.'; pw2.focus(); return; }
      run({ current: cur?.value || '', new: pw1.value }, st.password_set ? 'Password changed. Other browsers were signed out.' : 'Password set. Other browsers were signed out.');
    };
    const exposed = st.exposed.length ? st.exposed.join(', ') : null;
    if (st.password_set) {
      sec.append(h('div', { class: 'set-state' }, h('span', { class: 'lamp ok' }), 'A password is set.'));
    } else {
      sec.append(h('div', { class: `set-state${exposed ? ' warn' : ''}` }, h('span', { class: `lamp ${exposed ? 'bad' : 'wait'}` }),
        exposed ? `No password, and this server is reachable from ${exposed}. Anyone there can run commands as ${st.user}.`
          : 'No password. Only this machine can connect, which is fine until you expose the server.'));
    }
    const form = h('form', { class: 'set-form', onsubmit: save },
      // a hidden username helps password managers file the entry
      h('input', { type: 'text', autocomplete: 'username', value: 'stellwerk', hidden: '', readonly: '' }),
      cur, pw1, pw2, err,
      h('div', { class: 'set-line' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: st.password_set ? 'Change password' : 'Set password' }),
        st.password_set ? h('button', { class: 'btn', type: 'button', text: 'Remove password', onclick: () => {
          if (!cur.value) { err.textContent = 'Type the current password to remove it.'; cur.focus(); return; }
          const warn = exposed ? `\n\nThis server is reachable from ${exposed}: anyone there will be able to run commands as ${st.user}.` : '';
          if (!confirm(`Remove the password?${warn}`)) return;
          run({ current: cur.value, new: '' }, 'Password removed.');
        } }) : null));
    sec.append(form);
    if (st.password_set) {
      sec.append(h('div', { class: 'set-line set-gap' },
        h('button', { class: 'btn', text: 'Sign out other browsers', onclick: async () => {
          try { await this.postSettings('revoke', {}); this.view.toast('Every other browser was signed out.'); } catch (e) { this.view.toast(e.message, { err: true }); }
        } })));
    }
    sec.append(h('div', { class: 'set-hint', text: 'Locked out? On the server, run  python -m server.app --set-password  or  --clear-password.' }));
    return sec;
  }

  settingsAbout(st) {
    return h('section', { class: 'dr-section' }, h('h3', { text: 'About' }),
      h('div', { class: 'set-meta', text: `Stellwerk ${st.version}` }),
      h('div', { class: 'set-meta', text: `Settings: ${homeify(st.config_file, this.home)}` }));
  }

  // ------------------------------------------------------------ usage
  async openUsage(period = this._usagePeriod || 'all') {
    const b = this.backend;
    if (!b) return;
    this._usagePeriod = period;
    this.drawerKind = 'usage';
    const title = `${b.appName} usage`;
    if (!this.view.drawerOpen() || $('drawer-title').textContent !== title) this.view.openDrawer(title, h('div', { class: 'dr-empty', text: 'Loading…' }));
    const [sess, all] = await Promise.all([
      b.sessionUsage?.().catch(() => null),
      fetch(`/api/usage/${b.name}`).then((r) => r.json()).catch(() => ({ available: false })),
    ]);
    if (this.drawerKind !== 'usage' || b !== this.backend) return;
    const num = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString());
    const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(Number(v) && Number(v) < 1 ? 4 : 2)}`);
    const grid = (t, extra = []) => h('dl', { class: 'usage-grid' }, ...[
      ['Input', num(t.input)], ['Output', num(t.output)], ['Cache reads', num(t.cache_read)], ['Cache writes', num(t.cache_write)],
      ['Reasoning', t.reasoning == null ? '—' : num(t.reasoning)], ['API calls', num(t.calls)], ['Cost', money(t.cost)], ...extra,
    ].flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
    const secSession = h('section', { class: 'dr-section' }, h('h3', { text: 'This session' }),
      sess ? grid(sess, sess.tps ? [['Speed', `${Number(sess.tps).toFixed(1)} tok/s`]] : []) : h('div', { class: 'dr-empty', text: 'No session open.' }));
    const secAll = h('section', { class: 'dr-section' }, h('h3', { text: 'All time' }));
    if (!all.available) secAll.append(h('div', { class: 'dr-empty', text: `Not available${all.error ? `: ${all.error}` : ''}.` }));
    else {
      const per = all.periods[period];
      secAll.append(
        this.seg([{ id: 'today', name: 'Today' }, { id: 'week', name: '7 days' }, { id: 'month', name: '30 days' }, { id: 'all', name: 'All' }],
          period, (p) => this.openUsage(p), 'Period'),
        grid(per.total),
        per.models.length ? h('ul', { class: 'usage-models', 'aria-label': 'By model' }, ...per.models.map((m) => h('li', {},
            h('div', { class: 'um-head' }, h('span', { class: 'um-name', text: m.model, title: m.model }), h('span', { class: 'um-cost', text: money(m.cost) })),
            h('div', { class: 'um-meta', text: [`${fmtTokens(m.input)} in`, `${fmtTokens(m.output)} out`,
              m.cache_read || m.cache_write ? `cache ${fmtTokens(m.cache_read)} read / ${fmtTokens(m.cache_write)} written` : '', `${m.calls} call${m.calls === 1 ? '' : 's'}`].filter(Boolean).join(' · ') }))))
          : h('div', { class: 'dr-empty', text: 'Nothing in this period.' }),
        h('div', { class: 'set-hint', text: b.name === 'hermes'
          ? `From Hermes' session store (${all.sessions} session${all.sessions === 1 ? '' : 's'} with messages). Deleted sessions no longer count; a session's usage is dated by when it was last used.`
          : `From Pi's session files (${all.sessions}). Deleted sessions no longer count.` }));
    }
    const body = $('drawer-body'); const keep = body.scrollTop;
    this.view.openDrawer(title, h('div', {}, secSession, secAll));
    body.scrollTop = keep;
  }

  async openEffortPicker() {
    if (!this.backend) return;
    this.drawerKind = 'effort';
    const title = this.backend.name === 'pi' ? 'Thinking level' : 'Reasoning effort';
    this.view.openDrawer(title, h('div', { class: 'dr-empty', text: 'Loading…' }));
    let o;
    try { o = await this.backend.effortOptions(); } catch (e) { this.view.openDrawer(title, h('div', { class: 'dr-empty', text: e.message })); return; }
    if (this.drawerKind !== 'effort') return;
    this.view.openDrawer(title, h('div', {},
      o.note ? h('div', { class: 'dr-empty', style: 'margin-bottom:10px', text: o.note }) : null,
      ...o.levels.map((l) => h('button', { class: `session-item${l.id === o.current ? ' active' : ''}`, onclick: async () => {
        this.closeDrawer();
        try { await this.backend.setEffort(l.id); } catch (e) { this.view.toast(e.message, { err: true }); }
      } }, h('div', { class: 'si-title', text: l.name }), l.desc ? h('div', { class: 'si-meta', text: l.desc }) : null))));
  }

  async openNewSession() {
    this.closeSidebar();
    if (!this.backend) return;
    this.drawerKind = 'new';
    const list = h('div');
    const pathEl = h('div', { class: 'dr-meta', style: 'margin-bottom:8px;word-break:break-all' });
    const startHere = h('button', { class: 'btn btn-primary', style: 'width:100%;margin-bottom:12px' });
    const box = h('div', {}, startHere, pathEl, list);
    this.view.openDrawer(`New ${this.backend.appName} session`, box);
    const load = async (path) => {
      let r;
      try { r = await fetch('/api/dirs?path=' + encodeURIComponent(path || '')).then((x) => x.json()); }
      catch (e) { list.replaceChildren(h('div', { class: 'dr-empty', text: e.message })); return; }
      pathEl.textContent = homeify(r.path, r.home);
      startHere.textContent = `Start in ${homeify(r.path, r.home)}`;
      startHere.onclick = () => this.startNew(r.path);
      list.replaceChildren(
        r.path !== '/' ? h('button', { class: 'session-item', onclick: () => load(r.parent) }, h('div', { class: 'si-title', text: '↰ ..' })) : null,
        ...r.dirs.map((d) => h('div', { style: 'display:flex;gap:4px' },
          h('button', { class: 'session-item', style: 'flex:1', onclick: () => load(d.path) }, h('div', { class: 'si-title', text: `${d.git ? '⎇ ' : '▸ '}${d.name}` })),
          h('button', { class: 'btn-ghost', text: 'start', onclick: () => this.startNew(d.path) }))));
    };
    load(this.cwd || '');
  }

  async startNew(path) {
    this.cwd = path;
    store.set('cwd', path);
    this.closeDrawer();
    try {
      await this.backend.newSession(path);
      this.refreshSessions();
      $('input').focus();
    } catch (e) { this.view.toast(`Could not start: ${e.message}`, { err: true }); }
  }
}

// Size the app to the part of the screen that is actually visible (phones: browser bars,
// on-screen keyboard) and undo any scroll the browser left the page at.
function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--app-h', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
window.addEventListener('resize', fitViewport);
fitViewport();

const app = new App();
window.stellwerk = app;
app.boot();
