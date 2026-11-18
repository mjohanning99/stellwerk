// Where does the time go? Times the sidebar listing and opening the longest Hermes session,
// split into gateway time (RPC) and rendering time (DOM). Read-only: it lists and resumes
// sessions, never prompts.  usage: node perf.mjs <url> [password]
import { chromium } from 'playwright';

const [base, password = ''] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
await page.goto(base);
await page.waitForFunction(() => !document.getElementById('login').hidden || !document.getElementById('app').hidden);
if (await page.isVisible('#login-pw')) { await page.fill('#login-pw', password); await page.click('#login-form button'); }
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(() => window.stellwerk.switchBackend('hermes'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });

const r = await page.evaluate(async () => {
  const app = window.stellwerk, b = app.backend, out = {};
  const t = async (label, fn) => { const t0 = performance.now(); const v = await fn(); out[label] = Math.round(performance.now() - t0); return v; };
  const stored = await t('rpc session.list stored 100', () => b.rpc.request('session.list', { scope: 'stored', picker: true, limit: 100 }));
  await t('rpc session.list stored 30', () => b.rpc.request('session.list', { scope: 'stored', picker: true, limit: 30 }));
  await t('rpc session.list live', () => b.rpc.request('session.list', { scope: 'live', picker: true }));
  await t('listSessions + sidebar render', () => app.refreshSessions());
  out.sessions = stored.sessions.length;
  const big = [...stored.sessions].sort((a, b2) => (b2.message_count || 0) - (a.message_count || 0))[0];
  out.biggest_msgs = big.message_count;
  const snap = await t('rpc session.resume (biggest)', () => b.rpc.request('session.resume', { session_id: big.session_id, display_projection: true }, { timeout: 60000 }));
  out.snapshot_kb = Math.round(JSON.stringify(snap).length / 1024);
  out.rows = (snap.display_messages || snap.messages || []).length;
  await t('render history (DOM)', async () => { app.view.clear(); b._renderHistory(snap.display_messages || snap.messages || [], snap.messages || []); });
  await t('full openSession (biggest)', () => b.openSession(big.session_id));
  out.dom_nodes = document.querySelectorAll('#rows *').length;
  // streaming cost: re-render a growing 40 kB markdown message 200 times like delta() does
  const { renderMarkdown } = await import('/static/js/render.js');
  const el = document.createElement('div');
  const chunk = 'Some **markdown** with `code` and a list:\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n';
  let text = '';
  await t('stream: 200 re-renders up to 40 kB', async () => { for (let i = 0; i < 200; i++) { text += chunk.repeat(2); renderMarkdown(el, text, { final: false }); } });
  out.stream_final_kb = Math.round(text.length / 1024);
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
