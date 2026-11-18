# Hermes gateway WebSocket protocol (`hermes-gateway-v1`) — client reference

Scope: what a browser client needs to drive the profile's shared gateway owner over `/api/ws`,
relayed verbatim by a Python bridge. Written against Hermes `0.23.2` (`code_sha ae2a81cc…`).

Sources, in order of authority:

- `apps/shared/src/gateway-contract.openrpc.json` (generated from `tui_gateway/contracts/*.py`).
  `x-canonical-methods` = methods whose wire model is owner-specific; `methods` = the older
  catalog (still valid where the owner serves the same name); `x-notifications` = event payloads;
  `x-server-requests` = server→client requests.
- `gateway/session_controls.py` (`AuthorityConnection`): the code that actually answers on the
  ticketed socket. `tui_gateway/ws.py`: framing, heartbeat, ready frame.
- `apps/shared/src/{json-rpc-channel,gateway-canonical,node/gateway-client}.ts` and
  `apps/desktop/src/api/{client,canonical-protocol}.ts`: what the real clients do.

"(src)" marks shapes taken from the contract/source; "(live)" marks shapes captured from the
running gateway by `tools/probe.py` (outputs trimmed). Everything not marked live was not
exercised (the probe never mutates state).

---

## 1. Connection

### 1.1 Attach and dial

```
$ hermes gateway attach --json        # discover only; --start / --recover ensure an owner
```

(live, ticket redacted)

```json
{"state": "ready", "reason_code": null, "detail": null,
 "endpoint": {"api_origin": "http://127.0.0.1:37177", "authority_epoch": 2,
              "capabilities": ["durable-admission-v1", "event-replay-v1", "session-authority-v1"],
              "code_sha": "ae2a81cc…", "instance_id": "70cd6ff0…", "profile_id": "/home/me/.hermes",
              "runtime_protocol": 1, "supervisor": "systemd", "control_home": null},
 "client_code_sha": "ae2a81cc…",
 "url": "ws://127.0.0.1:37177/api/ws", "protocol": "hermes-gateway-v1",
 "protocols": ["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"], "ticket": "<ticket>",
 "start_context": {"windows_service_session": false}}
```

Rules (website/docs/developer-guide/gateway-internals.md:582-640, hermes_cli/web_server_boundary.py:156-171):

- Dial `url` with **both** entries of `protocols` as WebSocket subprotocols, from loopback, with
  **no `Origin` header**. Check the server selected `hermes-gateway-v1` (live: it does).
- The ticket is single-use, expires after **30 s**, bound to the profile + `instance_id`. Run
  `attach` again for **every** connection and every reconnect. Never log it.
- No `url`/`ticket` in the JSON ⇒ no owner; `message` holds the human verdict. Exit `7`
  `inaccessible/ticket_unavailable` ⇒ retry attach.
- `client_code_sha != endpoint.code_sha` ⇒ the gateway outlived `hermes update`.
- Bridge implication: the bridge (not the browser) runs `attach` and dials; the browser never sees
  the ticket. One browser socket ⇔ one gateway socket ⇔ one attach.

### 1.2 Framing

Plain JSON-RPC 2.0, one JSON object per WebSocket **text** message (ws.py:1-4; a trailing newline
is tolerated, blank frames are ignored). No envelope on the wire. Three frame kinds arrive:

| Kind | Shape |
|---|---|
| Response | `{"jsonrpc":"2.0","id":<your id>,"result":{…}}` or `…"error":{"code","message","data"?}` |
| Event (notification) | `{"jsonrpc":"2.0","method":"event","params":{"type":"<name>","session_id"?,"payload":{…}, …stamps}}` |
| Server→client request | `{"jsonrpc":"2.0","id":"srq-<12hex>","method":"sudo"|"secret"|…,"params":{"session_id",…}}` |

Distinguish: `method == "event"` ⇒ event; `method` present and string `id` ⇒ server request;
otherwise a response (json-rpc-channel.ts `isServerRequestFrame`, `handleFrame`).

Event `params` stamps on canonical session events (gateway/session_events.py:75-100,
gateway/session_authority.py:1184-1194):

```json
{"type": "message.delta", "session_id": "local-…", "payload": {"text": "Hel"},
 "replay_epoch": "9f…", "seq": 42,
 "authority_epoch": 2, "execution_generation": 7, "admission_id": "…"}
```

- `seq`: per-session monotonic, used for reconnect replay (`session.events.since`).
  `replay_epoch` scopes it (a new epoch ⇒ old watermarks are void). Session-less broadcasts
  (`sessions.changed`, `skin.changed`, …) carry no `session_id`/`seq`.
- `execution_generation` identifies the turn; you need the latest value for
  `session.interrupt` / `session.steer` / `approval.respond` / policy mutations.

**Canonical translation the shared TS client does** (apps/shared/src/gateway-canonical.ts) — none
of it is a wire envelope; replicate only what you need:

- `prompt.submit`/`session.steer`/`session.redirect`: renames `submission_id`→`input_id` (the owner
  accepts either; sending `submission_id` is fine).
- `session.resume`: strips `cols`/`omit_messages`, adds `display_projection: true` when rendering.
  Result: renderers read `display_messages` (as `messages`); raw stored rows (`content`, `row_id`)
  stay as `stored_messages` for rewind targeting.
- `session.create`: forces `source` and `request_id` (UUID), drops keys not in
  `runtime.describe.session_create.parameters`.
- Events: copies `params.authority_epoch`/`execution_generation` into the payload; projects
  `payload.pending` into `pending_submissions`.

### 1.3 Handshake order

1. Server sends `gateway.ready` **first**, unprompted (ws.py:659). (live, skin trimmed)
   ```json
   {"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{
     "skin":{"name":"daylight","colors":{"ui_accent":"#2563EB","…":"…"},"light_colors":{},"dark_colors":{},
             "branding":{"agent_name":"Hermes Agent","response_label":" ☤ Hermes ","prompt_symbol":"❯","…":"…"},
             "banner_logo":"","banner_hero":"","tool_prefix":"│","help_header":"[?] Available Commands","customCSS":""},
     "change_events":true,"heartbeat":true,"replay_epoch":"0a116051…","session_authority":true}}}
   ```
2. Client → `client.capabilities {"server_requests": true}` (json-rpc-channel.ts:548,565; sent by
   the shared channel on every `gateway.ready`). (live)
   ```json
   {"result":{"server_requests":["approval","clarify","display.install.sudo","preview.act","preview.read",
     "secret","setup_beat","sudo","terminal.read","theme.apply","theme.pick","tour","vault.code",
     "vault.save_login","vault.unlock_prompt","window.read"],
     "declines_not_shown":true,"canonical_clarify_batch":true}}
   ```
   `declines_not_shown: true` ⇒ you may answer a window-only request with error `4404`
   ("no window shows this session") instead of `-32601`.
