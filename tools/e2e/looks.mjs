// Screenshots of every look × colour scheme × mode with the same staged transcript
// (no agent call), plus the Settings → Appearance drawer and a phone view.
// usage: node looks.mjs <base_url> <password-or-""> <outdir>
// It only changes this browser's appearance settings (localStorage), nothing on the server.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base, password, out = 'shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(base);
await page.waitForFunction(() => !document.getElementById('login').hidden || !document.getElementById('app').hidden);
if (await page.isVisible('#login-pw')) {
  await page.fill('#login-pw', password);
  await page.click('#login-form button');
}
await page.waitForSelector('#app:not([hidden])');
// the agent may be missing or still starting: the transcript is staged either way
await page.waitForFunction(() => window.stellwerk?.backend?.ready, null, { timeout: 8000 }).catch(() => {});
await page.evaluate(() => document.fonts.ready);
// keep the agent's real session list out of the shots: only the staged one below is shown
// Disconnect from the agent too: a list request already in flight would otherwise land after
// staging and draw real session titles into the shot.
await page.evaluate(() => {
  const app = window.stellwerk;
  app.refreshSessions = async () => {};
  app.refreshSessionsSoon = () => {};
  app.backend?.stop();
});
await page.waitForTimeout(1500);
const STAGED = ['Add a --json flag to the export command', 'Fix the flaky login test', 'Dark mode for the settings page', 'Speed up the CSV importer', 'Write the release notes'];
async function assertStaged() {
  const titles = await page.$$eval('#session-list .si-title', (els) => els.map((e) => e.textContent.replace(/^● /, '')));
  const stray = titles.filter((t) => !STAGED.includes(t));
  if (stray.length) throw new Error(`refusing to save a screenshot: the sidebar shows non-staged sessions (${stray.length})`);
}

async function stage() {
  await page.evaluate(() => {
    const app = window.stellwerk, v = app.view;
    if (app.backend) app.backend.sid = null;
    v.clear();
    v.cwd = '/home/me/project';
    v.setTitle('Add a --json flag to the export command', '~/project · local model');
    v.addUser({ text: 'The export command only prints a table. Can you add a --json flag so scripts can read its output?' });
    v.reasoningBlock('The export command lives in src/cli/export.ts. It builds rows and hands them to printTable()…');
    v.toolStart('t1', { name: 'search_files', args: { pattern: 'printTable', path: '/home/me/project/src' } });
    v.toolComplete('t1', { name: 'search_files', output: 'src/cli/export.ts:41\nsrc/cli/list.ts:27\nsrc/table.ts:3', duration: 41 });
    v.toolStart('t2', { name: 'read_file', args: { path: '/home/me/project/src/cli/export.ts' } });
    v.toolComplete('t2', { name: 'read_file', output: Array.from({ length: 64 }, (_, i) => `line ${i}`).join('\n'), duration: 12 });
    v.toolStart('t3', { name: 'patch', args: { path: '/home/me/project/src/cli/export.ts' } });
    v.toolComplete('t3', {
      name: 'patch', duration: 18,
      diff: '+++ /home/me/project/src/cli/export.ts\n@@ -38,6 +38,9 @@\n export async function exportCmd(opts: ExportOptions) {\n   const rows = await collectRows(opts);\n-  printTable(rows);\n+  // machine-readable output for scripts\n+  if (opts.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\\n");\n+  else printTable(rows);\n }',
    });
    v.toolStart('t4', { name: 'terminal', args: { command: 'npm test -- export' } });
    v.toolComplete('t4', { name: 'terminal', output: 'PASS  test/export.test.ts\nTests: 6 passed, 6 total', duration: 3840 });
    v.assistant([
      'The export command now takes **`--json`** and prints the same rows as a JSON array, so scripts can pipe it into other tools.',
      '',
      '### What changed',
      '- `exportCmd()` writes JSON when `opts.json` is set and the table otherwise.',
      '- The tests pass; no other command needed touching.',
      '',
      '```ts',
      'if (opts.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\\n");',
      'else printTable(rows);',
      '```',
      '',
      '> If you’d like one object per line instead (easier to stream), that is a one-line change.',
    ].join('\n'));
    v.promptChoice('demo', {
      title: 'Hermes wants to run this — allow?', command: 'git commit -am "export: add a --json flag"',
      choices: [{ label: 'Yes', value: 1 }, { label: 'Yes, and don’t ask again this session', value: 2 }, { label: 'No, and tell Hermes what to do differently', value: 3 }],
    });
    app.renderQueue([{ text: 'Then mention the flag in the README', actions: [{ label: 'steer now', run: async () => {} }, { label: '✕', run: async () => {} }] }]);
    v.setStatus({ model: 'local-model · medium', cwd: '/home/me/project', context: { used: 18400, max: 262144 }, cost: '' });
    v.setBusy(false);
    app.view.scrollSoon(true);
    app.view.setSessions([
      { id: 'a', title: 'Add a --json flag to the export command', sub: '~/project · 14 msgs', time: Date.now() / 1000 - 60, group: 'Today', live: true },
      { id: 'b', title: 'Fix the flaky login test', sub: '~/project · 32 msgs', time: Date.now() / 1000 - 7200, group: 'Today' },
      { id: 'c', title: 'Dark mode for the settings page', sub: '~/webapp · 9 msgs', time: Date.now() / 1000 - 90000, group: 'Yesterday' },
      { id: 'd', title: 'Speed up the CSV importer', sub: '~/project · 21 msgs', time: Date.now() / 1000 - 300000, group: 'This week' },
      { id: 'e', title: 'Write the release notes', sub: '~/webapp · 6 msgs', time: Date.now() / 1000 - 400000, group: 'This week' },
    ], 'a', () => {});
    v.setConn('open');
  });
  await page.waitForTimeout(250);
  await assertStaged();
}

