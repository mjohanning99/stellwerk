// Browser settings saved before the rename ("hw." keys) carry over to "sw." keys on first load.
// usage: node tools/e2e/migrate.e2e.mjs <url> [outdir]
import { chromium } from 'playwright';
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    localStorage.clear();
    localStorage.setItem('hw.look', '"nachtzug"');
    localStorage.setItem('hw.theme', '"dark"');
    sessionStorage.setItem('seeded', '1');
  }
});
const page = await ctx.newPage();
await page.goto(base);
await page.waitForSelector('#app:not([hidden])');
const r = await page.evaluate(() => ({ look: document.documentElement.dataset.look, theme: document.documentElement.dataset.theme,
  swLook: localStorage.getItem('sw.look'), title: document.title }));
ok(r.look === 'nachtzug' && r.theme === 'dark', `old look and mode applied before first paint (${r.look}, ${r.theme})`);
ok(r.swLook === '"nachtzug"', 'copied to the new key');
ok(/Stellwerk/.test(r.title), `page title (${r.title})`);
if (out) {
  const lp = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await lp.goto(base);
  await lp.evaluate(() => window.stellwerk.showLogin({ password_set: true }));
  await lp.screenshot({ path: `${out}/login.png` });
}
await browser.close();