3. Client → `runtime.describe {}` (gateway/session_controls.py:560). (live)
   ```json
   {"result":{"instance_id":"70cd6ff0…","profile_id":"/home/me/.hermes","authority_epoch":2,
     "capabilities":["durable-admission-v1","event-replay-v1","local-cli-create-v1","acp-editor-policy-v1",
       "acp-session-mcp-v1","clarify-batch-v1","plugin-rpc-v1","session-client-v1","session-transcript-v1",
       "session-list-picker-v1","session-list-cursor-v1"],
     "session_create":{"sources":["acp","cli","gui","oneshot","tool","tui"],
       "parameters":["accept_hooks","api_key","base_url","checkpoints","client","client_env","cwd",
         "cwd_explicit","editor","follow_profile_config","ignore_rules","ignore_user_config","max_turns",
         "model","pass_session_id","provider","reasoning","request_id","row_cwd","run_budget",
         "safe_mode","service_tier","skills","source","title","toolsets","verbose","yolo"]},
     "skin":{…same as ready…}}}
   ```
   The Ink/Node client treats a failed `runtime.describe` as a transport failure and redials.
4. Then `session.list` / `session.create` / `session.resume`.

### 1.4 Heartbeat

- `gateway.ping` is answered on the socket reader itself, even while handlers block (ws.py:709):
  request `{"jsonrpc":"2.0","id":"heartbeat-1","method":"gateway.ping","params":{}}` →
  (live) `{"jsonrpc":"2.0","result":{"ok":true},"id":"heartbeat-1"}`.
- Only start it when `gateway.ready.payload.heartbeat === true`. Shared client: every **15 s**,
  connection dead after **45 s** with no inbound frame (json-rpc-channel.ts:177-178; Ink/Desktop
  count any inbound frame as liveness). Server side closes a peer it cannot write to for 30 s
  (ws.py `_WS_SEND_DEADLINE_S`).
- `ping {}` (no `gateway.`) is a different, authority-level method: `{"pong": true}` (live).

### 1.5 Reconnect

- New attach + new socket each time (ticket single-use). Ink: backoff 1 s doubling to 30 s, no
  jitter; at most 3 `attach --recover` per 60 s (node/gateway-client.ts:36-40,118-119).
- On a socket drop the gateway **detaches** your sessions (turns keep running; approvals stay
  pending) (ws.py `_close_sessions_for_transport`).
- To resume a session you were viewing (gateway/session_controls.py:785-803, session_events.py:114):
  1. `session.events.since {session_id, last_sequence: <last seq you applied>, replay_epoch: <that session's epoch>}`
  2. If `snapshot_required` (or `truncated`) is true ⇒ discard and rebuild from step 3's snapshot.
     Else apply `events` (each already has `seq`, `replay_epoch`, `session_id`), skipping `seq <= last`.
  3. `session.resume {session_id, display_projection: true}`. Because step 1 recorded your cursor,
     the owner writes any frames published between 1 and 3 to your socket before subscribing it.
     Frames for that session that arrive during the resume can be dropped if
     `seq <= snapshot.last_sequence` (same `replay_epoch`) — the Ink client holds them and replays
     only `seq > last_sequence` (node/gateway-client.ts `holdAttach/settleAttach`).
  4. Re-render `open_requests` (server requests still waiting) and `prompts` (pending approvals /
     clarifies) from either reply.
- A `session.replay_gap` event (`{latest_seq, replay_epoch}`) means your event subscription
  overflowed: re-`session.resume` for a snapshot (gateway/session_events.py:90-96).

### 1.6 Errors

| code | meaning (gateway/session_controls.py:294-392) |
|---|---|
| `4001` | refusal; `message` = reason; `data: {reason, field?, detail?, fields?, revision?, execution_generation?}`. Unknown/missing key on a canonical method ⇒ `invalid_params` with `data.fields`. |
| `-32601` | method not served on this socket (`data.reason: "unknown_method"`) |
| `5001` | `storage_unavailable` |
| `-32603` | handler crash; `-32700` parse error (id `null`) |

(live) `config.get {"key":"model"}` → `{"error":{"code":4001,"message":"invalid_params","data":{"reason":"invalid_params"}}}`.
Common reasons: `permission_denied` (often: not subscribed to the session on this socket),
`not_found`, `revision_conflict`, `stale_generation`, `session_busy`, `execution_not_ready`,
`unsupported_control`, `unsupported_command`, `use_session_mutation_model`, `runtime_draining`.

**Method routing on this socket** (tui_gateway/ws.py:389-411, tui_gateway/ws_legacy_fallback.py):
the session authority answers first; on `-32601` a method falls back to the legacy `tui_gateway`
handler **unless** it starts with `session.`, `prompt.` or `message.` (exceptions:
`session.most_recent`, `session.active_list`, `session.events.stats`, `session.foreign.*`).
So e.g. `session.title`, `session.archive`, `session.delete`, `session.usage`, `session.close`,
`session.branch*`, `session.compress`, `session.undo` from the old catalog return **-32601** here —
use `session.mutate` instead. Authority handlers (complete list, gateway/session_controls.py:222-292):
`session.{create,resume,detach,list,info,mutate,interrupt,steer,redirect,events.since,stats,account_usage,
transcript,context_breakdown,history,save,export,prune,active_list,automation,control,control.read}`,
`prompt.{submit,receipt,cancel,resolve_unknown,steer_queued,replace_queued,background,btw}`,
`approval.{respond,pending,received}`, `clarify.{respond,lock}`, `runtime.describe`, `ping`,
`commands.catalog`, `complete.slash`, `complete.path`, `slash.exec`, `command.dispatch`,
`command.observe`, `plugins.list`, `config.get`, `config.set`, `model.options`, `image.attach_bytes`,
`file.attach`, `rollback.{list,diff,restore,session_diff}`, `subagent.{list,tail,steer,interrupt}`,
`process.{list,stop,kill}`, `tools.show`, `skills.reload`, `reload.mcp`, `reload.env`,
`delegation.pause`, `shell.exec`, `message.react`, `llm.oneshot`, `handoff.*`, `onboarding.{start,skip}`,
`setup.{status,runtime_check}`, plus `plugin.<id>.<name>` (capability `plugin-rpc-v1`).

