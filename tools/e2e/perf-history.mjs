// Rendering cost of a long history, with synthetic rows (no agent involved).
// usage: node perf-history.mjs <url> [rows=400]
import { chromium } from 'playwright';
const [base, n = '400'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base);
await page.waitForSelector('#app:not([hidden])');
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
const r = await page.evaluate(async (count) => {
  const app = window.stellwerk, b = app.backend;
  b.stop?.();   // keep live traffic from interfering
  const md = '## Plan\n\nHere is what I found in `server/app.py`:\n\n- one thing\n- another **thing**\n\n```python\ndef f(x):\n    return x * 2  # double\n```\n\nAnd a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const rows = [];
  for (let i = 0; i < count; i++) {
    const k = i % 4;
    if (k === 0) rows.push({ role: 'user', text: `Question ${i}: please look at the parser and fix the bug`, row_id: i });
    else if (k === 1) rows.push({ role: 'tool', name: 'read_file', args: { path: '/home/me/project/server/app.py' }, context: 'server/app.py', tool_call_id: `t${i}` });
    else if (k === 2) rows.push({ role: 'tool', name: 'terminal', args: { command: 'pytest -q' }, context: 'pytest -q', tool_call_id: `t${i}` });
    else rows.push({ role: 'assistant', text: md.repeat(2), reasoning: 'thinking about it '.repeat(30) });
  }
  const t0 = performance.now();
  app.view.clear();
  app.view.beginHistory(); b._renderHistory(rows, rows); app.view.endHistory();
  const tRender = performance.now() - t0;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  const tPaint = performance.now() - t0;
  const before = document.querySelectorAll('#rows > .row').length; const label = document.querySelector('#rows > .older')?.textContent;
  const sc = document.getElementById('transcript'); sc.scrollTop = 0; const firstTop = document.querySelector('#rows > .row').getBoundingClientRect().top;
  document.querySelector('#rows > .older').click();
  const after = document.querySelectorAll('#rows > .row').length;
  const firstTopAfter = [...document.querySelectorAll('#rows > .row')][after - before].getBoundingClientRect().top;
  const mds = document.querySelectorAll('#rows > .row-assistant .md');
  return { rows: count, render_ms: Math.round(tRender), until_painted_ms: Math.round(tPaint), drawn: before, label, after_click: after, row_stayed_put: Math.abs(firstTopAfter - firstTop) < 2, older_md_rendered: mds[0].childElementCount > 0 };
}, Number(n));
console.log(JSON.stringify(r));
await browser.close();
