// Deleting sessions from the sidebar and changing the reasoning effort, for both agents.
// It creates two throwaway Hermes sessions and deletes them again. For Pi, point the server
// at a scratch sessions folder holding one session named "e2e delete me (pi)":
//   PI_SESSIONS_DIR=/tmp/pisess STELLWERK_TRASH=/tmp/trash STELLWERK_CONFIG=/tmp/hw python -m server.app
//   node tools/e2e/sessions.e2e.mjs <url> <password|""> <outdir>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base, password, out = 'shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (cond, m) => (cond ? console.log('ok  ', m) : fail(m));
const app = (fn, arg) => page.evaluate(fn, arg);

await page.goto(base);
await page.waitForFunction(() => !document.getElementById('login').hidden || !document.getElementById('app').hidden);
if (await page.isVisible('#login-pw')) { await page.fill('#login-pw', password); await page.click('#login-form button'); }
await page.waitForSelector('#app:not([hidden])');

const row = (title) => page.locator('.session-row').filter({ hasText: title });
const waitRow = (title, present = true) => page.waitForFunction(([t, p]) =>
  [...document.querySelectorAll('.session-row')].some((r) => r.textContent.includes(t)) === p, [title, present], { timeout: 20000 });
const pickEffort = async (name) => {
  await page.click('#st-effort');
  await page.waitForSelector('#drawer-body .session-item');
  await page.locator('#drawer-body .session-item').filter({ has: page.locator('.si-title', { hasText: new RegExp(`^${name}$`) }) }).click();
};

// ---------------------------------------------------------------- Hermes
await app(() => window.stellwerk.switchBackend('hermes'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
await app(async () => { const b = window.stellwerk.backend; await b.newSession('/tmp'); await b.rename('e2e delete me A'); });
await app(async () => { const b = window.stellwerk.backend; await b.newSession('/tmp'); await b.rename('e2e delete me B'); window.stellwerk.refreshSessions(); });
await waitRow('e2e delete me A');
await waitRow('e2e delete me B');
const bId = await app(() => window.stellwerk.backend.sid);
ok(true, 'Hermes: two throwaway sessions in the sidebar');

// effort on the open session (B)
ok((await page.innerText('#st-effort')).includes('effort'), `Hermes: status line shows the effort (${await page.innerText('#st-effort')})`);
await pickEffort('high');
await page.waitForFunction(() => document.getElementById('st-effort').textContent.includes('high'), null, { timeout: 15000 })
  .then(() => ok(true, 'Hermes: effort set to high')).catch(() => fail('Hermes: effort did not change'));
ok(await app(() => window.stellwerk.backend.info.reasoning_effort) === 'high', 'Hermes: the session reports high');
await page.screenshot({ path: `${out}/hermes-effort.png` });
await pickEffort('default');
await page.waitForFunction(() => !document.getElementById('st-effort').textContent.includes('high'), null, { timeout: 15000 })
  .then(async () => ok(true, `Hermes: back to the default (${await page.innerText('#st-effort')})`)).catch(() => fail('Hermes: default did not stick'));

// delete A (not open), then B (open)
await row('e2e delete me A').hover();
await page.screenshot({ path: `${out}/hermes-delete-hover.png` });
await row('e2e delete me A').locator('.si-del').click();
await waitRow('e2e delete me A', false).then(() => ok(true, 'Hermes: a session that is not open is deleted')).catch(() => fail('Hermes: A is still listed'));
await row('e2e delete me B').hover();
await row('e2e delete me B').locator('.si-del').click();
await waitRow('e2e delete me B', false).then(() => ok(true, 'Hermes: the open session is deleted')).catch(() => fail('Hermes: B is still listed'));
const sidAfter = await app(() => window.stellwerk.backend.sid);
ok(sidAfter === null, `Hermes: and the view is cleared (sid ${sidAfter}, B was ${bId})`);
const leftovers = await app(async () => (await window.stellwerk.backend.rpc.request('session.list', { scope: 'stored', query: 'e2e delete me', limit: 20 })).sessions.length);
ok(leftovers === 0, `Hermes: nothing left in the store (${leftovers})`);

// ---------------------------------------------------------------- Pi
await app(() => window.stellwerk.switchBackend('pi'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
await waitRow('e2e delete me (pi)');
await row('e2e delete me (pi)').locator('.session-item').click();
await page.waitForFunction(() => window.stellwerk.backend.handle, null, { timeout: 30000 });
const before = await page.innerText('#st-effort');
await page.click('#st-effort');
await page.waitForSelector('#drawer-body .session-item, #drawer-body .dr-empty:not(:has-text("Loading"))');
const levels = await page.locator('#drawer-body .session-item .si-title').allInnerTexts();
ok(levels.length > 0, `Pi: thinking levels offered (${levels.join(', ')}; status "${before}")`);
if (levels.length > 1) {
  const target = levels.find((l) => !before.includes(l)) || levels[0];
  await page.locator('#drawer-body .session-item').filter({ has: page.locator('.si-title', { hasText: new RegExp(`^${target}$`) }) }).click();
  await page.waitForFunction((t) => document.getElementById('st-effort').textContent.includes(t), target, { timeout: 15000 })
    .then(() => ok(true, `Pi: thinking level set to ${target}`)).catch(() => fail('Pi: level did not change'));
} else await page.click('#drawer-close');
await row('e2e delete me (pi)').locator('.si-del').click();
await waitRow('e2e delete me (pi)', false).then(() => ok(true, 'Pi: the session is deleted')).catch(() => fail('Pi: still listed'));
ok((await page.innerText('.toast')).includes('trash'), `Pi: toast says where it went (${await page.innerText('.toast')})`);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
