// Accessibility audit with axe-core (WCAG 2.1 A/AA) over the main views in every look/mode,
// with a staged transcript (no agent calls).
//   npm install axe-core   (anywhere)  then
//   node tools/e2e/a11y.mjs <url> <path/to/axe.min.js> [--verbose]
import { chromium, devices } from 'playwright';

const [base, axePath, flag] = process.argv.slice(2);
const verbose = flag === '--verbose';
const browser = await chromium.launch();

async function stage(page) {
  await page.evaluate(async () => {
    const app = window.stellwerk, v = app.view;
    app.backend?.stop?.();
    app.refreshSessions = async () => {};
    v.setSessions([
      { id: 'a', title: 'Add a --json flag to the export command', sub: '~/project · 14 msgs', time: Date.now() / 1000, group: 'Today', live: true },
      { id: 'b', title: 'Fix the flaky login test', sub: '~/project · 32 msgs', time: Date.now() / 1000 - 7200, group: 'Today' },
    ], 'a', () => {}, () => {});
    v.clear();
    v.setTitle('Add a --json flag to the export command', '~/project · local model');
    v.addUser({ text: 'Add a --json flag to the export command', onEdit: () => {} });
    v.reasoningBlock('Looking at the export command first.');
    v.toolStart('t1', { name: 'read_file', args: { path: '/home/me/project/src/cli/export.ts' } });
    v.toolComplete('t1', { name: 'read_file', output: 'line\n'.repeat(40) });
    v.toolStart('t2', { name: 'patch', args: { path: '/home/me/project/src/cli/export.ts' } });
    v.toolComplete('t2', { name: 'patch', diff: '+++ /home/me/project/src/cli/export.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n-printTable(rows);\n+if (opts.json) print(rows);\n+else printTable(rows);\n' });
    v.assistant('The export command now takes `--json`.\n\n## What changed\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> a quote with a [link](https://example.com)');
    v.note('└ Model set to local-model');
    v.setStatus({ model: 'local-model', effort: 'effort medium', cwd: '/home/me/project', context: { used: 18000, max: 262000 }, cost: '$0.0123', tps: { v: 42, exact: true } });
    app.renderQueue([{ text: 'Then mention the flag in the README', actions: [{ label: 'steer now', run: async () => {} }, { label: '✕', run: async () => {} }] }]);
    v.promptChoice('k', { title: 'Hermes wants to run this — allow?', command: 'git commit -am "export: add a --json flag"', choices: [{ label: 'Yes', value: 1 }, { label: 'No', value: 2 }] });
  });
}

async function audit(page, label) {
  await page.addScriptTag({ path: axePath });
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length,
      nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}  ${(n.failureSummary || '').split('\n').slice(1, 2).join(' ').trim()}`) }));
  });
  console.log(`\n## ${label}: ${res.length ? res.map((v) => `${v.id}(${v.n})`).join(', ') : 'no violations'}`);
  if (verbose) for (const v of res) { console.log(`  - [${v.impact}] ${v.id}: ${v.help}`); for (const n of v.nodes) console.log(`      ${n}`); }
  return res;
}

let total = 0;
const combos = [['flat', 'light', null], ['flat', 'dark', null], ['flat', 'light', 'contrast'], ['flat', 'dark', 'contrast'], ['nachtzug', 'light', null], ['nachtzug', 'dark', null]];
for (const [look, mode, scheme] of combos) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, bypassCSP: true });
  await ctx.addInitScript(([l, m, s]) => {
    localStorage.setItem('sw.look', JSON.stringify(l)); localStorage.setItem('sw.theme', JSON.stringify(m));
    if (s) localStorage.setItem('sw.scheme', JSON.stringify(s));
  }, [look, mode, scheme]);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await stage(page);
  const tag = `${look}${scheme ? '/' + scheme : ''} ${mode}`;
  total += (await audit(page, `${tag}: transcript`)).length;
  if (look === 'flat' && mode === 'light' && !scheme) {
    await page.click('#btn-settings'); await page.waitForSelector('.settings');
    total += (await audit(page, `${tag}: settings`)).length;
    await page.click('#drawer-close');
    await page.click('#st-cost'); await page.waitForSelector('.usage-grid, .dr-empty');
    total += (await audit(page, `${tag}: usage`)).length;
  }
  await ctx.close();
}
const phone = await browser.newContext({ ...devices['Pixel 7'], bypassCSP: true });
const pp = await phone.newPage();
await pp.goto(base); await pp.waitForSelector('#app:not([hidden])');
await stage(pp);
await pp.click('#menu'); await pp.waitForTimeout(300);
total += (await audit(pp, 'phone: sidebar open')).length;
console.log(`\n${total} violation type(s) in total`);
process.exitCode = total ? 1 : 0;
await browser.close();
