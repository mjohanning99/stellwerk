// Phone layout: no sidebar shadow while it's closed, no sideways scrolling with a long
// status line, and the completion popup isn't clipped. No agent calls.
// usage: node tools/e2e/phone.e2e.mjs <url> [outdir]
import { chromium, devices } from 'playwright';
const [base, out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
await page.goto(base);
await page.waitForSelector('#app:not([hidden])');
const shadowClosed = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).boxShadow);
ok(shadowClosed === 'none', `closed sidebar casts no shadow (${shadowClosed})`);
ok(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).visibility) === 'hidden', 'closed sidebar is hidden (also from screen readers and Tab)');
await page.evaluate(() => {
  const v = window.stellwerk.view;
  v.setStatus({ model: 'a-very-long-provider-name/an-extremely-long-model-name-that-goes-on', effort: 'effort high', cost: '$1.234' });
  v.setBusy(true, '( •_•)>⌐■-■ analyzing a lot of things at once…');
});
const lefts = [];
for (let i = 0; i < 10; i++) { await page.waitForTimeout(150); lefts.push(await page.evaluate(() => Math.round(document.querySelector('#st-busy > span:last-child').getBoundingClientRect().left * 10) / 10)); }
ok(new Set(lefts).size === 1, `busy text stays put while the spinner turns (${[...new Set(lefts)]})`);
const scroll = await page.evaluate(() => { window.scrollTo(0, 500); return { y: window.scrollY, docH: document.documentElement.scrollHeight, h: window.innerHeight, appH: document.getElementById('app').getBoundingClientRect().height, vv: Math.round(visualViewport.height) }; });
ok(scroll.y === 0 && scroll.docH <= scroll.h, `the page itself can't scroll (${JSON.stringify(scroll)})`);
ok(Math.abs(scroll.appH - scroll.vv) <= 1, 'app fills exactly the visible viewport');
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, main: document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth }));
ok(overflow.doc <= 0, `page doesn't scroll sideways (${JSON.stringify(overflow)})`);
await page.screenshot({ path: `${out}/phone-closed.png` });
await page.click('#menu');
await page.waitForTimeout(300);
ok(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).boxShadow) !== 'none', 'open sidebar has its shadow');
await page.screenshot({ path: `${out}/phone-open.png` });
await page.click('#scrim', { position: { x: 360, y: 400 } });
await page.waitForTimeout(300);
// popup above the composer stays fully visible
await page.evaluate(() => { const v = window.stellwerk.view; v.setBusy(false); });
await page.evaluate(() => { const p = document.getElementById('popup'); p.hidden = false; p.innerHTML = '<div class="pop-item"><span class="pi-name">/compact</span></div>'.repeat(6); });
const clipped = await page.evaluate(() => { const p = document.getElementById('popup').getBoundingClientRect(); const el = document.elementFromPoint(p.left + 20, p.top + 8); return !document.getElementById('popup').contains(el); });
ok(!clipped, 'completion popup is not clipped');
await browser.close();