**Concurrency:** the socket dispatches requests **serially in arrival order**, except
`session.context_breakdown`, `session.transcript`, `session.account_usage` (max 2 concurrent) and
server-request answers / `clarify.lock` (immediate) (ws.py:105,118-122,539-556). A slow
`slash.exec` therefore delays a following `session.interrupt` on the same socket.

---

## 2. Sessions

Session ids look like `local-<64hex>`; a unique `local-<16hex>` prefix also resolves.
You only receive a session's events, and may only `prompt.submit` / attach files to it, after
`session.create` or `session.resume` **on this socket** (`permission_denied` otherwise:
gateway/session_controls.py:866, session_images.py:12).

### 2.1 `session.list`

Params (all optional): `{scope: "live"|"stored" = "live", limit: 1..200 = 200, picker: bool,
workspace: str, query: str (stored only, 1-200 chars), cursor: str (stored only), include_hidden: bool,
title: str (exclusive with scope/workspace/picker), profile}`.

- `scope: "live"` = sessions currently mounted on the owner (no paging). `scope: "stored"` = the
  history picker (paged by `next_cursor`; a cursor is only valid with the same
  `workspace`/`query`/`include_hidden`). Rows can repeat across pages ⇒ key by `session_id`.
- `picker: true` adds `preview`, `last_reply`, `cwd`, `git_branch`, `workspace`, `last_active_at`, `pinned`.

(live) `{"picker":true,"limit":3}` → `{"sessions":[],"scope":"live"}`
(live) `{"scope":"stored","picker":true,"limit":2}` →

```json
{"sessions":[{"id":"local-62c7…","session_id":"local-62c7…","resolved_id":"local-62c7…","title":"",
   "source":"cli","started_at":1794953180.975393,"message_count":0,"model":"anthropic/claude-opus-4.6",
   "running":false,"preview":null,"cwd":"/home/me","workspace":"/home/me","git_branch":null,
   "last_active_at":1794953180.975393,"pinned":false,"last_reply":null}, {…}],
 "scope":"stored","next_cursor":"WyJsMSIsIDIsICI2NWVk…"}
```

Row type (src `CanonicalSessionListRow`): `session_id, id, title, source, started_at, message_count,
running, model?, resolved_id?, root_title?, preview?, last_reply?, cwd?, git_branch?, workspace?,
last_active_at?, pinned?`. Refresh the list on the `sessions.changed` broadcast (empty payload).

### 2.2 `session.create`

All params optional (closed set = `runtime.describe.session_create.parameters`, else `4001`):

```json
{"jsonrpc":"2.0","id":"r5","method":"session.create","params":{
  "source":"tui", "request_id":"7b0e…uuid", "cwd":"/home/me/Code/proj",
  "client":{"name":"Stellwerk","version":"0.1.0"}}}
```

- `source`: pick from `session_create.sources`. `tui` = terminal-client policy (adds `project`
  toolset); `gui` = Desktop policy (adds `desktop_ui`/`catalog` toolsets whose tools send
  window server requests — `preview.*`, `theme.*`, `window.read`, `terminal.read` — that a
  web UI would have to answer). Recommendation: `tui` (gateway/session_policy.py:86, 716-724).
- `request_id`: idempotency key. Retrying the **same** `request_id` with the same options after a
  lost reply returns the already-created session; same id + different options ⇒ `invalid_params`.
- `client`: attribution only (`name` `[a-z0-9][a-z0-9._-]{0,63}`).
- Other fields: `cwd` (existing absolute dir), `model`, `provider`, `base_url`, `api_key`,
  `toolsets` (array), `reasoning`, `max_turns`, `yolo`, `checkpoints` (enables rollback),
  `skills`, `title` (resolve-or-create), `hidden`, … — all frozen at creation.

Result = the same **snapshot** as `session.resume` (it literally calls resume:
gateway/session_controls.py:551). Creating subscribes this socket.

### 2.3 `session.resume`

Params: `{session_id, display_projection?: true, omit_messages?: bool, defer_history?: bool,
title?, latest?: "cli"|"tui", workspace?, source?, api_key?, editor?, profile?, cols?}`.
Use `{session_id, display_projection: true}`. `omit_messages: true` = metadata-only attach
(then page with `session.transcript`).

Result (src `CanonicalSnapshot`, gateway/session_controls.py:733-749):

```json
{"session_id":"local-…","stored_session_id":"local-…",
 "messages":[ /* stored rows: {role, content, tool_call_id?, timestamp?, row_id, display_kind?, …} */ ],
 "display_messages":[ /* render these: see 2.4 */ ],
 "message_count":12, "messages_omitted":null,
 "running":false, "authority_epoch":2, "replay_epoch":"9f…", "last_sequence":118,
 "subscription_id":"sub-…", "revision":31, "execution_generation":7,
 "pending":[{"admission_id":"…","ref":{"profile_id":"/home/me/.hermes","session_id":"local-…"},
             "sequence":3,"status":"queued","outcome":null,"authority_epoch":2,"execution_generation":null,
             "input_id":"<your submission_id>","text":"next question","controls":["steer","replace"],"steering":null}],
 "prompts":[{"kind":"approval","prompt_id":"…","execution_generation":7,"choices":["once","deny","session","always"],
             "command":"rm -rf build","description":"recursive delete","timeout_s":300}],
 "info":{ /* CanonicalSnapshotInfo: model, provider, cwd, title, usage, context_length, tools, skills,
           reasoning_effort, yolo, profile_name, version, desktop_protocol:"hermes-gateway-v1", … (see 2.6) */ },
 "pending_connection":null,
 "todo_state":{"todos":[…],"revision":4},
 "open_requests":[{"id":"srq-1a2b3c4d5e6f","method":"sudo","params":{"session_id":"local-…","command":"apt install …"}}]}
```

- There is **no `inflight` field** on the canonical owner. A running turn shows as
  `running: true`; its text so far is not in the snapshot — you get it from replay/events.
- `pending` = the durable prompt FIFO (`status` `queued`/`started`/`unknown`/`terminal`).
- `prompts` = pending approval / clarify cards (answer with `approval.respond` / `clarify.respond`).
- `open_requests` = server→client requests still waiting (answer by **responding to that `id`**
  as if the frame had just arrived).
- Keep `subscription_id` (for `session.detach`), `revision` (for `session.mutate`),
  `execution_generation` (for interrupt/steer), `replay_epoch` + `last_sequence` (for replay).

### 2.4 Transcript rows (`display_messages`, `session.transcript.rows`)

Row type (src `TranscriptMessage` / `StoredTranscriptRow`; built by
tui_gateway/session_history.py:297-374):

