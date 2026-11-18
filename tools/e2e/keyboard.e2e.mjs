// Keyboard and screen-reader behaviour that axe can't judge. Uses a staged transcript;
// the slash popup asks the connected agent for completions (read-only).
// usage: node tools/e2e/keyboard.e2e.mjs <url>
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
const active = () => page.evaluate(() => { const a = document.activeElement; return a?.id || a?.className || a?.tagName; });

await page.goto(process.argv[2]);
await page.waitForSelector('#app:not([hidden])');
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 }).catch(() => {});

// skip link
ok(await page.evaluate(() => [...document.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')].find((e) => e.tabIndex >= 0 && e.offsetParent !== null || e.classList.contains('skip-link'))?.className) === 'skip-link', 'the skip link is first in tab order');
await page.focus('.skip-link');
ok(await page.evaluate(() => document.querySelector('.skip-link').getBoundingClientRect().top >= 0), 'skip link becomes visible when focused');
await page.keyboard.press('Enter');
ok(await active() === 'input', 'it jumps to the message box');

// tool row
await page.evaluate(() => {
  const v = window.stellwerk.view;
  v.toolStart('t1', { name: 'terminal', args: { command: 'ls' } });
  v.toolComplete('t1', { name: 'terminal', output: 'a\nb\nc\n' });
});
await page.focus('.tool-head');
await page.keyboard.press('Enter');
ok(await page.getAttribute('.tool-head', 'aria-expanded') === 'true', 'Enter expands a tool call');
ok(await page.locator('.tool-out').count() === 1, 'and shows its output');
await page.keyboard.press(' ');
ok(await page.getAttribute('.tool-head', 'aria-expanded') === 'false', 'Space collapses it again');

// settings drawer focus in / out
await page.focus('#btn-settings');
await page.keyboard.press('Enter');
await page.waitForSelector('.settings');
ok(await active() === 'drawer-title', 'opening Settings moves focus into it');
ok(await page.getAttribute('#drawer', 'aria-labelledby') === 'drawer-title', 'the drawer is named by its title');
await page.keyboard.press('Escape');
ok(await page.isHidden('#drawer'), 'Esc closes it');
ok(await active() === 'btn-settings', 'focus returns to the Settings button');

// status line items are buttons
const stTags = await page.evaluate(() => ['st-model', 'st-effort', 'st-tps', 'st-cost'].map((id) => document.getElementById(id).tagName));
ok(stTags.every((t) => t === 'BUTTON'), `status line items are buttons (${stTags})`);
ok(await page.evaluate(() => document.getElementById('session-title').tagName === 'BUTTON' && document.querySelector('h1 #session-title') !== null), 'session title is a heading with a rename button');

// announcements
await page.evaluate(() => window.stellwerk.view.setBusy(true, 'Working…'));
await page.waitForTimeout(200);
ok(/is working/.test(await page.innerText('#announce')), `busy is announced (“${await page.innerText('#announce')}”)`);
const g1 = await page.innerText('.st-spin');
await page.waitForTimeout(500);
ok(g1 === await page.innerText('.st-spin'), 'with reduced motion the spinner stands still');
await page.evaluate(() => window.stellwerk.view.setBusy(false));
await page.waitForTimeout(200);
ok(/finished/.test(await page.innerText('#announce')), 'finishing is announced');
ok(await page.getAttribute('#transcript', 'aria-live') === null, 'the transcript is not a live region (no token-by-token reading)');

// slash popup semantics (needs a connected agent)
if (await page.evaluate(() => !!window.stellwerk.backend?.ready)) {
  await page.focus('#input');
  await page.keyboard.type('/');
  const shown = await page.waitForSelector('#popup:not([hidden]) [role=option]', { timeout: 8000 }).then(() => true).catch(() => false);
  if (shown) {
    const ad = await page.getAttribute('#input', 'aria-activedescendant');
    ok(ad === 'pop-0' && await page.getAttribute('#pop-0', 'aria-selected') === 'true', 'popup options are announced via aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    ok(await page.getAttribute('#input', 'aria-activedescendant') === 'pop-1', 'arrow keys move the active option');
    await page.keyboard.press('Escape');
    ok(await page.getAttribute('#input', 'aria-activedescendant') === null, 'Esc closes the popup');
  } else console.log('skip popup checks (no completions from the agent)');
} else console.log('skip popup checks (no agent connected)');

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