// Sets appearance keys (as the Settings drawer stores them) and re-applies.
async function appearance(prefs) {
  await page.evaluate((p) => {
    for (const k of ['look', 'theme', 'scheme', 'accent', 'uiFont', 'codeFont', 'textSize']) localStorage.removeItem('sw.' + k);
    for (const [k, v] of Object.entries(p)) localStorage.setItem('sw.' + k, JSON.stringify(v));
    window.stellwerk.applyAppearance();
  }, prefs);
  await page.evaluate(() => document.fonts.ready);
}

// --readme <dir>: just the three README screenshots (hero, settings, phone) into <dir>
const readmeAt = process.argv.indexOf('--readme');
if (readmeAt > 0) {
  const dir = process.argv[readmeAt + 1];
  mkdirSync(dir, { recursive: true });
  await appearance({ look: 'flat', theme: 'light' });
  await stage();
  await page.evaluate(() => window.stellwerk.view.setStatus({ tps: { v: 48.6, exact: true }, cost: '$0.0412' }));
  await page.screenshot({ path: `${dir}/hero.png` });
  await page.click('#btn-settings');
  await page.waitForSelector('.settings');
  // a scratch config dir would show up in "About"; show the default location instead
  await page.evaluate(() => document.querySelectorAll('.set-meta').forEach((e) => { e.textContent = e.textContent.replace(/Settings: .*/, 'Settings: ~/.config/stellwerk/config.json'); }));
  await page.evaluate(() => document.querySelector('.set-appearance')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await assertStaged();
  await page.screenshot({ path: `${dir}/settings.png` });
  await page.click('#drawer-close');
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance({ look: 'flat', theme: 'dark' });
  await stage();
  await page.screenshot({ path: `${dir}/phone.png` });
  console.log('README shots in', dir, '· errors:', errors.join(' | ') || 'none');
  await browser.close();
  process.exit(0);
}

const SCHEMES = ['neutral', 'harbour', 'moss', 'plum', 'contrast'];
const shots = [];
for (const theme of ['light', 'dark']) {
  for (const scheme of SCHEMES) shots.push([`flat-${scheme}-${theme}`, { look: 'flat', scheme, theme }]);
  shots.push([`nachtzug-${theme}`, { look: 'nachtzug', theme }]);
}
// a few combinations of the other settings
shots.push(['flat-neutral-light-accent-amber-inter', { look: 'flat', theme: 'light', accent: 'amber', uiFont: 'inter' }]);
shots.push(['flat-moss-dark-accent-custom-jetbrains-125', { look: 'flat', scheme: 'moss', theme: 'dark', accent: '#e05d9b', codeFont: 'jetbrains', textSize: 125 }]);
shots.push(['nachtzug-light-atkinson-90', { look: 'nachtzug', theme: 'light', uiFont: 'atkinson', textSize: 90 }]);

for (const [name, prefs] of shots) {
  await appearance(prefs);
  await stage();
  await page.screenshot({ path: `${out}/look-${name}.png` });
  console.log('shot', name);
}

// Settings → Appearance
for (const [name, prefs] of [
  ['flat-light', { look: 'flat', theme: 'light' }],
  ['flat-dark-lowcontrast', { look: 'flat', scheme: 'harbour', theme: 'dark', accent: '#203040' }],
  ['nachtzug-dark', { look: 'nachtzug', theme: 'dark' }],
]) {
  await appearance(prefs);
  await page.click('#btn-settings');
  await page.waitForSelector('.set-appearance');
  await page.evaluate(() => document.querySelector('.set-appearance').scrollIntoView());
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/settings-appearance-${name}.png` });
  await page.click('#drawer-close');
  console.log('shot settings', name);
}

// phone
await page.setViewportSize({ width: 390, height: 844 });
for (const [name, prefs] of [['flat-light', { look: 'flat', theme: 'light' }], ['flat-dark', { look: 'flat', theme: 'dark' }], ['nachtzug-dark', { look: 'nachtzug', theme: 'dark' }]]) {
  await appearance(prefs);
  await stage();
  await page.screenshot({ path: `${out}/look-${name}-phone.png` });
}
await appearance({});
console.log('errors:', errors.join(' | ') || 'none');
await browser.close();
