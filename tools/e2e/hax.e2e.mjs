// hax end to end, with hax's mock provider (no account, no model calls). Run the server with
// hax's folders isolated and a mock script, e.g.:
//   XDG_CONFIG_HOME=/tmp/hx/config XDG_STATE_HOME=/tmp/hx/state XDG_CACHE_HOME=/tmp/hx/cache \
//   HAX_PROVIDER=mock HAX_NO_SESSION=0 HAX_MOCK_SCRIPT=tools/e2e/hax-mock.txt \
//   STELLWERK_CONFIG=/tmp/hw STELLWERK_TRASH=/tmp/trash python -m server.app
//   node tools/e2e/hax.e2e.mjs <url> <path-to-hax> <working-folder> [outdir]
import { chromium } from 'playwright';
const [base, haxPath, cwd, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
const rowsText = () => page.innerText('#rows');
const idle = () => page.waitForFunction(() => !window.stellwerk.view.busy, null, { timeout: 30000 });

await page.goto(base);
await page.waitForSelector('#app:not([hidden])');
const set = await page.evaluate(async (cmd) => (await fetch('/api/settings/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'hax', command: cmd, enabled: true }) })).json(), haxPath);
ok(set.backends?.hax?.enabled, 'hax turned on with its path');
await page.reload();
await page.waitForSelector('#app:not([hidden])');
ok(await page.locator('.side-head .be-switch button').count() === 3, 'the switch now has three agents');
await page.locator('.side-head .be-switch button', { hasText: 'hax' }).click();
await page.waitForFunction(() => window.stellwerk.backend?.name === 'hax' && window.stellwerk.backend.ready, null, { timeout: 15000 });
await page.evaluate((c) => window.stellwerk.backend.newSession(c), cwd);

// a turn: reasoning, a bash tool call, a pause, then the answer
await page.fill('#input', 'look around');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('#rows .row-tool'), null, { timeout: 15000 });
ok(/Bash/.test(await page.innerText('#rows .row-tool')), 'the tool call shows up while hax works');
ok(await page.evaluate(() => window.stellwerk.view.busy), 'busy while the turn runs');
await idle();
const t1 = await rowsText();
ok(t1.includes('look around') && t1.includes('The folder has a script.txt file.'), 'question and answer are shown');
ok((t1.match(/look around/g) || []).length === 1, 'the prompt is not shown twice');
ok(/\$0\.00[0-9]/.test(await page.innerText('#st-cost')), `cost from the usage records (${await page.innerText('#st-cost')})`);
await page.waitForFunction(() => document.querySelectorAll('#session-list .session-row').length === 1, null, { timeout: 10000 })
  .then(() => ok(true, 'the session is in the sidebar')).catch(() => fail('no session in the sidebar'));

// second turn resumes the same session; a message sent mid-turn waits in the queue
await page.fill('#input', 'second question');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.stellwerk.view.busy);
await page.fill('#input', 'queued one');
await page.keyboard.press('Enter');
ok((await page.innerText('#queue')).includes('queued one'), 'a message sent mid-turn waits in the queue');
await page.waitForFunction(() => document.getElementById('rows').textContent.includes('queued one'), null, { timeout: 30000 })
  .then(() => ok(true, 'and is sent when the turn ends')).catch(() => fail('queued message never sent'));
await idle();
await page.evaluate(() => window.stellwerk.refreshSessions());
await page.waitForTimeout(500);
ok(await page.locator('#session-list .session-row').count() === 1, 'all turns went into one session (resumed, not new)');

// reload: history comes back from the session file
await page.reload();
await page.waitForSelector('#app:not([hidden])');
await page.waitForFunction(() => window.stellwerk.backend?.name === 'hax' && document.getElementById('rows').textContent.includes('queued one'), null, { timeout: 15000 })
  .then(() => ok(true, 'after a reload the whole conversation is back')).catch(() => fail('history missing after reload'));
ok(await page.locator('#rows .row-tool').count() === 3, `each turn's tool call is in the history (${await page.locator('#rows .row-tool').count()})`);

// effort for the next turns, then interrupt one
await page.evaluate(() => window.stellwerk.backend.setEffort('high'));
ok((await page.innerText('#st-model')).includes('high'), `the model key shows the effort (${await page.innerText('#st-model')})`);
await page.fill('#input', 'this one gets interrupted');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelectorAll('#rows .row-tool').length === 4, null, { timeout: 15000 });
await page.keyboard.press('Escape');
await idle();
ok((await rowsText()).includes('Interrupted'), 'Esc interrupts the turn');

// usage, then delete
await page.click('#st-cost');
await page.waitForSelector('.usage-grid');
ok((await page.innerText('#drawer-title')) === 'hax usage', 'usage drawer for hax');
ok((await page.innerText('.usage-models')).includes('mock/mock-model'), 'per-model usage from the session file');
if (out) await page.screenshot({ path: `${out}/hax.png` });
await page.click('#drawer-close');
await page.hover('#session-list .session-row');
await page.click('#session-list .session-row .si-del');
await page.waitForFunction(() => !document.querySelector('#session-list .session-row'), null, { timeout: 10000 })
  .then(() => ok(true, 'deleting moves the session out of the list')).catch(() => fail('session still listed'));
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
