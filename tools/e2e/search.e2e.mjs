// Sidebar paging and conversation search, against fake stores (no agent calls, nothing real):
//   python3 make_fixtures.py /tmp/fx    (60 Pi sessions, a small Hermes state.db)
//   PI_SESSIONS_DIR=/tmp/fx/pisess STELLWERK_HERMES_DB=/tmp/fx/state.db STELLWERK_CONFIG=/tmp/hw python -m server.app
//   node tools/e2e/search.e2e.mjs <url> [outdir]
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
const rows = () => page.locator('#session-list .session-row').count();

await page.goto(process.argv[2]);
await page.waitForSelector('#app:not([hidden])');

// ---- Hermes search endpoint (fake state.db)
const hs = await page.evaluate(async () => {
  const get = (q) => fetch('/api/search/hermes?q=' + encodeURIComponent(q)).then((r) => r.json());
  return { wombat: await get('wombat'), login: await get('LOGIN'), pct: await get('100%_'), none: await get('zzzz') };
});
ok(hs.wombat.available, 'Hermes search: available');
ok(hs.wombat.sessions.map((s) => s.id).join() === 'local-a,local-b', `Hermes: content match, child mapped to its chain root, hidden excluded (${hs.wombat.sessions.map((s) => s.id)})`);
ok(/WOMBAT/.test(hs.wombat.sessions[0].snippet || ''), `Hermes: snippet from the message (${hs.wombat.sessions[0].snippet})`);
ok(hs.login.sessions.length === 1 && hs.login.sessions[0].title === 'Refactor the login form', 'Hermes: title match, case-insensitive');
ok(hs.pct.sessions.length === 1, 'Hermes: % and _ are matched literally');
ok(hs.none.sessions.length === 0, 'Hermes: no match, no results');

// ---- Pi paging + search in the sidebar
await page.evaluate(() => window.stellwerk.switchBackend('pi'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('#session-list .session-row').length > 0, null, { timeout: 15000 });
ok(await rows() === 40, `Pi: first page shows 40 of 60 (${await rows()})`);
await page.locator('#session-list .side-more').scrollIntoViewIfNeeded();
await page.waitForFunction(() => document.querySelectorAll('#session-list .session-row').length === 60, null, { timeout: 10000 })
  .then(() => ok(true, 'Pi: scrolling to the end loads the rest')).catch(async () => fail(`Pi: still ${await rows()} after scrolling`));
ok(!(await page.isVisible('#session-list .side-more')), 'Pi: no "Load more" once everything is loaded');
await page.evaluate(() => window.stellwerk.refreshSessions());
await page.waitForTimeout(300);
ok(await rows() === 60, `Pi: a refresh keeps the loaded pages (${await rows()})`);

await page.fill('#session-search', 'flux capacitor');
await page.waitForFunction(() => document.querySelector('#session-list .side-group')?.textContent.includes('1 result'), null, { timeout: 10000 })
  .then(() => ok(true, 'Pi: content search finds the one session')).catch(async () => fail(`Pi search: ${await page.innerText('#session-list')}`));
ok((await page.innerText('#session-list .si-snip')).includes('flux capacitor'), 'Pi: shows the snippet');
ok(await page.locator('#session-list mark').count() >= 1, 'Pi: the match is highlighted');
if (process.argv[3]) await page.screenshot({ path: `${process.argv[3]}/search.png` });
await page.fill('#session-search', 'Session 7');
await page.waitForFunction(() => /result/.test(document.querySelector('#session-list .side-group')?.textContent || ''), null, { timeout: 10000 });
ok((await page.innerText('#session-list .side-group')).toLowerCase().startsWith('1 result'), `Pi: title search (${await page.innerText('#session-list .side-group')})`);
await page.fill('#session-search', 'nothing like this');
await page.waitForFunction(() => /No conversations match/.test(document.getElementById('session-list').textContent), null, { timeout: 10000 })
  .then(() => ok(true, 'Pi: empty result says so')).catch(() => fail('Pi: no empty-result message'));
await page.fill('#session-search', '');
await page.waitForFunction(() => document.querySelectorAll('#session-list .session-row').length === 40, null, { timeout: 10000 })
  .then(() => ok(true, 'Pi: clearing the search goes back to the first page')).catch(async () => fail(`Pi: ${await rows()} rows after clearing`));

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
