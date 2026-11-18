// End-to-end smoke test of the Pi UI (spawns a real `pi --mode rpc` via the bridge).
// usage: node pi.e2e.mjs <base_url> <password> <cwd> <outdir>
import { chromium } from 'playwright';

const [base, password, cwd, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const step = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
let sessionFile = null;

try {
  await page.goto(base);
  await page.evaluate(() => { localStorage.setItem('sw.backend', '"pi"'); localStorage.removeItem('sw.last.pi'); });
  await page.fill('#login-pw', password);
  await page.click('#login-form button');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => window.stellwerk?.backend?.name === 'pi' && window.stellwerk.backend.ready, null, { timeout: 20000 });
  step('pi backend connected');

  await page.evaluate((c) => window.stellwerk.startNew(c), cwd);
  await page.waitForFunction(() => !!window.stellwerk.backend.handle, null, { timeout: 60000 });
  step('pi started: ' + (await page.textContent('#st-model')));

  await page.fill('#input', '/');
  await page.waitForSelector('#popup:not([hidden]) .pop-item', { timeout: 10000 });
  step('slash popup: ' + (await page.$$eval('#popup .pop-item .pi-name', (e) => e.map((x) => x.textContent).slice(0, 14).join(' '))));
  await page.keyboard.press('Escape');
  await page.fill('#input', 'look at @hel');
  await page.waitForSelector('#popup:not([hidden]) .pop-item', { timeout: 10000 });
  step('@ popup: ' + (await page.$$eval('#popup .pop-item .pi-name', (e) => e.map((x) => x.textContent).join(' '))));
  await page.keyboard.press('Escape');

  await page.fill('#input', 'In hello.txt, use your edit tool to change "hello world" to "hello there". Then reply with just: done');
  await page.keyboard.press('Enter');
  step('prompt sent');
  await page.waitForSelector('.row-tool .diff', { timeout: 240000 });
  step('edit tool with diff: ' + (await page.textContent('.row-tool .tool-head')));
  await page.waitForFunction(() => !window.stellwerk.view.busy, null, { timeout: 240000 });
  step('settled. users=' + (await page.$$('.row-user')).length + ' tools=' + (await page.$$('.row-tool')).length + ' assistant=' + (await page.$$eval('.row-assistant .md', (e) => e.map((x) => x.textContent.trim()).join(' | '))));
  step('status: ' + (await page.$eval('.statusline', (e) => e.innerText.replace(/\s+/g, ' '))));
  sessionFile = await page.evaluate(() => window.stellwerk.backend.sid);
  step('session file: ' + sessionFile);
  await page.screenshot({ path: `${out}/pi-desktop.png` });

  await page.reload();
  await page.waitForSelector('.row-tool .diff', { timeout: 60000 });
  step('after reload: users=' + (await page.$$('.row-user')).length + ' tools=' + (await page.$$('.row-tool')).length + ' sidebar=' + (await page.$$eval('.session-item .si-title', (e) => e.map((x) => x.textContent).slice(0, 3).join(' | '))));

  await page.click('#btn-changes');
  await page.waitForSelector('#drawer-body .diff, #drawer-body .dr-empty', { timeout: 15000 });
  step('changes drawer: ' + (await page.textContent('#drawer-body')).replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: `${out}/pi-changes.png` });
  await page.click('#drawer-close');

  await page.click('#st-model');
  await page.waitForSelector('#drawer-body .session-item', { timeout: 30000 });
  step('models: ' + (await page.$$eval('#drawer-body .session-item .si-title', (e) => e.map((x) => x.textContent).join(', '))));
  await page.click('#drawer-close');
} catch (e) {
  step('FAILED: ' + e.message);
  await page.screenshot({ path: `${out}/pi-fail.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log('SESSION_FILE=' + sessionFile);
  console.log('console errors/warnings:\n  ' + (errors.join('\n  ') || '(none)'));
  await browser.close();
}