| role | fields |
|---|---|
| `user` | `text`, `timestamp?`, `row_id?`, `display_kind?` (`skill_invocation`, `steer`, …), `display_metadata?` |
| `assistant` | `text` (may be empty when only reasoning), `reasoning?` (also `reasoning_content`/`reasoning_details` may ride along), `timestamp?`, `row_id?`, `display_kind?` |
| `tool` | `name`, `context` (≤80-char preview), `args?` (full call args), `labels?`, `tool_call_id?`, `timestamp?`, `display_metadata?`; `content` (raw result) **only** for `write_file`, `patch`, `skill_manage`, `clarify` |
| `system` | `text`, `display_kind?` (`model_switch`, `personality_switch`, `auto_continue`, `async_delegation_complete`, …) |

`session.transcript` rows add `row_kind: "message"|"compaction"`; a compaction row is
`{role:"system", row_kind:"compaction", text:<summary>, compacted_messages, timestamp, row_id}`;
oversized rows carry `truncated: true`. `display_kind: "hidden"` rows are already filtered out.
`labels[]` = `{kind:"connector"|"mcp"|"tool", app, action, emoji, text, name, preview?}` — render
`text` instead of parsing bridged tool names.

### 2.5 `session.transcript` (read without attaching)

Params: `{session_id, limit?: 1..500 = 100, order?: "oldest"|"latest" = "oldest", cursor?, subagent_id?,
inline_images?: false, profile?}`. Result `{session_id, rows, next_cursor, reset, subagent_id?,
available?, running?, child_session_id?}`. Pages ≤2 MiB.

- `order: "latest"`: newest page first; follow `next_cursor` to older pages until `null`.
- `order: "oldest"`: `next_cursor` is never null — it doubles as a poll cursor; `reset: true` ⇒
  replace everything you hold (compaction/rewind happened).
- (live, an empty session) `{"session_id":"local-62c7…","rows":[],"next_cursor":null,"reset":true}`.

### 2.6 `session.info`, `session.stats`, `session.context_breakdown`, `session.account_usage`

All take `{session_id}`; none subscribes or starts an agent.

`session.info` (live, trimmed):

```json
{"tools":{"file":["patch","read_file","search_files","write_file"],"terminal":["terminal"],"…":["…"]},
 "skills":{"software-development":["github","…"]}, "mcp_servers":[],
 "version":"0.23.2","release_date":"2026.9.24","update_behind":0,"update_command":"hermes update",
 "branch":"","project":null,"provider":"auto","enabled_toolsets":["browser","clarify","…"],
 "tool_availability":{"unavailable_toolsets":[{"name":"image_gen","env_vars":[],"tools":["image_generate"]}],
                      "lazy_tools":["image_generate"],"disabled_tools":[]},
 "source":"cli","model":"anthropic/claude-opus-4.6","lazy":true,"profile_id":"/home/me/.hermes",
 "desktop_protocol":"hermes-gateway-v1","profile_name":"default","cwd":"/home/me",
 "reasoning_effort":"medium","reasoning_effort_wire":"medium","service_tier":"","fast":false,
 "launch_request":{"cwd":"/home/me","row_cwd":"/home/me","source":"cli"},"title":null,
 "started_at":1794953180.97,"last_active_at":1794953180.97,"yolo":false,"archived":false,
 "tool_count":19,"credential_hint":null,
 "usage":{"model":"anthropic/claude-opus-4.6","input":0,"output":0,"reasoning":0,"prompt":0,
          "completion":0,"total":0,"calls":0}}
```

`session.stats` (src `SessionStats`): `input_tokens, output_tokens, cache_read_tokens,
cache_write_tokens, prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, api_calls,
last_prompt_tokens, context_tokens, context_length?, config_context_length?, context_source?,
compression_count, avg_latency_s?, tokens_per_s?, last_turn_tokens, rate_limit?, active_subagents,
model, provider, fallback_model?, plan_gauge?{id,label,used_bp,resets_at_ms?}`.

`session.context_breakdown` (src): `{categories:[{id,label,color,tokens}], context_max,
context_percent, context_used, estimated_total, context_estimated, context_source, model,
context_files?:[{label,path,chars,est_tokens,loaded,status}], prompt_cache?}`.

`session.account_usage` (src): `{lines:[str], nous_lines?:[str], nous_route:bool, nous_usage?:{…}}`
(may wait on a provider API; runs on the concurrent lane).

`Usage` object (in `session.info.usage`, `message.complete.usage`, `session.usage.usage`):
`model, input, output, reasoning, prompt, completion, total, calls, compressions?, context_used?,
context_max?, context_percent?, context_source?, context_estimated?, cache_hit_pct?, cache_read?,
cache_write?, avg_latency_s?, avg_tps?, active_subagents?, cost_usd?, cost_status?, plan_gauge?`.
For a context meter use `context_used/context_max/context_percent`; absent figures are omitted,
not zero (gateway/session_usage.py:130-160).

### 2.7 `session.detach`

`{session_id, subscription_id, end_reason?}` → `{session_id, subscription_id, detached}`.
`end_reason` (snake_case, e.g. `"cli_close"`) means "closing the conversation": the last viewer
leaving an idle local session ends its row. Omit it to merely stop viewing. Socket close detaches
implicitly.

### 2.8 `session.interrupt`, `session.steer`, `session.redirect`

- `session.interrupt {session_id, execution_generation}` → `CanonicalSessionHandle`
  `{ref:{profile_id,session_id}, instance_id, authority_epoch, revision, execution_generation,
  execution_state:"idle"|"running"|"waiting"|"unknown"|"terminal"}`.
- `session.steer {session_id, execution_generation, text}` — inject text into the running turn
  (agent sees it at its next step). `session.redirect` same params — interrupt and continue with
  `text`. Result `{status:"queued"|"redirected"|"rejected", text, execution_generation,
  authority_epoch, delivered?: false}`. Refusals `execution_not_ready`, `stale_generation`,
  `unsupported_control` mean the text reached no agent ⇒ safe to send it as a normal
  `prompt.submit` instead (json-rpc-channel.ts `isUndeliveredCorrectionRefusal`).
- `execution_generation` must be current: take it from the snapshot, from `session.info` events,
  or from the event stamps.

### 2.9 `session.mutate` (rename / archive / delete / model / rewind / …)

```json
{"method":"session.mutate","params":{"session_id":"local-…","request_id":"<uuid, reuse on retry>",
  "expected_revision":31,"operation":"rename","payload":{"title":"Refactor auth"}}}
```

Result `{session_id, operation, revision?, …operation-specific}`. Refusal `revision_conflict`
carries `data.revision` (the current one) — retry with a **new** `request_id`. A retry of a lost
reply reuses the same `request_id`.

