// Usage drawer and tokens/s, against the fake stores from make_fixtures.py (no agent calls).
// usage: node tools/e2e/usage.e2e.mjs <url> [outdir]
import { chromium } from 'playwright';
const [base, out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
await page.goto(base);
await page.waitForSelector('#app:not([hidden])');

const api = await page.evaluate(async () => ({
  h: await fetch('/api/usage/hermes').then((r) => r.json()), p: await fetch('/api/usage/pi').then((r) => r.json()),
  bad: (await fetch('/api/usage/nope')).status,
}));
const ha = api.h.periods.all.total, hw = api.h.periods.week.total, hm = api.h.periods.month.total;
ok(ha.input === 1700 && ha.output === 600 && ha.cache_read === 5000 && ha.reasoning === 70 && ha.calls === 6, `Hermes all-time totals (${JSON.stringify(ha)})`);
ok(Math.abs(ha.cost - 0.75) < 1e-9, `Hermes cost prefers actual over estimated (${ha.cost})`);
ok(hw.input === 1000 && hm.input === 1400, `Hermes periods by last use (week ${hw.input}, month ${hm.input})`);
ok(api.h.periods.all.models[0].model === 'anthropic/claude', 'Hermes per-model, costliest first');
const pa = api.p.periods.all.total;
ok(pa.calls === 60 && pa.input === 6000 && pa.cache_read === 60000 && Math.abs(pa.cost - 0.6) < 1e-9, `Pi all-time totals (${JSON.stringify(pa)})`);
ok(api.p.periods.all.models.map((m) => m.model).sort().join() === 'local/gemma,local/qwen', 'Pi per-model');
ok(api.p.periods.today.total.calls >= 1 && api.p.periods.today.total.calls < 60, `Pi "today" is a subset (${api.p.periods.today.total.calls})`);
ok(api.bad === 404, 'unknown backend: 404');

// tokens/s readout
await page.evaluate(async () => {
  const v = window.stellwerk.view;
  for (let i = 0; i < 12; i++) { v.delta('word '.repeat(20)); await new Promise((r) => setTimeout(r, 100)); }
});
const est = await page.innerText('#st-tps');
ok(/^≈[\d.]+ tok\/s$/.test(est), `estimate while streaming (${est})`);
await page.evaluate(() => window.stellwerk.view.setStatus({ tps: { v: 42.25, exact: true } }));
ok(await page.innerText('#st-tps') === '42.3 tok/s', 'exact figure replaces the estimate');

// drawer
await page.evaluate(() => window.stellwerk.switchBackend('pi'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
await page.click('#st-tps');
await page.waitForSelector('.usage-grid');
ok((await page.innerText('#drawer-title')) === 'Pi usage', 'clicking the readout opens the usage drawer');
ok((await page.innerText('.dr-section:last-child .usage-grid')).includes('60,000'), 'All-time cache reads shown');
await page.locator('.dr-section:last-child .seg button', { hasText: 'Today' }).click();
await page.waitForFunction(() => document.querySelector('.dr-section:last-child .seg button.on')?.textContent === 'Today');
ok(true, 'period switch works');
await page.screenshot({ path: `${out}/usage.png` });
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
