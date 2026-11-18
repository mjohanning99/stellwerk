// Rendering helpers: markdown (sanitized), diffs, small DOM utilities.

/* global marked, DOMPurify, hljs */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

marked.use({ gfm: true, breaks: false });

// GFM in marked strikes through ~single~ tildes too, so "about ~1 s … (~730 tok/s)" came
// out crossed out. Agents write ~ for "about" all the time; only ~~double~~ strikes.
const DEL2 = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/;
marked.use({
  tokenizer: {
    del(src) {
      const m = DEL2.exec(src);
      if (m) return { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      if (src[0] === '~') { const run = /^~+/.exec(src)[0]; return { type: 'text', raw: run, text: run, escaped: false }; }
      return undefined;
    },
  },
});

const purifyCfg = { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['style'] };
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

export function renderMarkdown(el, text, { final = true } = {}) {
  const html = DOMPurify.sanitize(marked.parse(text || ''), purifyCfg);
  el.innerHTML = html;
  el.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (final && code && !code.dataset.hl) {
      try { hljs.highlightElement(code); } catch { /* ignore */ }
      code.dataset.hl = '1';
    }
    const btn = h('button', { class: 'copy', text: 'copy' });
    btn.addEventListener('click', () => copyText(code ? code.textContent : pre.textContent, btn));
    pre.append(btn);
  });
}

export async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* needs https (LAN is http) */ }
  if (!ok) {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (btn) { const t = btn.textContent; btn.textContent = ok ? 'copied' : 'copy failed'; setTimeout(() => { btn.textContent = t; }, 1200); }
}

// Render a unified diff (or a list of {path, diff}) into a .diff element.
export function renderDiff(diffText, { path, cwd, home } = {}) {
  const rel = (p) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : homeify(p, home));
  const box = h('div', { class: 'diff' });
  if (!diffText) return box;
  let oldN = 0, newN = 0;
  for (const line of String(diffText).replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).replace(/^b\//, '');
        if (p !== '/dev/null') box.append(h('div', { class: 'diff-file', text: rel(p) }));
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      if (m) { oldN = +m[1]; newN = +m[2]; }
      box.append(h('div', { class: 'diff-line hunk' }, h('span', { class: 'ln' }, '⋯'), h('span', { class: 'tx', text: line })));
      continue;
    }
    let cls = '', ln = '';
    if (line.startsWith('+')) { cls = 'add'; ln = newN++; }
    else if (line.startsWith('-')) { cls = 'del'; ln = oldN++; }
    else if (line.startsWith('\\')) { cls = 'hunk'; }
    else { ln = newN++; oldN++; }
    box.append(h('div', { class: `diff-line ${cls}` }, h('span', { class: 'ln', text: ln === '' ? '' : String(ln) }), h('span', { class: 'tx', text: line || ' ' })));
  }
  if (path && !box.querySelector('.diff-file')) box.prepend(h('div', { class: 'diff-file', text: path }));
  return box;
}

// Build a unified-ish diff from old/new strings (for edit tools that send both).
export function diffFromStrings(oldStr = '', newStr = '', path = '') {
  const a = String(oldStr).split('\n'), b = String(newStr).split('\n');
  // LCS on lines (bounded) for readable small edits.
  const n = a.length, m = b.length;
  if (n * m > 400000) {
    return `+++ ${path}\n@@ -1,${n} +1,${m} @@\n` + a.map((l) => '-' + l).join('\n') + '\n' + b.map((l) => '+' + l).join('\n');
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push('-' + a[i++]);
    else out.push('+' + b[j++]);
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return `+++ ${path}\n@@ -1,${n} +1,${m} @@\n` + out.join('\n');
}

export function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function fmtTokens(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

export function relTime(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
  if (isNaN(t)) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function homeify(p, home) {
  if (!p) return '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
