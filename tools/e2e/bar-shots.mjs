// Phone screenshots of the status bar, the model sheet and the usage drawer, for review.
// Uses the connected agent's model list (read-only) and whatever usage store the server reads.
// usage: node tools/e2e/bar-shots.mjs <url> <outdir>
import { chromium, devices } from 'playwright';
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(() => window.stellwerk.switchBackend('hermes'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
await page.evaluate(() => {
  const v = window.stellwerk.view;
  v.clear();
  v.addUser({ text: 'Add a --json flag to the export command' });
  v.assistant('Done — `export --json` now prints the rows as a JSON array.');
  v.setStatus({ model: 'qwen', effort: 'effort low', context: { used: 18400, max: 262144 }, cost: '$0.0412', tps: { v: 48.6, exact: true } });
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/bar-idle.png` });
await page.evaluate(() => window.stellwerk.view.setBusy(true, 'Preparing write_file…'));
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/bar-busy.png` });
await page.evaluate(() => window.stellwerk.view.setBusy(false));
await page.click('#st-model');
await page.waitForSelector('#drawer-body .session-item', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/model-sheet.png` });
await page.click('#drawer-close');
await page.click('#st-cost');
await page.waitForSelector('.usage-grid', { timeout: 15000 });
await page.evaluate(() => document.querySelector('.usage-models')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/usage.png` });
console.log('errors:', errors.join(' | ') || 'none');
await browser.close();
