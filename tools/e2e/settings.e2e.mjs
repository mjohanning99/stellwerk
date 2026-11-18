// Settings drawer: agents on/off, password set/change/remove, sign-out of other browsers.
// It changes the server's settings, so point it at a scratch instance:
//   STELLWERK_CONFIG=/tmp/hw STELLWERK_PORT=8799 python -m server.app &
//   node tools/e2e/settings.e2e.mjs http://127.0.0.1:8799 <password-or-""> <outdir>
// It leaves both agents on and the password set to the one given (or none if "").
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base, password, out = 'shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TMP_PW = 'a-temporary-pass';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (cond, m) => (cond ? console.log('ok  ', m) : fail(m));

await page.goto(base);
await page.waitForFunction(() => !document.getElementById('login').hidden || !document.getElementById('app').hidden);
if (await page.isVisible('#login-pw')) {
  await page.fill('#login-pw', password);
  await page.click('#login-form button');
}
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(() => document.fonts.ready);

const settings = () => page.evaluate(() => fetch('/api/settings').then((r) => r.json()));
const openSettings = async () => {
  if (!(await page.isVisible('.settings'))) await page.click('#btn-settings');
  await page.waitForSelector('.settings');
};
const agentSeg = (name) => page.locator('.set-card').filter({ hasText: name }).locator('.seg button');
const settle = () => page.waitForTimeout(400);

// this test is about two agents; a third one (hax) may be on in this config
await page.evaluate(() => fetch('/api/settings/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'hax', enabled: false }) }));
await openSettings();
await page.screenshot({ path: `${out}/settings.png` });

// ---- agents
for (const [name, label] of [['hermes', 'Hermes'], ['pi', 'Pi']]) {
  await agentSeg(label).filter({ hasText: 'On' }).click(); await settle();
}
ok(await page.locator('.side-head .be-switch button').count() === 2, 'two agents on: the sidebar shows a switch');

await agentSeg('Pi').filter({ hasText: 'Off' }).click(); await settle();
ok((await settings()).backends.pi.enabled === false, 'Pi off is saved on the server');
ok(await page.locator('.side-head .brand').innerText().then((t) => t.includes('Hermes')), 'one agent on: the sidebar shows its name');
const piWs = await page.evaluate(() => new Promise((res) => {
  const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/pi');
  ws.onopen = () => { ws.close(); res('open'); }; ws.onerror = () => res('refused');
}));
ok(piWs === 'refused', 'the server refuses /ws/pi while Pi is off');

await agentSeg('Hermes').filter({ hasText: 'Off' }).click(); await settle();
await page.click('#drawer-close');
ok(await page.isVisible('#no-backend'), 'both off: the empty state points to Settings');
ok(!(await page.isVisible('.composer')), 'both off: no composer');
await page.screenshot({ path: `${out}/no-agents.png` });
await page.click('#no-backend-settings');
await page.waitForSelector('.settings');
await agentSeg('Hermes').filter({ hasText: 'On' }).click(); await settle();
await agentSeg('Pi').filter({ hasText: 'On' }).click(); await settle();
ok(await page.locator('.side-head .be-switch button').count() === 2, 'both back on');

// bad command path
await page.locator('.set-card').filter({ hasText: 'Pi' }).locator('summary').click();
await page.locator('.set-card').filter({ hasText: 'Pi' }).locator('input.field').fill('/nonexistent/pi');
await page.locator('.set-card').filter({ hasText: 'Pi' }).getByRole('button', { name: 'Save' }).click();
await page.waitForSelector('.toast.err:not([hidden])');
ok((await page.innerText('.toast')).includes('not an executable'), 'a bad command path is rejected');
ok((await settings()).backends.pi.command === '', 'and not saved');
await page.waitForTimeout(500);

// ---- password
await openSettings();
let st = await settings();
const pwForm = page.locator('.set-form');
if (st.password_set) {
  await pwForm.locator('input[autocomplete=current-password]').fill('definitely wrong');
  await pwForm.locator('input[autocomplete=new-password]').nth(0).fill(TMP_PW);
  await pwForm.locator('input[autocomplete=new-password]').nth(1).fill(TMP_PW);
  await pwForm.getByRole('button', { name: 'Change password' }).click();
  await page.waitForSelector('.set-err:not(:empty)');
  ok((await page.innerText('.set-err')).includes('wrong'), 'a wrong current password is refused');
  await pwForm.locator('input[autocomplete=current-password]').fill(password);
  await pwForm.getByRole('button', { name: 'Change password' }).click();
  await page.waitForSelector('.toast:has-text("Password changed")');
  await settle();
  ok((await page.evaluate(() => fetch('/api/me').then((r) => r.json()))).authed, 'changed: this browser stays signed in');
  // remove it
  await page.locator('.set-form input[autocomplete=current-password]').fill(TMP_PW);
  await page.locator('.set-form').getByRole('button', { name: 'Remove password' }).click();
  await page.waitForSelector('.set-state .lamp:not(.ok)');
}
st = await settings();
ok(!st.password_set, 'no password now');
ok(!(await page.isVisible('#logout')), 'no password: no Sign out button');
await page.screenshot({ path: `${out}/settings-open.png` });

// mismatch, then set
await page.locator('.set-form input[autocomplete=new-password]').nth(0).fill(TMP_PW);
await page.locator('.set-form input[autocomplete=new-password]').nth(1).fill(TMP_PW + 'x');
await page.locator('.set-form').getByRole('button', { name: 'Set password' }).click();
ok((await page.innerText('.set-err')).includes('differ'), 'mismatched passwords are caught');
const final = password || TMP_PW;
await page.locator('.set-form input[autocomplete=new-password]').nth(0).fill(final);
await page.locator('.set-form input[autocomplete=new-password]').nth(1).fill(final);
await page.locator('.set-form').getByRole('button', { name: 'Set password' }).click();
await page.waitForSelector('.set-state .lamp.ok');
ok(await page.isVisible('#logout'), 'password set: Sign out is back');

// another browser gets signed out by "Sign out other browsers"
const other = await browser.newContext();
const op = await other.newPage();
await op.goto(base);
await op.fill('#login-pw', final);
await op.click('#login-form button');
await op.waitForSelector('#app:not([hidden])');
await op.waitForFunction(() => window.stellwerk.backend?.rpc.state === 'open', null, { timeout: 20000 });
await page.getByRole('button', { name: 'Sign out other browsers' }).click();
await page.waitForSelector('.toast:not([hidden])');
ok(!(await op.evaluate(() => fetch('/api/me').then((r) => r.json()))).authed, 'the other browser is signed out');
ok((await page.evaluate(() => fetch('/api/me').then((r) => r.json()))).authed, 'this one is not');
await op.waitForSelector('#login:not([hidden])', { timeout: 15000 }).then(() => ok(true, 'the other browser falls back to the login page')).catch(() => fail('the other browser did not show the login page'));
await other.close();
await page.waitForFunction(() => window.stellwerk.backend?.rpc.state === 'open', null, { timeout: 15000 })
  .then(() => ok(true, 'this browser reconnects on its fresh cookie')).catch(() => fail('this browser did not reconnect'));
ok(await page.isVisible('#app'), 'and stays in the app');

// phone
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => document.getElementById('drawer-body').scrollTo(0, 0));
await page.screenshot({ path: `${out}/settings-phone.png` });

if (!password) {
  await page.locator('.set-form input[autocomplete=current-password]').fill(final);
  await page.locator('.set-form').getByRole('button', { name: 'Remove password' }).click();
  await page.waitForSelector('.set-state .lamp:not(.ok)');
}
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
