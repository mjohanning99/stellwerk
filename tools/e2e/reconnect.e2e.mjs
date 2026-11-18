// Reconnecting after the phone slept: missed Hermes events are replayed (not dropped as
// duplicates), and a socket that died silently is detected and replaced. No agent prompts.
// usage: node tools/e2e/reconnect.e2e.mjs <url>
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));

await page.goto(process.argv[2]);
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(() => window.stellwerk.switchBackend('hermes'));
await page.waitForFunction(() => window.stellwerk.backend?.ready, null, { timeout: 30000 });

// 1. replay: we had seen up to seq 4; seq 5-7 (a whole reply) happened while asleep.
const replay = await page.evaluate(async () => {
  const b = window.stellwerk.backend, v = window.stellwerk.view;
  b.view.clear();
  b.sid = 'local-test'; b.s = { replayEpoch: 'E', lastSeq: 4, revision: 1, gen: 0 };
  const ev = (seq, type, payload) => ({ type, seq, replay_epoch: 'E', session_id: 'local-test', payload });
  const missed = [ev(5, 'message.start', {}), ev(6, 'message.delta', { text: 'Reply written while you were away.' }), ev(7, 'message.complete', { text: 'Reply written while you were away.' })];
  const real = b.rpc.request.bind(b.rpc);
  let sinceCalls = 0;
  b.rpc.request = async (method, params, opts) => {
    if (method === 'session.events.since') { sinceCalls++; return sinceCalls === 1 ? { events: missed } : { events: [] }; }
    if (method === 'session.resume') return { session_id: 'local-test', last_sequence: 7, replay_epoch: 'E', revision: 2, execution_generation: 0, info: { model: 'm' } };
    if (method === 'session.stats') return {};
    return real(method, params, opts);
  };
  await b._reattach();
  b.rpc.request = real;
  return { text: v.rowsEl.textContent, lastSeq: b.s.lastSeq, sinceCalls };
});
ok(replay.text.includes('Reply written while you were away.'), 'missed reply is shown after reconnecting');
ok(replay.lastSeq === 7, `sequence marker ends at the newest event (${replay.lastSeq})`);
ok(replay.sinceCalls === 2, 'it also catches up on the gap after re-subscribing');

// 2. liveness: a live socket answers the ping; a dead one gets replaced.
const alive = await page.evaluate(async () => {
  const r = window.stellwerk.backend.rpc;
  await r.checkAlive();
  return r.state;
});
ok(alive === 'open', 'a live connection survives the check');
const dead = await page.evaluate(async () => {
  const r = window.stellwerk.backend.rpc;
  const real = r.request.bind(r);
  r.request = (m, p, o) => (m === 'bridge.ping' ? new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { code: -32001 })), 50)) : real(m, p, o));
  // a timeout must come back as an RpcError with code -32001; reuse the module's class
  const { RpcError } = await import('/static/js/rpc.js');
  r.request = (m, p, o) => (m === 'bridge.ping' ? new Promise((_, rej) => setTimeout(() => rej(new RpcError(-32001, 'bridge.ping timed out')), 50)) : real(m, p, o));
  const states = [];
  r.addEventListener('state', (e) => states.push(e.detail.state));
  await r.checkAlive();
  r.request = real;
  await new Promise((res) => setTimeout(res, 2500));
  return { states, now: r.state };
});
ok(dead.states.includes('closed') && dead.states.includes('connecting'), `a silent dead socket is closed and reconnected (${dead.states.join(' → ')})`);
await page.waitForFunction(() => window.stellwerk.backend.rpc.state === 'open', null, { timeout: 20000 })
  .then(() => ok(true, 'and the new connection comes up')).catch(() => fail('no reconnect'));
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
