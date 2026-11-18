// End-to-end smoke test of the Hermes UI against the live gateway.
// usage: node hermes.e2e.mjs <base_url> <password> <cwd> <outdir>
import { chromium } from 'playwright';

const [base, password, cwd, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const step = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

try {
  await page.goto(base);
  await page.fill('#login-pw', password);
  await page.click('#login-form button');
  await page.waitForSelector('#app:not([hidden])');
  step('logged in');
  await page.evaluate(() => localStorage.setItem('sw.backend', '"hermes"'));
  await page.waitForSelector('#conn.ok', { timeout: 20000 });
  step('connected');
  await page.waitForFunction(() => window.stellwerk.backend.ready, null, { timeout: 20000 });
  step('handshake done');

  // slash completion
  await page.fill('#input', '/mo');
  await page.waitForSelector('#popup:not([hidden]) .pop-item', { timeout: 10000 });
  step('slash popup: ' + (await page.$$eval('#popup .pop-item .pi-name', (e) => e.map((x) => x.textContent).slice(0, 5).join(' '))));
  await page.keyboard.press('Escape');
  await page.fill('#input', '');

  await page.evaluate((c) => window.stellwerk.startNew(c), cwd);
  await page.waitForFunction(() => !!window.stellwerk.backend.sid, null, { timeout: 30000 });
  const sid = await page.evaluate(() => window.stellwerk.backend.sid);
  step('session created ' + sid.slice(0, 22));

  await page.fill('#input', 'Run the shell command `echo Stellwerk-ok` with your terminal tool, then reply with just the word: done');
  await page.keyboard.press('Enter');
  step('prompt sent');
  await page.waitForSelector('.row-tool', { timeout: 240000 });
  step('tool row: ' + (await page.textContent('.row-tool .tool-head')));
  await page.waitForFunction(() => !window.stellwerk.view.busy && document.querySelector('.row-assistant:not(.streaming)'), null, { timeout: 240000 });
  step('user rows live: ' + (await page.$$('.row-user')).length); step('assistant: ' + (await page.$$eval('.row-assistant .md', (e) => e.map((x) => x.textContent.trim()).join(' | '))));
  step('status: ' + (await page.textContent('.statusline')));
  await page.screenshot({ path: `${out}/hermes-desktop.png` });

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/hermes-mobile.png` });

  // reload and check history re-renders
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.reload();
  await page.waitForSelector('.row-user', { timeout: 30000 });
  await page.waitForSelector('.row-tool', { timeout: 10000 });
  step('history after reload: users=' + (await page.$$('.row-user')).length + ' tools=' + (await page.$$('.row-tool')).length + ' assistant=' + (await page.$$('.row-assistant')).length);
  await page.screenshot({ path: `${out}/hermes-reload.png` });

  // changes drawer
  await page.click('#btn-changes');
  await page.waitForFunction(() => !document.querySelector('#drawer-body').textContent.includes('Loading'), null, { timeout: 15000 });
  step('changes drawer: ' + (await page.textContent('#drawer-body')).slice(0, 120));
  await page.click('#drawer-close');

  // delete test session
  await page.evaluate(() => { window.confirm = () => true; });
  await page.fill('#input', '/delete');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 15000 });
  step('delete toast: ' + (await page.textContent('#toast')));
  const still = await page.evaluate(async (id) => {
    const r = await window.stellwerk.backend.rpc.request('session.list', { scope: 'stored', limit: 200, include_hidden: true });
    return r.sessions.some((x) => x.session_id === id);
  }, sid);
  if (still) throw new Error('session still stored after /delete');
  step('session gone from the store');
} catch (e) {
  step('FAILED: ' + e.message);
  await page.screenshot({ path: `${out}/hermes-fail.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log('console errors/warnings:\n  ' + (errors.join('\n  ') || '(none)'));
  await browser.close();
}
