// Streaming render cost and correctness, in the real page (no agent involved).
// usage: node perf-stream.mjs <url>
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(process.argv[2]);
await page.waitForSelector('#app:not([hidden])');
const r = await page.evaluate(async () => {
  const { stableCut } = await import('/static/js/ui.js');
  const { renderMarkdown } = await import('/static/js/render.js');
  const cases = [
    ['a\n\nb', 0, 3],
    ['a\n\n```\nx\n\ny\n', 0, 3],            // open fence with a blank line inside: cut before the fence
    ['a\n\n```\nx\n\ny\n```\n\nz', 0, 17],  // closed fence: cut after it
    ['no blank line yet', 0, 0],
    ['p1\n\np2\n\np3', 4, 8],
  ];
  const cut = cases.map(([t, f, want]) => ({ t, got: stableCut(t, f), want }));
  const v = window.stellwerk.view;
  const chunk = 'Some **markdown** with `code` and a list:\n\n- one\n- two\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\n';
  // incremental (new) vs full re-render (old), 200 frames up to ~40 kB
  const md = document.createElement('div'); const s = { md, text: '', done: 0, tail: [] };
  let tNew = 0, tOld = 0; const old = document.createElement('div');
  for (let i = 0; i < 200; i++) {
    s.text += chunk;
    let t0 = performance.now(); v._renderSegment(s); tNew += performance.now() - t0;
    t0 = performance.now(); renderMarkdown(old, s.text, { final: false }); tOld += performance.now() - t0;
  }
  // mid-stream DOM should match a full render's text content (formatting aside)
  const full = document.createElement('div'); renderMarkdown(full, s.text);
  return { cut, new_ms: Math.round(tNew), old_ms: Math.round(tOld), kb: Math.round(s.text.length / 1024),
    same_text: md.textContent.replace(/copy/g, '') === full.textContent.replace(/copy/g, '') };
});
console.log(JSON.stringify(r, null, 1), errors.length ? errors : 'no page errors');
await browser.close();