Payloads (hermes_state_mutations.py:8-56, gateway/session_mutations.py:18-23,153).

**`expected_generation` is required for `delete`, `rewind`, `reset`, `branch`, `model`, `compress`, `reasoning` and `workspace`** (gateway-contract.generated.ts, `session.mutate`); without it the owner answers a bare `invalid_params`. Verified live 18 November 2026: `delete` failed without it and succeeded with it.


| operation | payload | notes |
|---|---|---|
| `rename` | `{title: str}` | |
| `archive` | `{archived: bool}` | |
| `sidebar` | any of `{title, archived, hidden, pinned, unread}` (typed) | |
| `delete` | `{}` | |
| `rewind` | `{target_message_id: <row_id int>, preserve_compaction_handoff?: bool}` | edit/resend: drop that user row and everything after, then `prompt.submit` the new text (Desktop `splitRewindSubmit`, canonical-protocol.ts:159-180) |
| `reset` | `{}` | |
| `branch` | `{title?, through_message_id?: row_id}` | |
| `compress` | `{focus?: str, preview?: bool, partial?: bool, keep_last?: int}` | |
| `model` | `{model, provider?, reasoning?, confirm?}` | **needs `expected_generation`**; may answer `{status:"confirmation_required", confirm_required:true, confirm:"<token>", …}` ⇒ resend with `payload.confirm = token` |
| `reasoning` | `{effort: str|null}` | needs `expected_generation` |
| `workspace` | `{cwd: str}` | needs `expected_generation` |

Revision source: snapshot `revision`, the `revision` in `session.info` events (published on every
queue change: gateway/session_authority.py:468-485), and mutate results. Applied mutations also emit
a `session.updated` event (payload = the mutate result; not in the generated contract).

### 2.10 `session.events.since`

`{session_id, last_sequence?: int = 0 (alias last_seen), replay_epoch?: str}` →
`{events:[{type, session_id, payload, replay_epoch, seq, authority_epoch?, execution_generation?, admission_id?}],
latest_seq, last_sequence, epoch, replay_epoch, truncated, snapshot_required, count, open_requests?}`.
See 1.5 for use.

---

## 3. Prompting

### 3.1 `prompt.submit`

```json
{"jsonrpc":"2.0","id":"r9","method":"prompt.submit","params":{
  "session_id":"local-…","submission_id":"c1f2…uuid","text":"Fix the failing test",
  "attachments":[{"path":"/home/me/.hermes/cache/images/img_ab12.png","mime":"image/png"}],
  "clarify_batch":false}}
```

- **`submission_id` (or `input_id`) is required** — missing ⇒ `invalid_params`
  (gateway/session_controls.py:873-875). It is the idempotency key and comes back as
  `pending[].input_id` and `message.complete.persisted_turn.submission_id`.
- Allowed keys: `session_id, text, submission_id, input_id, queued, attachments, finite, unattended,
  surface, voice_context, interrupted, voice_turn, display_kind ("hidden"), title_preview,
  turn_author, api_text, model_override {model, provider?, reasoning?}, clarify_batch`.
  `queued` is accepted but not read by the owner (uncertain; session_controls.py:868-884).
- No truncation/rewind flags on the canonical submit: do `session.mutate rewind` first (2.9).
- Result = admission receipt, **not** completion:
  `{admission_id, ref:{profile_id,session_id}, sequence, status:"started"|"queued"|"unknown"|"terminal",
  outcome, authority_epoch, execution_generation}` (or `{voice_stopped:true}`). Completion is the
  `message.complete` event. The Desktop uses a 30-minute timeout for this reply.
- **Busy behaviour:** every submit goes into a durable per-session FIFO. Idle ⇒ starts
  (`status:"started"`); a turn running ⇒ `status:"queued"` and it runs after. The queue is
  broadcast as `session.info.payload.pending`.
- A turn that was running when the owner restarted becomes `status:"unknown"` and **pauses the
  queue** until `prompt.resolve_unknown {session_id, admission_id, execution_generation}`.

### 3.2 Queue controls

| method | params | result |
|---|---|---|
| `prompt.cancel` | `{session_id, admission_id}` | `AdmissionStatus` (a started one is interrupted) |
| `prompt.steer_queued` | `{session_id, admission_id}` | `AdmissionStatus`; queued text is handed to the running turn as a steer |
| `prompt.replace_queued` | `{session_id, admission_id, submission_id, text, attachments?, display_kind?, title_preview?}` | new `AdmissionStatus` at the back |
| `prompt.receipt` | `{session_id, admission_id, include_result?}` | `AdmissionStatus` + `result?`, `usage?` |

`pending[].controls` lists which of `steer`/`replace` the owner offers for that row.

### 3.3 Attachments

- Images: `image.attach_bytes {session_id, content_base64 (or data, may be a data: URL), filename?, ext?}`
  → `{attached, path, mime, name?, width?, height?, token_estimate?, bytes?, …}`. Staging only:
  put `{path, mime}` into the next `prompt.submit.attachments` (gateway/session_images.py;
  Desktop submit.ts:1080-1087). Max 25 MiB; png/jpeg/gif/webp.
- Other files: `file.attach {session_id, data_url, name}` (or `path` for a gateway-local file)
  → `{attached, name, path, ref_path, ref_text, uploaded}`; insert `ref_text` (an `@file:` ref) into
  the prompt text (gateway/session_ancillary.py:137-170).
- Both require this socket to be subscribed to the session.

---

## 4. Events to render

All are `{"jsonrpc":"2.0","method":"event","params":{"type":T,"session_id":…,"payload":{…},…stamps}}`.
`message.delta`, `reasoning.delta`, `thinking.delta` are coalesced server-side (~33 ms batches,
order preserved: ws.py:130).

Typical turn (canonical owner): `session.info` (pending/running) → `message.start` →
[`reasoning.delta`*] → `message.delta`* → `tool.generating` → `tool.start` → [`tool.progress`*] →
`tool.complete` → `message.interim`? → `message.delta`{text:null} (segment boundary) →
`message.delta`* → `session.usage`* → `message.complete` → `session.info` (running:false).

