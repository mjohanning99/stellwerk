# Developing Stellwerk

Stellwerk is a small aiohttp server and a plain-JavaScript frontend. There's no build step: edit a file, reload the page.

## How it fits together

```
browser ──▶ Stellwerk (127.0.0.1:7777)
             ├─ /ws     ⇄ Hermes gateway (/api/ws, hermes-gateway-v1)
             │           one `hermes gateway attach` ticket per tab
             └─ /ws/pi  ⇄ `pi --mode rpc` children, one per session,
                          kept alive while tabs disconnect (30 min idle stop)
```

- **Hermes.** For each browser tab, the server runs `hermes gateway attach --json --start`. That prints the loopback WebSocket URL of the Hermes gateway and a single-use ticket. The server dials it and relays frames verbatim, so the browser never sees a ticket and the gateway stays on loopback.
- **Pi.** The server starts one `pi --mode rpc` child per session, in the session's working folder, and speaks Pi's JSON-lines RPC over its stdin and stdout. Children outlive browser tabs and stop after 30 minutes without a client.

## Layout

| Path | What |
|---|---|
| `server/app.py` | aiohttp app: auth (optional scrypt password, signed cookie), settings API, static files, Hermes WebSocket relay, `/api/{dirs,upload,gitdiff}`, CLI |
| `server/pi.py` | Pi process manager plus `/ws/pi`; session listing from `~/.pi/agent/sessions` |
| `web/index.html`, `web/style.css`, `web/themes.css` | The page and its styles |
| `web/js/app.js` | App shell: backend switching, composer, drawers, Settings |
| `web/js/ui.js` | Backend-agnostic view: rows, tools, diffs, prompt cards, status line |
| `web/js/hermes.js`, `web/js/pi.js` | Protocol adapters, one per agent |
| `web/js/render.js`, `web/js/rpc.js` | Markdown and diff rendering; a small JSON-RPC client |
| `web/vendor/` | Vendored marked, DOMPurify and highlight.js |
| `web/fonts/` | Bundled fonts (SIL Open Font License) |
| `tools/gen_themes.py` | Generates `web/themes.css` from the theme palettes |
| `tools/probe.py`, `tools/pi_probe.py` | Read-only probes that record what the live agents send |
| `tools/e2e/` | Playwright end-to-end tests |
| `contrib/stellwerk.service` | systemd user unit |
| `Dockerfile`, `compose.yaml` | Container setup (see [docker.md](docker.md)) |

## Protocol references

- [`PROTOCOL.md`](../PROTOCOL.md): the Hermes gateway WebSocket protocol (`hermes-gateway-v1`), as a browser client needs it.
- [`PI_PROTOCOL.md`](../PI_PROTOCOL.md): Pi's RPC mode, field by field.

Both were written against the live agents and their sources. When an agent changes its wire format, re-run the probe and update the reference:

```sh
<hermes-venv-python> tools/probe.py            # read-only; never starts a turn
python3 tools/pi_probe.py                      # read-only by default; see --help
```

## Running from a checkout

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
STELLWERK_CONFIG=/tmp/hw-dev STELLWERK_PORT=8799 .venv/bin/python -m server.app
```

A scratch `STELLWERK_CONFIG` keeps your real password and settings out of the way.

## Tests

The end-to-end tests drive a real browser against a running server and real agents.

```sh
cd tools/e2e && npm install && npx playwright install chromium && cd -

node tools/e2e/hermes.e2e.mjs <url> <password> <cwd> <outdir>     # talks to a real Hermes
node tools/e2e/pi.e2e.mjs <url> <password> <cwd> <outdir>         # talks to a real Pi
node tools/e2e/hax.e2e.mjs <url> <path-to-hax> <cwd> [outdir]       # hax with its mock provider
node tools/e2e/sessions.e2e.mjs <url> <password|""> <outdir>      # deleting sessions, reasoning effort
node tools/e2e/settings.e2e.mjs <url> <password|""> <outdir>      # changes settings: use a scratch STELLWERK_CONFIG
node tools/e2e/looks.mjs <url> <password> <outdir>                # screenshots of the themes, no agent calls
node tools/e2e/looks.mjs <url> "" <tmp> --readme docs/screenshots  # the README images (staged, never real sessions)
node tools/e2e/keyboard.e2e.mjs <url>                             # keyboard and screen-reader behaviour
node tools/e2e/a11y.mjs <url> node_modules/axe-core/axe.min.js     # axe-core WCAG audit in every look and mode
node tools/e2e/phone.e2e.mjs <url> [outdir]                       # phone layout
node tools/e2e/reconnect.e2e.mjs <url>                            # missed turns after sleep, dead sockets
node tools/e2e/perf-stream.mjs <url>                              # streaming render cost
node tools/e2e/perf-history.mjs <url> [rows]                      # opening a long session (synthetic rows)
```

Paging, search and usage run against fake stores, so nothing real is read or changed:

```sh
python3 tools/e2e/make_fixtures.py /tmp/fx      # 60 Pi sessions and a small Hermes state.db
PI_SESSIONS_DIR=/tmp/fx/pisess STELLWERK_HERMES_DB=/tmp/fx/state.db STELLWERK_CONFIG=/tmp/hw \
  STELLWERK_PORT=8799 .venv/bin/python -m server.app &
node tools/e2e/search.e2e.mjs http://127.0.0.1:8799
node tools/e2e/usage.e2e.mjs http://127.0.0.1:8799
```

`sessions.e2e.mjs` deletes sessions. Its header explains how to point the server at a scratch Pi sessions folder (`PI_SESSIONS_DIR`) and trash folder (`STELLWERK_TRASH`) first.

`hax.e2e.mjs` needs no account: its header shows how to run hax's mock provider with isolated folders. The Hermes and Pi tests send real prompts, so point them at a model you don't mind spending tokens on, and at a throwaway working folder.