| type | payload (src) | render notes |
|---|---|---|
| `message.start` | `{display_kind?, display_text?, notification_category?, text?, turn_id?}` | turn began |
| `message.delta` | `{text: str|null, rendered?, verbose?, turn_id?, segment?, offset?}` | append; `text:null` = close current segment |
| `message.interim` | `{text, already_streamed: bool, turn_id?, segment?}` | commentary beside tool calls; if `already_streamed`, it was already painted by deltas |
| `message.complete` | see below | end of turn |
| `reasoning.delta` / `reasoning.available` | `{text, rendered?, verbose?}` | streamed / whole reasoning (only when the session shows reasoning: `config.set show_reasoning`) |
| `thinking.delta` | `{text}` | spinner text ("" clears) — not reasoning |
| `tool.generating` | `{name}` | model is emitting args |
| `tool.start` | `{tool_id, name, context, args, labels?}` (+ `tool_call_id`, `tool_name` duplicates) | `args` bounded to 64 KiB |
| `tool.progress` | `{tool_id, name, progress, total?, percent?, message?}` | MCP progress |
| `tool.complete` | `{tool_id, name, args, is_error, result, result_text?, duration_s?, inline_diff?, image_path?, todos?, revision?, labels?}` | see 4.1 |
| `tool.output_risk` | `{tool_id, name, risk, findings[], redacted}` | |
| `todo.updated` | `{todos[], revision}` | full snapshot |
| `status.update` | `{kind, text}` | transient status line (`compacting`, `goal`, `lifecycle`, …) |
| `agent.print` | `{text}` | status lines the agent printed |
| `notice` | `{message}` | |
| `notification.show` / `notification.clear` | `{text, level, kind, ttl_ms?, key?, id?, detail?}` / `{key}` | toast keyed by `key` |
| `session.usage` | `{usage: Usage, …flat SessionStats counters}` | mid-turn meter tick |
| `session.info` | live info and/or `{stored_session_id, pending[], running, execution_generation, revision, authority_epoch, desktop_protocol}` | **merge** into session state; source of `revision`/`execution_generation` |
| `session.title` | `{session_id, title}` | |
| `session.updated` | mutate result / deferred model pick (not in contract) | |
| `session.control.update` | `{control:{goal, loop, heartbeat, revision, updated_at}}` | |
| `session.reclaimed` | `{session_id, stored_session_id, reason}` | owner dropped the live session; re-resume |
| `session.replay_gap` | `{latest_seq, replay_epoch}` | re-resume |
| `approval.request` / `approval.settled` | see 5.1 | |
| `clarify.request` / `clarify.settled` | see 5.1 | |
| `approval.cancelled` | `{session_id, stored_session_id, reason, cancelled_count, request_ids[]}` | close those cards |
| `request.cancel` | `{id, method, reason: "timeout"|"interrupted"|"resolved"}` | close the server-request card with that `id` |
| `subagent.*` | see 9 | |
| `error` | `{message}` | session-level failure outside a turn |
| `review.summary`, `background.complete`, `btw.complete` | `{text}` / `{task_id, text, question?}` | side-agent results |
| `reaction` | `{kind}` | hearts etc. |
| `sessions.changed`, `skin.changed`, `cron.changed`, `projects.changed`, `skills.changed` | `{}` / skin | broadcasts, no `session_id` |
| `agent.step` | `{iteration}` | published by the owner (run_turn_progress.py:1092) but not in the contract; safe to ignore |

`message.complete` payload (gateway/session_settlement_recovery.py:54-110):

```json
{"text":"Done — the test passes now.","content":"…same…","admission_id":"…",
 "outcome":"completed","status":"complete",
 "usage":{"model":"…","input":5120,"output":312,"total":5432,"calls":3,"context_used":5120,"context_max":200000,"context_percent":3},
 "reasoning":"…last reasoning…","warning":"…","failure_reason":"…","billing":{…},
 "error_surface":{"layer":"provider","code":"rate_limited","retryable":true,"provider":"…","model":"…"},
 "response_previewed":true,"response_reused":true,"response_transformed":true,
 "persisted_turn":{"row_ids":[101,102,103],"complete":true,"user_row_id":101,"final_assistant_row_id":103,"submission_id":"c1f2…"}}
```

- `status`: `complete` | `interrupted` | `error` (the latter carries `error_surface`).
- **`text` can be `null`/empty when the reply was already streamed** ("delivered") — keep the
  text you accumulated from deltas unless `text` is non-empty (`response_transformed` = the
  stored reply differs from what streamed; prefer `text` then).
- A queued admission cancelled before it ran also gets a `message.complete`
  `{text:"", content:"", admission_id, outcome}` stamped with its own `admission_id`, not the
  running turn's (gateway/session_authority.py:855-866) — match by `admission_id`.
- `persisted_turn.row_ids` bind the streamed bubble to stored rows (needed for rewind).

### 4.1 Tool args, results and diffs

Built in gateway/run_turn_progress.py:97-123 and gateway/local_viewer_events.py:207-235.

- `result` is the raw tool output string (JSON text for most tools), truncated to 64 KiB as
  `{"output"|"error": "<head>", "truncated": true}`. `result_text` only when the session's
  tool progress is `verbose`.
- File edits — three sources, best first:
  1. `patch` tool: `JSON.parse(result).diff` is a **plain unified diff** (also `files_modified`,
     `files_created`, `files_deleted`) (agent/display.py:731-743, tools/file_operations_common.py:84).
  2. `inline_diff`: present for local-viewer turns on `write_file`/`patch`/`skill_manage`; a
     pre-rendered **ANSI-coloured** text: a header line, then `a/path → b/path` and `@@`/`+`/`-`/` `
     lines, capped in files/lines with an "omitted" footer (agent/display.py:746-820). Strip ANSI
     (`/\x1b\[[0-9;]*m/g`) and colour by first char.
  3. `args`: `patch` replace-mode `{path, old_string, new_string, replace_all?}`; patch-mode
     `{mode:"patch", patch:"*** Begin Patch\n*** Update File: …"}` (V4A); `write_file`
     `{path, content}` (tools/file_tools.py:1182-1265).
- Transcript tool rows keep `content` (the raw result) for `write_file`/`patch`/`skill_manage`/
  `clarify`, so the same diff extraction works on reload.
- `image_path`: a local image the tool produced (gateway path; you need a file route to show it).

---

## 5. Server→client interaction

### 5.1 Approvals and clarify on the canonical owner = **events + RPC**, not requests

gateway/session_pending_controls.py:18-51 publishes:

```json
{"type":"approval.request","session_id":"local-…","execution_generation":7,"payload":{
  "kind":"approval","prompt_id":"a1b2…","execution_generation":7,
  "command":"git push --force","description":"force push","choices":["once","deny","session","always"],
  "timeout_s":300}}
```

```json
{"type":"clarify.request","session_id":"local-…","payload":{
  "kind":"clarify","prompt_id":"c9…","execution_generation":7,
  "question":"Which DB?","choices":["sqlite","postgres"],"multi_select":false,"timeout_s":600}}
```

Answer (`choice` must be one of `choices`; empty `answer` = skip):

```json
{"method":"approval.respond","params":{"session_id":"local-…","execution_generation":7,"prompt_id":"a1b2…","choice":"once"}}
{"method":"clarify.respond","params":{"session_id":"local-…","execution_generation":7,"prompt_id":"c9…","answer":"postgres"}}
```

→ `{status:"resolved"|"already_resolved", prompt_id}`. Close the card on `approval.settled` /
`clarify.settled` `{prompt_id, execution_generation}` (another viewer may answer first) or on
`approval.cancelled`. Pending ones are re-sent in the snapshot's `prompts`. An approval with an
`edit` object (ACP edit approvals) only offers `once`/`deny`.

### 5.2 Real server→client requests

Answer with a response frame on the same `id` (must start with `srq-`):
`{"jsonrpc":"2.0","id":"srq-1a2b3c4d5e6f","result":{…}}`, or an error frame (treated as "no
answer": empty value / deny). Timeout is 120 s for sudo/secret (gateway/session_server_requests.py).
Withdrawn requests produce `request.cancel {id, method, reason}`.

| method | params | result | web UI |
|---|---|---|---|
| `sudo` | `{session_id, command?}` | `{value: "<password>"}` | handle (masked input) |
| `secret` | `{session_id, env_var, prompt, metadata?}` | `{value: "<secret>"}` | handle (masked input) |
| `clarify` | `{session_id, questions:[{qid, question, choices?, multi_select?}], answers?}` | `{answers:{<qid>: str|null}, outcome?:"submitted"|"cancelled"|"timed_out"}` | only sent if you submitted with `clarify_batch:true`; per-question locking via `clarify.lock {request_id, question_id, answer}` → `{status:"ok"|"expired", remaining?}` |
| `approval` | `{session_id, request_id, command?, description?, choices?, allow_permanent?, allow_session?, smart_denied?, tool_name?}` | `{choice:"once"|"session"|"always"|"deny", all?}` | legacy path; canonical owner uses 5.1 events. Cheap to support defensively. |
| `preview.read`, `preview.act`, `terminal.read`, `window.read`, `theme.apply`, `theme.pick`, `tour`, `setup_beat`, `display.install.sudo`, `vault.code`, `vault.save_login`, `vault.unlock_prompt` | Desktop window/vault bridges | `{value}` / various | reject: `{"error":{"code":-32601,"message":"unsupported"}}` (or `4404` when `declines_not_shown`). With `source:"tui"` the desktop bridges should not be requested. |

Requests still open after a reconnect come back in `open_requests` (resume / events.since) with
the same `id`; answering twice is harmless. `request.answer {id, result}` answers an open request
you never received as a frame.

---

## 6. Slash commands

- `commands.catalog {session_id?}` (live, trimmed):
  ```json
  {"pairs":[["/new","Start a new session (fresh session ID + history) (usage: /new [name])"],["/clear","…"],"… (+134)"],
   "sub":{"/diff":["staged","all","session"],"/queue":["list","edit","rm","…"],"…":[]},
   "canon":{"/skills":"/skills","/reload_skills":"/reload-skills","…":"…"},
   "commands":{"/new":{"argument_mode":"text","desktop":null},"/clear":{"argument_mode":null,"desktop":"terminal"},
               "/skills":{"…":"…","desktop_subcommands":["…"]}},
   "categories":[{"name":"Session","pairs":[["/new","…"],"…"]},{"name":"Configuration","pairs":[…]}],
   "skills":{"/youtube-content":{"usage":0,"origin":"bundled"}},"skill_count":39,
   "warning":"","plugin_discovery_error":"","plugin_commands":{}}
  ```
  `commands[x].desktop == "terminal"` marks terminal-only commands (hide them in a GUI).
- `complete.slash {text, session_id?}` (live):
  `{"items":[{"text":"moa","display":"/moa","meta":"Run one prompt through …","kind":"command"},{"text":"model","display":"/model","meta":"Switch model …","kind":"command"},…],"replace_from":1}`
  — replace `text.slice(replace_from)` with `item.text`.
- `complete.path {word, session_id?, cwd?}` → `{items:[{text, display?, meta?, kind?}]}` (live:
  `{"word":"./"}` without a session → `{"items":[]}`; pass `session_id` so it lists the session cwd).
- `slash.exec {session_id, command: "/compress auth"}` vs `command.dispatch {session_id, name: "compress", arg: "auth"}`:
  same executor (gateway/session_commands.py:421); `dispatch` takes name/arg split. Result
  `{type:"exec"|"alias"|"plugin"|"send"|"skill"|"prefill", output?, message?, notice?, display?, target?, name?, status?, warning?}`:
  `exec` ⇒ show `output`; `send`/`skill` ⇒ submit `message` as a prompt; `prefill` ⇒ put `message`
  in the composer; `alias` ⇒ re-dispatch `target`.
- Commands outside the owner's read/control sets are refused with `unsupported_command` and a hint
  in `data.detail` (e.g. `/export`, `/import`, `/snapshot`, `/handoff`, `/worktree`;
  gateway/session_commands.py:122-146). Desktop intercepts `/model <m> [--provider p]`, `/branch [title]`
  and `/compress [focus]` client-side and sends them as `session.mutate` operations instead of
  `slash.exec` (canonical-protocol.ts:61-82) — do the same (whether the owner also accepts them via
  `slash.exec` was not verified). Client-local commands (`/clear`, `/new` → `session.create`,
  `/redraw`) are the UI's job; `commands[x].desktop == "terminal"` marks them.

---

## 7. Model / config

- `model.options {session_id?, refresh?, explicit_only?, include_unconfigured?}` (live, trimmed):
  ```json
  {"providers":[{"slug":"anthropic","name":"Anthropic","is_current":false,"is_user_defined":false,
      "models":["claude-fable-5-2","claude-fable-5.1","…"],"total_models":18,"source":"hermes","authenticated":true,
      "capabilities":{"claude-opus-5-5":{"fast":true,"reasoning":true},"…":{}},"featured_models":[]},
    {"slug":"custom:llama.cpp","name":"llama.cpp","is_current":true,"is_user_defined":true,
      "models":["gemma","qwen","…"],"total_models":3,"source":"user-config",
      "api_url":"http://192.168.1.20:8082/v1","native_catalog_empty":false,"authenticated":true,
      "capabilities":{"qwen":{"fast":false,"reasoning":true}},"featured_models":[],
      "aliases":["custom:custom:llama.cpp","custom:llama.cpp","llama.cpp"]}],
   "model":"qwen","provider":"custom"}
  ```
  Without `session_id` the top-level `model`/`provider` are the **profile default**, not a
  session's (live: profile says `qwen`, the probed session runs `anthropic/claude-opus-4.6`).
  Also per provider: `pricing?`, `warning?`, `unavailable_models?`, `plan_usage?`, `limit?`, `usage?`.
- Current session model: `session.info.model` / `.provider` (also in the snapshot `info` and
  `session.info` events). `reasoning_effort`, `fast`, `service_tier` likewise.
- Switching: `session.mutate {operation:"model", payload:{model, provider}, expected_revision,
  expected_generation, request_id}` (2.9). `config.set {key:"model"}` is refused with
  `use_session_mutation_model` (gateway/session_busy_controls.py:31-35).
- `config.get {key, session_id?}`: keys `full, mtime, reasoning, fast, service_tier, daybreak, skin,
  theme, indicator, details_mode, approvals.mode, project, profile, voice, busy, verbose, yolo,
  show_reasoning` (gateway/session_config.py:64-114). (live) `{"key":"reasoning"}` →
  `{"value":"low","display":"show"}`.
- `config.set {key, value, session_id?, scope?: "session"|"global"}` → `{key, value?, warning?,
  confirm_required?, …, info?}`. Owner keys: `busy, verbose, yolo, show_reasoning, service_tier,
  reasoning, fast, personality, approvals.mode, details_mode, skin, …` (scope only on
  `reasoning`/`yolo`).

---

## 8. Rollback / diffs

Checkpoints exist only when the session was created with `checkpoints: true` (or config enables
them). gateway/session_tui_ops.py:196-300.

| method | params | result |
|---|---|---|
| `rollback.list` | `{session_id, undo_since?, undo_message_id?}` | `{enabled, checkpoints:[{hash, timestamp, message}], undo_hint?:{files?, text}}` |
| `rollback.diff` | `{session_id, hash}` (`hash` may be a 1-based index string) | `{stat, diff (raw unified, truncated to 4000 chars), rendered? (ANSI, 80 cols)}` |
| `rollback.session_diff` | `{session_id}` | `{enabled, success?, stat?, diff?, diff_lines?, empty?, error?}` (everything since the earliest checkpoint, ≤4 MiB) |
| `rollback.restore` | `{session_id, hash, file_path?, all?}` | `{success, restored_to?, reason?, directory?, file?, restored_files?, skipped_user_edits?, skipped_oversize?, failed_deletes?, history_removed?, error?}` |

`rollback.restore` without `file_path` is refused (`session_busy`) mid-turn, needs
`session:control`, keeps hand-edits unless `all: true`, and also rewinds the transcript to before
the newest user turn.

---

## 9. Subagents

Events (payload `SubagentEventPayload`, all optional except `goal, task_count, task_index`):
`subagent.spawn_requested`, `subagent.start`, `subagent.thinking`, `subagent.tool`,
`subagent.progress`, `subagent.complete`, with fields `subagent_id, parent_id, child_session_id,
delegation_id, depth, model, status ("queued"|"running"|"completed"|"failed"|"error"|"timeout"|"interrupted"),
tool_name, tool_preview, text, summary, duration_seconds, tool_count, toolsets, input_tokens,
output_tokens, reasoning_tokens, api_calls, files_read, files_written,
output_tail:[{tool, preview, is_error}]`. Key the tree by `subagent_id` / `parent_id`. Background
children can keep emitting after the parent turn ended (gateway/local_viewer_events.py:110-126).

| method | params | result |
|---|---|---|
| `subagent.list` | `{session_id}` | `{subagents:[{subagent_id, parent_id?, depth?, goal?, delegation_id?, model?, started_at?, status?, tool_count?, last_tool?, accepting_steer?, child_session_id?}], delegations:[{delegation_id, task_index?, status, goal?, error?, dispatched_at?, completed_at?}]}` |
| `subagent.tail` | `{session_id, subagent_id}` | `{subagent_id, available?, text? (last 16 KB), truncated?}` |
| `subagent.interrupt` | `{session_id, subagent_id}` | `{found, subagent_id}` |
| `subagent.steer` | `{session_id, subagent_id, text}` | `{status:"queued"|"rejected", subagent_id, text}` |
| `session.transcript` | `{session_id, subagent_id, …}` | a child's full rows (2.5) |

---

## 10. Gotchas checklist

1. One attach per socket; ticket dies in 30 s and after one use. No `Origin` header from the bridge.
2. `gateway.ready` comes first; send `client.capabilities {server_requests:true}` then
   `runtime.describe` before anything else.
3. You see a session's events and may submit only after `session.create`/`session.resume` on
   **this** socket; a new socket must resume again.
4. `prompt.submit` needs `submission_id`; its reply is an admission, not the answer.
5. Interrupt/steer/approve/model-switch need the **current** `execution_generation`; mutations need
   the current `revision` — track both from `session.info` events.
6. Approvals/clarify arrive as `approval.request`/`clarify.request` **events** (answer with
   `approval.respond`/`clarify.respond`), while sudo/secret arrive as JSON-RPC **requests**
   (answer the `srq-` id). Unknown requests: answer `-32601` immediately or the agent blocks up to
   the request timeout.
7. `message.complete.text` may be empty because it already streamed.
8. Old-catalog `session.*` verbs (title, archive, delete, usage, branch, …) are `-32601` here —
   use `session.mutate` / `session.info` / `session.stats`.
9. Requests are serialized per socket (except transcript/context_breakdown/account_usage);
   long calls delay later ones.
10. `source: "gui"` makes the agent ask the window for previews/themes/reads; use `tui`.
11. An `unknown` admission pauses the queue until `prompt.resolve_unknown`.
12. `model.options` without `session_id` reports the profile default model, not the session's.

---

## Appendix: probe

`tools/probe.py` (run with the Hermes venv interpreter in its shebang, which has `websockets`
15.0.1; `/home/me/.local/bin/hermes` is a `/bin/sh` wrapper around
`/home/me/.hermes/tools/python-3.14.9+…/bin/python3`, whose bare `sys.path` has neither
`websockets` nor `aiohttp` — the bootstrap adds
`/home/me/.hermes/installs/<install-id>/environments/<env-id>/venv`).
It runs `hermes gateway attach --json` (discover only), redacts the ticket, does the handshake and
calls only read methods: `client.capabilities`, `gateway.ping`, `runtime.describe`, `ping`,
`commands.catalog`, `session.list` (live + stored), `model.options`, `config.get`,
`complete.slash`, `complete.path`, `session.transcript`, `session.info`. `--raw` disables trimming.
