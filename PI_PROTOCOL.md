# Pi RPC protocol reference (pi 1.5.2)

Field-level reference for a bridge (Python/aiohttp) that owns long-lived `pi --mode rpc` children and a vanilla-JS browser client.

Sources, by precedence:
1. **Live probe**: `tools/pi_probe.py`, run on 2026-11-17 against a real config. Model `local/qwen` (a llama.cpp server on the LAN, here `192.168.1.20`). Records marked *(live)* are real output with long values trimmed.
2. **Installed type definitions and JS** under `PKG=/home/me/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent`, cited as `dist/...:line`.
3. **Installed docs** in `$PKG/docs`, cited as `docs/...`.

Points that are inferred rather than read directly in code or docs are marked **(inferred)**.

---

## 0. Framing in one paragraph

Each record is one JSON object per line, in both directions: commands go to stdin, and responses and events come back on stdout. Split on `\n` only, and strip a trailing `\r`. Never use a reader that also splits on U+2028/U+2029. In Python, read `proc.stdout` as bytes and split on `b"\n"`, then decode. Stdout carries protocol records only; diagnostics go to stderr, which must never be parsed. Read stdout continuously, because Pi applies backpressure and stalls if nobody reads.

Every command may carry an optional string `id`, and its `response` repeats it. **Commands are handled concurrently.** The reader calls `void handleInputLine(line)` without awaiting it (`dist/modes/rpc/rpc-mode.js:670-673`). So `abort` works while a `prompt` is in flight, and responses can arrive out of order. Always correlate by `id`. Events have no `id`; the one exception is `bash_execution_update`.

Record families on stdout:

| `type` | Meaning |
|---|---|
| `response` | Answer to one command: `{id?, type:"response", command, success, data? \| error?}` |
| session events | `agent_start`, `message_update`, `tool_execution_*`, `queue_update`, and so on (§3) |
| `extension_ui_request` | Extension wants UI: a dialog or fire-and-forget (§5) |
| `extension_error` | An extension handler threw |

On stdin, the only non-command record is `extension_ui_response`.

---

## 1. Launch, sessions on disk, picker

### 1.1 CLI flags that matter for the bridge

| Flag | Effect | Notes |
|---|---|---|
| `--mode rpc` | JSONL on stdin/stdout until shutdown | `@file` args are rejected in RPC mode |
| `--session <path\|id>` | Open a session by file path or by full/partial ID. The session runs **in its header `cwd`** | **Always pass an absolute `.jsonl` path.** An argument containing `/` or ending in `.jsonl` is treated as a path (`dist/main.js:237-241`). An ID that matches only another project's session triggers an interactive `promptConfirm` that writes to **stdout** and reads stdin (`dist/main.js:359-366`). That corrupts the RPC stream. |
| `--continue` / `-c` | Most recent session for the process cwd, or a new one | OK for RPC, but explicit `--session` is more predictable |
| `--resume` / `-r` | Opens the **TUI** session picker | **Never use with RPC**: it is interactive (`dist/main.js:373-385`) |
| `--session-id <id>` | Open this cwd's session with that ID, or create it with that ID | Letters, digits, `.`, `_`, `-` |
| `--fork <path\|id>` | Fork a session into a new session in the process cwd | Cannot combine with `--session/--continue/--resume/--no-session` |
| `--session-dir <dir>` | Override storage. Precedence: CLI > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting | With a custom dir, files sit **flat** in `<dir>`, without per-cwd subfolders (`dist/core/session-manager.js:1329,1367`) |
| `--no-session` | In-memory session, nothing written | `get_state`/`get_session_stats` then **omit `sessionFile`** *(live)* |
| `--name/-n <name>` | Set the display name, which writes a `session_info` entry | |
| `--model <pattern>` | Exact or fuzzy ID; accepts `provider/id` and a `:thinking` suffix | |
| `--provider <name>` | Restricts `--model` lookup; **requires `--model`** (an error otherwise) | |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh\|max`, clamped to the model | |
| `--approve` / `--no-approve` | One-shot project-trust decision (see §6) | RPC cannot show the trust prompt |
| `--offline` | No catalog refresh or network chatter | RPC otherwise refreshes model catalogs in the background (`dist/main.js:820-827`) |
| `--tools`, `--exclude-tools`, `--no-extensions`, `--no-skills`, ... | Resource selection | See `docs/cli.md` |

**The process cwd matters.** Pi does not `chdir`. On startup, the runtime cwd is `sessionManager.getCwd()` (`dist/main.js:755-756`). For a new session that is `process.cwd()`. For `--session <file>` it is the file header's `cwd`. That cwd drives tools, project `.pi/` resources, `AGENTS.md`/`CLAUDE.md`, and the default session folder.

**Recipes for the bridge:**

```bash
# new persisted session in folder F (file appears after the first user message)
cd F && pi --mode rpc
# resume an existing file in its own cwd. Set the process cwd to the header cwd anyway (inferred: avoids surprises
# for extensions that use process.cwd())
cd "$(header.cwd)" && pi --mode rpc --session /home/me/.pi/agent/sessions/--home-me-Code-x--/2026-..._<uuid>.jsonl
# ephemeral
pi --mode rpc --no-session
```

If the header `cwd` no longer exists, non-interactive modes print an error to stderr and **exit 1** (`dist/main.js:604-624`). Check `os.path.isdir(header.cwd)` before spawning. If the `--session` path does not exist, `SessionManager.open` falls back to `process.cwd()` and will create a file at that path **(inferred from `dist/core/session-manager.js:1337-1355`)**. Validate the path first.

There is no "ready" event. Readiness means "the first command got a response". Send `get_state` right after spawn. In the probe that took 3.9 s cold and 0.45 s warm *(live)*. Extension UI records (`setStatus`/`setWidget`) are emitted **before** any command is answered *(live)*, so start reading stdout immediately.

### 1.2 Where sessions live

```
~/.pi/agent/sessions/--<cwd with leading "/" removed and "/", "\", ":" replaced by "-">--/<ISO timestamp with ":" and "." → "-">_<sessionId>.jsonl
```

Example: cwd `/home/me/Code/Stellwerk` becomes `~/.pi/agent/sessions/--home-me-Code-Stellwerk--/2026-11-17T22-55-07-430Z_01a1ebb8-....jsonl` (`dist/core/session-manager.js:291-296`, `:713`). The encoding is lossy: `/a-b` and `/a/b` collide. **Read `cwd` from the header and don't decode the folder name.**

On this machine `~/.pi/agent/sessions/` **does not exist yet**, because no persisted session has been created. Session IDs in 1.5.2 are UUIDv7-like (e.g. `01a1ebb8-9daa-77a8-9424-f76fe4d2cdc6`) *(live)*.

**Files are created lazily.** A new session's file is written only once it holds a user or assistant message. The first write dumps all buffered entries; later writes append one line each (`dist/core/session-manager.js:785-812`). `get_state.sessionFile` returns the intended path before the file exists. There is no file lock, so **never run two Pi processes on the same file (inferred)**.

### 1.3 File format (session-format.md, v3)

Line 1 is the header, which is not part of the tree:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original.jsonl"}
```

`parentSession` appears only on forks and clones. Every other line extends `{type, id (8 hex), parentId (string|null), timestamp (ISO string)}`:

| `type` | Extra fields | In LLM context? |
|---|---|---|
| `message` | `message: AgentMessage` (§4; `message.timestamp` is **epoch ms**) | yes |
| `model_change` | `provider`, `modelId` | no |
| `thinking_level_change` | `thinkingLevel` | no |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, `systemMessage?`, `usage?`, `details?`, `fromHook?` | becomes `compactionSummary` |
| `branch_summary` | `fromId`, `summary`, `usage?`, `details?`, `fromHook?` | becomes `branchSummary` |
| `context_edit` | `targetId`, `replacement` (`null` = omit) | modifies another entry |
| `usage` | `kind`, `provider`, `model`, `usage` | no (counted in cost) |
| `custom` | `customType`, `data` (extension state; e.g. SoL-Pi writes `sol-pi-online-context-state-v1` on every request *(live)*) | no |
| `custom_message` | `customType`, `content`, `display`, `details?` | yes |
| `label` | `targetId`, `label` (absent = cleared) | no |
| `session_info` | `name` (absent or empty = cleared) | no |

Entries form a tree via `parentId`. The active branch is the path from the **last appended entry** (the leaf) up to the root. Messages with `role:"system"` are persisted too: the prompt/tool loadout as `sections`, `toolsAdded`, `toolsRemoved`.

### 1.4 Cheap picker listing (what `/resume` does)

Mirror `buildSessionInfo` (`dist/core/session-manager.js:493-566`). Glob `~/.pi/agent/sessions/*/*.jsonl` and stream each file line by line:

- **header** = first line. It must have `type:"session"`, otherwise skip the file. From it take `id`, `cwd`, `timestamp` (= created) and `parentSession`.
- **name** = the `name` of the **last** `session_info` entry, trimmed. Empty or absent means unnamed; a later entry can clear an earlier name.
- **firstMessage** = text of the first `message` with `role:"user"`. If `content` is a string, use it; if it is an array, join the `text` blocks with `" "`. Skip messages whose text is empty. Use `"(no messages)"` if none.
- **messageCount** = number of `message` entries, all roles including system and toolResult.
- **modified** = max `message.timestamp` (ms) over user/assistant messages. If none, the header timestamp; then file mtime. Sort descending by this.
- Title shown = `name ?? firstMessage`.

For speed you can stop at the first user message, but you then lose the name, since `session_info` can come later, and the modified time. A compromise is to read the head of the file for the header and first user message, scan for `"type":"session_info"`, and use file mtime as "modified".

---

## 2. Commands (stdin) and responses

All responses share `{"id"?, "type":"response", "command":"<type>", "success":true, "data"?}` or `{..., "success":false, "error":"<message>"}`. Types are in `dist/modes/rpc/rpc-types.d.ts`.

Error shapes *(live)*:

```json
{"id":"probe-7","type":"response","command":"definitely_not_a_command","success":false,"error":"Unknown command: definitely_not_a_command"}
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
```

A parse error carries no `id`, so the bridge cannot tell which request failed. Always send valid JSON.

### 2.1 Prompting

**`prompt`**

```json
{"id":"p1","type":"prompt","message":"Hello","images":[{"type":"image","data":"<base64, no data: prefix>","mimeType":"image/png"}],"streamingBehavior":"steer"}
```

- `images` is optional. It is `ImageContent[]`, and it is the **only** attachment mechanism. Other files must be referenced by path or pasted into `message` **(inferred: no other field exists in `RpcCommand`)**. Gate image upload on `model.input` including `"image"`.
- `streamingBehavior` (`"steer"` or `"followUp"`) is **required while a run is active**. Without it you get the following *(live)*:
  ```json
  {"id":"probe-9","type":"response","command":"prompt","success":false,"error":"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."}
  ```
- Successful response: `{"id":"probe-8","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}` *(live)*. `disposition` is one of:
  - `"started"`: a run began. Wait for `agent_settled`.
  - `"queued"`: the prompt was queued during a run, and a `queue_update` follows.
  - `"handled"`: an extension command or input hook consumed it. **No run starts, so don't wait for `agent_settled`.**
- **Response timing.** The response is written once preflight passes (`dist/modes/rpc/rpc-mode.js:314-340`). With `"started"`, `agent_start` follows in the same millisecond *(live)*. For **extension commands** (`/cd`, `/powerline`, ...), the response comes only **after the command handler finishes** (`dist/core/agent-session.js:1704-1711`). If the handler opens a dialog, the response waits until the dialog is answered.
- Text starting with `/`: extension commands execute even during streaming. `/skill:name args` and prompt-template names `/tmpl args` are expanded into a normal prompt. **Unknown `/foo` is sent to the model as plain text**, with no error. Built-in TUI commands such as `/settings`, `/model`, `/compact` and `/new` **do not work** via `prompt`; use the RPC commands instead.
- Other rejections, sent as a single error response: `"Cannot submit a prompt while compaction is in progress..."` (`dist/core/agent-session.js:1712-1713`), "no model selected", "No API key found...".
- Failures **after** acceptance (provider down, abort) never produce a second response. They appear in the event stream (§3.6).

**`steer`** and **`follow_up`**: `{"type":"steer"|"follow_up","message":"...","images"?:[...]}`, answered with `{"command":"follow_up","success":true,"data":{"disposition":"queued"}}` *(live)* (or `"handled"`). Extension commands are not allowed here.
- A steer is delivered after the current turn's tool calls finish, before the next LLM call.
- A follow-up is delivered once the agent would otherwise stop. Live, it ran **inside the same run**: `turn_end` → `turn_start` → `queue_update{followUp:[]}` → user `message_start/end` → ... → one `agent_end` and `agent_settled`.
- Default modes are `"one-at-a-time"` for both (live `get_state`). Change them with `set_steering_mode` / `set_follow_up_mode` `{mode:"all"|"one-at-a-time"}`.

**`abort`**: `{"type":"abort"}` returns `{"command":"abort","success":true}`, but only **after the session is idle**. **Queued steer and follow-up messages continue after an abort.** For an Esc-style hard stop, send `clear_queue` first and then `abort`.

**`clear_queue`**: `{"type":"clear_queue"}` returns `{"data":{"steering":["..."],"followUp":["..."]}}`, the text of what was removed, so you can restore it in the editor.

**`new_session`**: `{"type":"new_session","parentSession"?:"/path.jsonl"}` returns `{"data":{"cancelled":false}}`. An extension can cancel it (`cancelled:true`).
- **Side effects:** any active run is **aborted**, extensions get `session_shutdown`, and the runtime is rebuilt with the **same cwd** (`dist/core/agent-session-runtime.js:102-113,147-170`).
- Persistence follows the old session: in-memory stays in-memory.
- The session file path changes, so re-read `get_state`.

### 2.2 State and history

**`get_state`** returns `RpcSessionState` (`rpc-types.d.ts`) *(live)*:

```json
{"id":"probe-1","type":"response","command":"get_state","success":true,"data":{
  "model":{"id":"qwen","name":"qwen (sees images)","api":"openai-completions","provider":"local","baseUrl":"http://192.168.1.20:8082/v1","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":204800,"maxTokens":16384,"compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false}},
  "thinkingLevel":"medium","isStreaming":false,"isCompacting":false,
  "steeringMode":"one-at-a-time","followUpMode":"one-at-a-time",
  "sessionId":"01a1ebb8-77dc-75b6-bfe9-9c05acbbdb50",
  "autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}
```

| Field | Type | Notes |
|---|---|---|
| `model` | Model | omitted if none |
| `thinkingLevel` | `off\|minimal\|low\|medium\|high\|xhigh\|max` | |
| `isStreaming` | bool | true while a run is active |
| `isCompacting` | bool | |
| `steeringMode` | `all\|one-at-a-time` | |
| `followUpMode` | `all\|one-at-a-time` | |
| `sessionFile` | string | **omitted** with `--no-session`; may point to a file not yet written |
| `sessionId` | string | |
| `sessionName` | string | omitted if unnamed |
| `autoCompactionEnabled` | bool | |
| `messageCount` | number | = `get_messages` length, **including the system message** |
| `pendingMessageCount` | number | queued steer + follow-up count |

There is **no queue content** in `get_state`. Track it from `queue_update` events.

**`get_messages`** returns `{"data":{"messages":AgentMessage[]}}`: the active branch's context, compaction-aware. It **includes a leading `role:"system"` message** after the first request *(live)*; skip it when rendering. After compaction, older turns are replaced by a `compactionSummary`. For full raw history use `get_entries`.

**`get_entries`**: `{"type":"get_entries","since"?:"<entryId>"}` returns `{"data":{"entries":SessionEntry[],"leafId":"..."|null}}`. These are all entries, abandoned branches and pre-compaction entries included. `since` is a durable cursor; an unknown `since` returns `success:false` with `"Entry not found: <id>"`.

**`get_tree`** returns `{"data":{"tree":[{"entry":SessionEntry,"children":[...],"label"?,"labelTimestamp"?}],"leafId"}}`. It is an array because there can be several roots.

**`get_last_assistant_text`** returns `{"data":{"text":"..."|null}}`.

### 2.3 Model and thinking

**`get_available_models`** returns `{"data":{"models":[Model,...]}}`. Live: `local/gemma, local/qwen, local/qwen-nothink, …`, all with `cost` 0 on LAN hosts.

Model object *(live)*:

```json
{"id":"gemma","name":"gemma","api":"openai-completions","provider":"local","baseUrl":"http://192.168.1.20:8082/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":256000,"maxTokens":16384,"compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false}}
```

Costs are USD per million tokens. The `apiKey` from `models.json` is **not** included. A configured `headers` field might be **(inferred)**, so don't forward Model objects verbatim to third parties.

**`set_model`**: `{"type":"set_model","provider":"local","modelId":"gemma"}` returns `{"data":Model}`, or `{"success":false,"error":"Model not found: local/x"}`. Matching is exact on provider and id (`rpc-mode.js:387-395`). The change is persisted as a `model_change` entry.

**`cycle_model`** returns `{"data":{"model","thinkingLevel","isScoped"}|null}`.

**`get_available_thinking_levels`** returns `{"data":{"levels":["off","minimal","low","medium","high"]}}` *(live, for qwen)*. A non-reasoning model returns `["off"]`. For these llama.cpp models `compat.supportsReasoningEffort:false`, so **the level may not change anything server-side (inferred)**.

**`set_thinking_level`**: `{"type":"set_thinking_level","level":"high"}` returns `{"success":true}`, with no data. The level is clamped and a `thinking_level_changed` event follows. **`cycle_thinking_level`** returns `{"data":{"level"}|null}`.

### 2.4 Compaction, retry, bash

**`compact`**: `{"type":"compact","customInstructions"?:"..."}` returns `{"data":{"summary","firstKeptEntryId","tokensBefore","estimatedTokensAfter"?,"usage"?,"details"?}}`. Also emits `compaction_start` / `compaction_end` with `reason:"manual"`. It errors with `"Nothing to compact (session too small)"` or `"Already compacted"`.

**`set_auto_compaction`** `{enabled}` and **`set_auto_retry`** `{enabled}` return `{"success":true}`. **`abort_retry`** cancels a pending retry delay.

**`bash`**: `{"id":"b1","type":"bash","command":"echo hi","excludeFromContext"?:true}`. This is a user shell command, the "!cmd" equivalent, not an LLM tool call. It streams `bash_execution_update` events carrying the command `id` *(live)*:

```json
{"type":"bash_execution_update","id":"probe-8","delta":"hi\n"}
{"id":"probe-8","type":"response","command":"bash","success":true,"data":{"output":"hi\n","exitCode":0,"cancelled":false,"truncated":false}}
```

If output was truncated, `data` adds `"fullOutputPath":"/tmp/pi-bash-....log"`. The output is stored as a `bashExecution` message and reaches the model **on the next prompt**, unless `excludeFromContext`. **`abort_bash`** stops it. It runs in the session cwd. It is not blocked by an active run **(inferred: there is no guard in `rpc-mode.js:461-480`)**.

### 2.5 Session

**`get_session_stats`** returns `SessionStats` *(live, after a 3-prompt run)*:

```json
{"data":{"sessionId":"01a1ebba-...","userMessages":3,"assistantMessages":5,"toolCalls":2,"toolResults":2,"totalMessages":11,
 "tokens":{"input":1148,"output":199,"cacheRead":27300,"cacheWrite":0,"total":28647},"cost":0,
 "contextUsage":{"tokens":5876,"contextWindow":204800,"percent":2.869140625}}}
```

- `sessionFile` is added when persisted.
- `contextUsage` is omitted without a model or context window. Its `tokens` and `percent` are **`null`** right after compaction, until the next response arrives.
- `tokens` and `cost` cover the whole session, including tool-reported and summary usage. `contextUsage` is what a footer gauge should show.

**`switch_session`**: `{"type":"switch_session","sessionPath":"/abs/file.jsonl"}` returns `{"data":{"cancelled":false}}`.
- It aborts the active run, then opens the file and rebuilds the runtime **in that session's header cwd** (`agent-session-runtime.js:128-146`).
- If the header cwd is missing, it fails with `success:false` (`assertSessionCwdExists`).
- **History is not pushed.** Call `get_messages` afterwards.
- With one process per session in the bridge, you rarely need this; respawning is cleaner.

**`fork`**: `{"type":"fork","entryId":"<user message entryId from get_fork_messages>"}` returns `{"data":{"text":"<that prompt's text>","cancelled":false}}`.
- It creates a **new session file**: history up to just **before** that user message, with `parentSession` set. The process then **switches to it**.
- Put `text` back in the editor for re-editing.
- It errors with `"Invalid entry ID for forking"` if the entry is not a user message.

**`clone`**: `{"type":"clone"}` returns `{"data":{"cancelled":false}}`. It copies the active branch into a new session and switches to it.

**`get_fork_messages`** returns `{"data":{"messages":[{"entryId":"abc123","text":"First prompt..."}]}}`.

There is **no RPC command for in-place tree navigation** (TUI `/tree`) and none for labels. Over RPC, branching means `fork` or `clone`.

**`set_session_name`**: `{"type":"set_session_name","name":"..."}` returns `{"success":true}`. The name is trimmed; empty gives `"Session name cannot be empty"`. A `session_info_changed` event follows.

**`export_html`**: `{"outputPath"?}` returns `{"data":{"path"}}`.

### 2.6 Discoverable commands

**`get_commands`** returns `{"data":{"commands":[{"name","description"?,"source":"extension"|"prompt"|"skill","sourceInfo":{"path","source","scope","origin","baseDir"?,"changelogPath"?}}]}}`.

Live record:

```json
{"name":"cd","description":"Switch the Pi session working directory","source":"extension","sourceInfo":{"path":"/home/me/.pi/agent/npm/node_modules/pi-powerline-footer/index.ts","source":"npm:pi-powerline-footer","scope":"user","origin":"package","baseDir":"/home/me/.pi/agent/npm/node_modules/pi-powerline-footer","changelogPath":".../CHANGELOG.md"}}
```

Live list (22 entries):

- Extension commands: `/cd /reply /queue /powerline /stash-history /bash-mode /powerline-perf /bash-reset /vibe` (powerline); `/websearch /curator /google-account /search` (pi-web-access); `/pi-vcc /pi-vcc-recall` (pi-vcc); `/llama` (llama extensions); `/mcp` (built-in MCP).
- Prompt templates: `/implement-and-review /implement /scout-and-plan`.
- Skills: `/skill:ruby-conventions /skill:ruby-docs`.

To invoke one, send `prompt` with `message: "/" + name + " " + args`. Skills already have the `skill:` prefix in `name`. Many powerline commands depend on the TUI. They use `ui.custom()` (which returns `undefined` in RPC), editor widgets, or `ctx.ui.setEditorText`, so expect them to do little or nothing useful in a browser UI.

---

## 3. Events (stdout)

Wire events are the SDK `AgentSessionEvent` union (`dist/core/agent-session.d.ts:49-112`). The only change is that `message_update` is turned into a delta-only form (`dist/modes/json-event.js`). Events after a session switch come from the new session, with no marker other than your own command's response.

### 3.1 Lifecycle and order (real, trimmed: prompt → thinking → text → bash tool → final answer → queued follow-up)

```
t=0.476 response prompt {disposition:"started"}
        agent_start
        turn_start
        message_start  {message:{role:"system",...}}   ← first request only, or when prompt/tools change: don't render
        message_end    {message:{role:"system",...}}
        message_start  {message:{role:"user",content:[{type:"text",text:"Reply with just..."}],timestamp}}
        message_end    (same)
        entry_appended {entry:{type:"custom",customType:"sol-pi-online-context-state-v1",...}}   ← SoL-Pi, ignore
t=0.581 message_start  {message:{role:"assistant",content:[],stopReason:"pending",usage:{zeros},api,provider,model,timestamp}}
        (cold model: this came 51 s after the user message, so show a "waiting for model" state)
        message_update thinking_start{contentIndex:0}
        message_update thinking_delta{contentIndex:0,delta:"The"}   ×N
        message_update text_start{contentIndex:1}
        message_update text_delta{contentIndex:1,delta:"ok"}
        message_update toolcall_start{contentIndex:2,id:"MLYU4z...",toolName:"bash"}
        message_update toolcall_delta{contentIndex:2,delta:"{"} … "\"command\":\"" … "echo" … " hi" … "\"" … "}"
        message_update thinking_end{contentIndex:0,content:"User wants: ..."}  ← all *_end arrived together at stream end
        message_update text_end{contentIndex:1,content:"ok"}
        message_update toolcall_end{contentIndex:2,toolCall:{type:"toolCall",id,name:"bash",arguments:{command:"echo hi"}}}
        message_end    {message:{role:"assistant",content:[thinking,text,toolCall],stopReason:"toolUse",usage:{...},...}}
        tool_execution_start  {toolCallId,toolName:"bash",args:{command:"echo hi"}}
        tool_execution_update {...,partialResult:{content:[]}}
        tool_execution_update {...,partialResult:{content:[{type:"text",text:"hi\n"}],details:{}}}
        tool_execution_end    {...,result:{content:[...],structuredContent:{...}},isError:false,durationMs:18}
        message_start/message_end {message:{role:"toolResult",...}}
        extension_ui_request setStatus llama-cpp-tps / notify "TPS: ..."   ← after every assistant message
        turn_end {message:<assistant>,toolResults:[<toolResult>]}
        turn_start
        message_start(assistant) … message_end(stopReason:"stop")
        turn_end {toolResults:[]}
        turn_start                                             ← queued follow-up delivered inside the same run
        queue_update {steering:[],followUp:[]}
        message_start/end {role:"user",content:[{type:"text",text:"Now reply with just the word done."}]}
        … assistant turn …
        agent_end {messages:[...all messages of this run, system included...],willRetry:false}
        agent_settled {aborted:false}
```

| Event | Fields |
|---|---|
| `agent_start` | none |
| `agent_end` | `messages: AgentMessage[]` (messages generated by this low-level run), `willRetry: bool` |
| `agent_settled` | `aborted: bool`. **This is the real "idle" signal**: no retry, compaction recovery or queued work remains. |
| `turn_start` | none |
| `turn_end` | `message` (the assistant message), `toolResults: ToolResultMessage[]` |
| `message_start` / `message_end` | `message: AgentMessage` (any role: system, user, assistant, toolResult, custom, bashExecution...). `message_end` is authoritative. |
| `message_update` | `usage: Usage`, `assistantMessageEvent` (below). Assistant messages only. |

### 3.2 `assistantMessageEvent` subtypes (`docs/json.md`)

| type | fields |
|---|---|
| `text_start` | `contentIndex` |
| `text_delta` | `contentIndex`, `delta` |
| `text_end` | `contentIndex`, `content` (the full text) |
| `thinking_start` | `contentIndex` |
| `thinking_delta` | `contentIndex`, `delta` |
| `thinking_end` | `contentIndex`, `content` |
| `toolcall_start` | `contentIndex`, `id`, `toolName` |
| `toolcall_delta` | `contentIndex`, `delta` (a raw JSON-args fragment) |
| `toolcall_end` | `contentIndex`, `toolCall: {type:"toolCall", id, name, arguments, thoughtSignature?, namespace?}` |
| `start` / `done{reason,message}` / `error{reason,error}` | Defined, but the normal loop turns these into `message_start` / `message_end`. Tolerate them and ignore them. |

The top-level `usage` is cumulative for this assistant message. With this provider it **stays all zeros until the final block-end events** *(live)*.

### 3.3 Reconstructing an assistant message (client algorithm)

1. On `message_start` with `role:"assistant"`: `cur = structuredClone(message)` with `content = []`. Show a pending bubble.
2. On `*_start`: `cur.content[contentIndex] = {type:"text",text:""}`, `{type:"thinking",thinking:""}` or `{type:"toolCall",id,name:toolName,arguments:{},_raw:""}`.
3. On `*_delta`: append to `.text`, `.thinking` or `._raw`. For a live tool-arg preview, you may try a tolerant partial-JSON parse of `_raw`.
4. On `*_end`: **replace** the block with `content` or `toolCall`.
5. On `message_end`: **replace the whole thing** with `message`. Read `stopReason` there: `stop`, `length`, `toolUse`, `error`, `aborted` or `deferred`, plus `errorMessage`.

Index by `contentIndex`, not by arrival order: thinking is 0, text 1, toolcall 2 *(live)*. Live assistant messages also carry fields not listed in `docs/message-types.md`: `responseId`, `rawStopReason`, `durationMs`, `thinkingLevel`, `usage.reasoning` and `usage.cost.totalFromProvider`. The thinking block had `thinkingSignature:"reasoning_content"`. The user has `hideThinkingBlock:true` in the TUI, so consider collapsing thinking blocks by default.

### 3.4 Tool execution

| Event | Fields |
|---|---|
| `tool_execution_start` | `toolCallId`, `toolName`, `args`, `parentToolCallId?` |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult: {content, details?}`, `parentToolCallId?` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result: {content, details?, structuredContent?}`, `isError`, `durationMs?`, `parentToolCallId?` |

- `parentToolCallId` is set for calls a tool made through `ctx.executeTool()`, e.g. codemode scripts (`agent-session.d.ts:42-47`). Nest these under the parent's card.
- Correlate by `toolCallId`; it equals the assistant `toolCall.id`.
- `tool_execution_start` comes **after** the assistant `message_end`. The `toolResult` message (`message_start/end`, role `toolResult`) comes right after `tool_execution_end`.
- `partialResult` semantics are per tool. Built-in **bash sends cumulative snapshots** (tail-truncated), so **replace, don't append**. The first update is `{content:[]}`. Updates are throttled (`dist/core/tools/bash.js:204-241`).
- Keys with `undefined` values are **dropped** by JSON. Bash without truncation therefore has no `details` key at all *(live)*.
- `result.structuredContent` is present on `tool_execution_end` but **not** on the persisted `toolResult` message *(live)*. Don't rely on it for history.

Built-in tools: args and `details` (`dist/core/tools/*.d.ts`):

| Tool | `args` | `result.details` |
|---|---|---|
| `bash` | `{command, timeout?}` | `{truncation?: TruncationResult, fullOutputPath?}` or absent. `structuredContent: {output, truncated, full_output_path?, exit_code, wall_time_seconds}`. A non-zero exit gives `isError:true` and the text ends `"Command exited with code N"`. |
| `read` | `{path, offset?, limit?}` | `{truncation?}`. Image files return an `image` content block. |
| `edit` | `{path, edits:[{oldText,newText}]}` | **`{diff, patch, firstChangedLine?}`** (below) |
| `write` | `{path, content}` | **none**. The content text is `"Successfully wrote to <path>"`. Render the diff yourself from `args.content`, as "new file / overwritten"; the old content is not available. |
| `grep` | `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}` | `{truncation?, matchLimitReached?, linesTruncated?}` |
| `find` | `{pattern, path?, limit?}` | `{truncation?, resultLimitReached?}` |
| `ls` | `{path?, limit?}` | `{truncation?, entryLimitReached?}` |

Live edit result:

```json
{"type":"tool_execution_end","toolCallId":"Yc1hOx...","toolName":"edit",
 "result":{"content":[{"type":"text","text":"Successfully replaced 1 block(s) in hello.txt."}],
           "details":{"diff":" 1 line one\n-2 hello world\n+2 hello there\n 3 line three",
                      "patch":"--- hello.txt\n+++ hello.txt\n@@ -1,3 +1,3 @@\n line one\n-hello world\n+hello there\n line three\n",
                      "firstChangedLine":2}},
 "isError":false,"durationMs":19}
```

- `details.patch` is a **standard unified diff**. It is the best input for a diff renderer (e.g. diff2html) and is also persisted on the `toolResult` message.
- `details.diff` is the TUI display format: each line is `<marker><lineNo padded to width> <text>`. The marker is `+` (new-file line number), `-` (old-file line number) or a space (context). Gaps are a line with spaces plus `...`. There are 4 context lines (`dist/core/tools/edit-diff.js:318-400`).
- A failed edit throws, so you get `isError:true` with the error text in `content`, e.g. `"Could not edit file: ..."`.

### 3.5 Queue, state, compaction, retry

| Event | Fields |
|---|---|
| `queue_update` | `steering: string[]`, `followUp: string[]`: the **complete** current queues *(live)* |
| `entry_appended` | `entry: SessionEntry`, from `pi.appendEntry()` by extensions (SoL-Pi on every request, pi-web-access) |
| `session_info_changed` | `name?` (absent = cleared) |
| `thinking_level_changed` | `level` |
| `compaction_start` | `reason: "manual"\|"threshold"\|"overflow"` |
| `compaction_end` | `reason`, `result?: CompactionResult`, `aborted`, `willRetry`, `errorMessage?` |
| `auto_retry_start` | `attempt`, `maxAttempts` (default 3), `delayMs`, `errorMessage` |
| `auto_retry_end` | `success`, `attempt`, `finalError?` |
| `summarization_retry_scheduled` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |
| `summarization_retry_attempt_start` | `source: "compaction"` with `reason`, or `source: "branchSummary"` |
| `summarization_retry_finished` | none |
| `bash_execution_update` | `id?`, `delta` (RPC `bash` only) |
| `extension_error` | `extensionPath`, `event`, `error` |

`compaction_end` on overflow recovery has `willRetry:true`: Pi re-sends the prompt automatically.

### 3.6 Errors after acceptance (not live-tested; from types)

- Provider failure: the assistant `message_end` has `stopReason:"error"` and `errorMessage`. Transient errors (overload, rate limit, 5xx, network) first produce `auto_retry_start` and `auto_retry_end`. `agent_end.willRetry` tells you whether more is coming. Always wait for `agent_settled`.
- Abort: the assistant `message_end` has `stopReason:"aborted"`, then `agent_settled{aborted:true}`.
- A pending tool gets an error `toolResult` **(inferred)**.

---

## 4. Message types (for `get_messages`, `message_end`, `agent_end.messages`)

Message `timestamp` is **epoch ms**. Session entry `timestamp` is an ISO string. Consumers must tolerate unknown roles.

Content blocks:
- `{type:"text", text, textSignature?}`
- `{type:"image", data:<base64>, mimeType}`
- `{type:"thinking", thinking, thinkingSignature?, redacted?}`
- `{type:"toolCall", id, name, arguments, thoughtSignature?, namespace?}`

| role | Fields | Render |
|---|---|---|
| `system` | `content` (often `""`), `sections: {preamble, tools, rules, docs, skills, cwd, ...}`, `toolsAdded?`, `toolsRemoved?`, `timestamp` | **hide** (maybe a debug view) |
| `user` | `content: string \| (text\|image)[]`, `timestamp` | Live events and history use the array form even for plain prompts |
| `assistant` | `content: (text\|thinking\|toolCall)[]`, `api`, `provider`, `model`, `responseModel?`, `responseId?`, `thinkingLevel?`, `usage`, `stopReason`, `errorMessage?`, `rawStopReason?`, `durationMs?` *(live)*, `timestamp` | Text as markdown; thinking collapsible; toolCalls as cards joined to toolResults by id |
| `toolResult` | `toolCallId`, `toolName`, `content: (text\|image)[]`, `details?`, `usage?`, `nestedCalls?: {calls:[{id,name,arguments?,status,durationMs?,error?}],complete}`, `isError`, `durationMs?` *(live)*, `timestamp` | Attach to its toolCall card. `details` is as in §3.4 and **is persisted**, so edit diffs survive reload. |
| `bashExecution` | `command`, `output`, `exitCode \| undefined`, `cancelled`, `truncated`, `fullOutputPath?`, `excludeFromContext?`, `timestamp` | The user's `!cmd` block |
| `custom` | `customType`, `content`, `display: bool`, `details?`, `timestamp` | Show only if `display` is true; style it by `customType` |
| `branchSummary` | `summary`, `fromId`, `timestamp` | Divider: "summary of abandoned branch" |
| `compactionSummary` | `summary`, `tokensBefore`, `timestamp` | Divider: "context compacted (N tokens)" |

`Usage` = `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{input, output, cacheRead, cacheWrite, total}}`. `reasoning` is already included in `output`.

---

## 5. Extension UI subprotocol

Pi sends `{"type":"extension_ui_request","id":"<uuid>","method":...}`. **Only the four dialog methods expect an answer.** Implementation: `dist/modes/rpc/rpc-mode.js:51-228`.

| method | Extra fields | Response needed? | Response | If unanswered |
|---|---|---|---|---|
| `select` | `title`, `options: string[]`, `timeout?` (ms) | **yes** | `{"type":"extension_ui_response","id","value":"<option>"}` or `{..., "cancelled":true}` | With `timeout`: resolves `undefined` after it expires. **Without one: blocks forever.** |
| `confirm` | `title`, `message`, `timeout?` | **yes** | `{..., "confirmed":true\|false}` or `{..., "cancelled":true}` (= false) | Same; the default is `false` |
| `input` | `title`, `placeholder?`, `timeout?` | **yes** | `{..., "value":"text"}` or `cancelled` | Same; the default is `undefined` |
| `editor` | `title`, `prefill?` | **yes** | `{..., "value":"text"}` or `cancelled` | **There is no timeout support at all** (`:178-197`), so it blocks until answered |
| `notify` | `message`, `notifyType?: "info"\|"warning"\|"error"` (absent = info) | no | — | — |
| `setStatus` | `statusKey`, `statusText?` (**absent = clear**) | no | — | — |
| `setWidget` | `widgetKey`, `widgetLines?: string[]` (**absent = clear**), `widgetPlacement?: "aboveEditor"\|"belowEditor"` | no | — | Factory widgets are silently dropped |
| `setTitle` | `title` | no | — | — |
| `set_editor_text` | `text` | no | — | Replace the browser composer's content |

- Fire-and-forget requests also get a fresh UUID `id`; ignore it.
- A dialog can also resolve early with its default if the extension passes an `AbortSignal` that fires, e.g. when a run aborts.
- If you send a response with an unknown or already-resolved `id`, it is **silently ignored** (`:633-644`). No response record comes back for `extension_ui_response`.
- Pending dialogs **survive** `new_session` and `switch_session` (the map lives in the closure), but are never rejected on shutdown.
- **Bridge rule:** keep every pending dialog per session and re-send it to each browser that (re)connects. Only the first answer counts. Also keep the latest `setStatus` per `statusKey` and `setWidget` per `widgetKey`, and replay them on reconnect.

**Not available in RPC:** `custom()` returns `undefined`. `setFooter`, `setHeader`, `setWorkingMessage`/`Visible`/`Indicator`, `setHiddenThinkingLabel`, `addAutocompleteProvider` and `setEditorComponent` are no-ops. `getEditorText()` returns `""`. `setTheme` fails. `ctx.mode === "rpc"` and `ctx.hasUI === true`.

### 5.1 What the user's installed extensions actually send

Loaded per `~/.pi/agent/settings.json` packages and `~/.pi/agent/extensions/subagent`, which is a symlink to `~/Code/pi-dotfiles/pi/extensions/subagent`:

- **pi-powerline-footer** (`~/.pi/agent/npm/node_modules/pi-powerline-footer`):
  - At startup *(live)* it sends `setStatus{statusKey:"stash"}` (a clear) and 7× `setWidget` **clears**: `powerline-top`, `powerline-secondary`, `powerline-bash-transcript`, `powerline-status`, `powerline-pending-send`, `powerline-queue-preview`, `powerline-last-prompt`. Its real widgets are component factories, so they never reach RPC.
  - Possible later: `setStatus "stash"`, and `setTitle "pi - <dir>"` (from `/cd`).
  - Its commands use `notify`, `select`, `input`, `editor` and `setEditorText`.
  - Its `input` hook (auto follow-up) only acts on `source:"interactive"`. RPC prompts have `source:"rpc"`, so that hook never fires for you.
- **@kushagharahi/pi-llama-extensions** (`llama-cpp-tps`): after **every** assistant message it sends *(live)*:
  ```json
  {"type":"extension_ui_request","id":"…","method":"setStatus","statusKey":"llama-cpp-tps","statusText":"Out: ↓81.7 tok/s (600ms) | In: ↑921.2 tok/s (1.1s)"}
  {"type":"extension_ui_request","id":"…","method":"notify","message":"TPS: Out: ↓81.7 tok/s (600ms) | In: ↑921.2 tok/s (1.1s)"}
  ```
  Show the status in a footer, and **suppress or dedupe `notify` messages starting with `"TPS:"`**, or you get one toast per turn.
- **SoL-Pi** (`~/Code/SoL-Pi`): sends `entry_appended` with `customType:"sol-pi-online-context-state-v1"` on every model request *(live)*, which you should ignore. It may send `setStatus` with `"⚡ <mechanism> · <saving>"` and `notify`. Its `input` hook returns `continue` and never handles.
- **pi-web-access**:
  - Tools: `web_search` and others, 9 registered. Expect them in tool cards with custom `details`.
  - UI: `setWidget("web-activity", lines | undefined)` (string lines, so these **do** arrive), `notify`, and `select` inside its `/search`-style commands.
  - It also emits `entry_appended`, plus custom messages via `sendMessage`.
- **@sting8k/pi-vcc**: `notify`, the commands `/pi-vcc` and `/pi-vcc-recall`, one tool, and custom messages.
- **subagent** (`~/Code/pi-dotfiles/pi/extensions/subagent/index.ts`):
  - Tool `subagent` spawns `pi --mode json -p --no-session` children (`:300`).
  - It streams `tool_execution_update` with `details: {mode:"single"|"parallel"|"chain", agentScope, projectAgentsDir, results:[{agent, agentSource, task, exitCode (-1 = running), messages: Message[], stderr, usage:{input,output,cacheRead,cacheWrite,cost,contextTokens?,turns?}, model?, stopReason?, errorMessage?, step?}]}`. Render per-agent progress from `details.results`.
  - Its only dialog is `confirm("Run project-local agents?", "Agents: …\nSource: …\n\nProject agents are repo-controlled…")`. It is sent only when `agentScope` is `project` or `both`, `confirmProjectAgents` is not false, and the project is untrusted (`:520-548`). It has **no timeout**, so the tool call (and the whole run) **hangs until you answer**.

---

## 6. Permission and approval prompts

**Confirmed: Pi has no per-tool-call approval by default.** `docs/security.md:3`: "it does not ask for approval before every tool call". The built-in `bash`, `edit` and `write` tools execute immediately with the user's permissions; nothing in `rpc-mode.js` gates them. Approval exists only where an extension adds it, through a `tool_call` handler or a tool that calls `ui.confirm`, like subagent's project-agent check. Approvals then arrive as `extension_ui_request` dialogs.

**Project trust** is the only built-in prompt, and RPC cannot show it. If a folder has `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.agents/skills` and so on, then without `--approve`/`--no-approve`, an extension decision, or a saved decision in `~/.pi/agent/trust.json`, RPC follows `defaultProjectTrust` (default `"ask"`). In RPC, `"ask"` means **"skip project resources silently"**: the startup trust UI returns `false` when `hasUI` is false (`dist/cli/project-trust.js`). A warning may appear on stderr. If you want project-local extensions in the web UI, pass `--approve` deliberately per folder, or let the user save trust from the TUI with `/trust`.

---

## 7. Live probe

Script: `tools/pi_probe.py` (stdlib only).

```bash
python3 tools/pi_probe.py [--bash] [--prompt] [--edit] [--out records.jsonl] [--workdir DIR] [--model-timeout 60]
```

What it does:
- Starts `pi --mode rpc --no-session` in a fresh temp dir.
- Sends the read-only commands plus one unknown command and one malformed line.
- Auto-cancels any dialog.
- Redacts credential-like keys and truncates long strings and lists.
- Closes stdin and waits for exit (exit 0 within about 1 s when idle).

`--prompt` and `--edit` refuse to run unless the current model has `cost` 0 and a private or loopback `baseUrl`. They abort if no model output arrives within `--model-timeout`.

Runs performed (output in the scratchpad, not kept):
1. Default plus `--bash`: all commands answered. Cold start took 3.9 s to the first response; warm, 0.45 s.
2. `--prompt` against `local/qwen` @ 192.168.1.20:8082, which was cold: the assistant `message_start` arrived **51 s** after the prompt, the first token at 57 s, and the run settled at 58 s. That is just inside the 60 s budget. **Expect long cold starts from a local model server.** Show "waiting for model…" after the user message, and don't use short client timeouts.
3. `--prompt --edit` with the model warm: the full sequence in §3.1 plus the edit result in §3.4 took about 5 s.

No paid or cloud models were used. All configured models are LAN llama.cpp endpoints with zero cost.

---

## 8. Gotchas checklist

**Ordering**
- The `prompt` response arrives just **before** `agent_start` *(live)*. Subscribe before sending.
- The user `message_start/end` is emitted by Pi, so don't also render an optimistic copy without de-duplicating against it.
- `message_end`, then `tool_execution_*`, then the `toolResult` message, then `turn_end`. A follow-up's user message appears **after** `turn_start` + `queue_update`.
- Block `*_end` events may all arrive at once at stream end; `usage` is zero until then.
- `agent_end` is not "idle"; `agent_settled` is.
- After `new_session`, `switch_session`, `fork` or `clone`, the next events belong to the new session. Refresh `get_state` and `get_messages`.

**Things that silently fail or do nothing**
- Unknown `/command` text goes to the model as a prompt.
- TUI built-ins (`/model`, `/compact`, `/new`, `/tree`, `/settings`) don't run via `prompt`.
- `extension_ui_response` with a wrong `id` is ignored.
- Component-factory widgets and `ui.custom()` are dropped.
- Project resources are skipped without `--approve`.
- `set_thinking_level` may be a no-op server-side for llama.cpp models.
- The `undefined` fields `statusText`, `widgetLines` and `details` are **absent** on the wire. Treat "missing" as "clear" or "none".
- A parse error has no `id`.
- `abort` does not drop queued steer and follow-up messages; use `clear_queue` first.

**Blocking hazards**
- Dialogs without `timeout` (and every `editor`) block the extension, and therefore possibly the tool call and the run, until answered. The bridge must queue them and re-offer them across browser reconnects.
- An extension command's `prompt` response waits for its handler, dialogs included.
- Never use `--resume`, and never `--session <id>` for another project's session: both read stdin and write prompts to stdout, which breaks the protocol.

**Process lifecycle**
- To shut down, close stdin, wait (Pi disposes the runtime and waits for pending work), then SIGTERM, then a second signal (immediate exit), then SIGKILL. SIGTERM and stdin EOF together are fine (`docs/rpc.md` Shutdown; `rpc-mode.js:282-303,598-611`).
- An extension may call `ctx.shutdown()`, so the child can exit on its own. Treat any exit as "session process gone" and offer a respawn with `--session <file>`.
- Startup can fail with exit 1 for: no model available, a missing session cwd, or an extension load failure. Capture stderr for the user.
- `start_new_session=True` (setsid) keeps a terminal Ctrl+C from reaching children. Pi also kills tracked detached bash children on SIGTERM.
- One process per session file, and no concurrent writers. Spawning per session in the session's cwd is the clean model, and avoids `switch_session` tearing down runs.
- `--no-session` sessions vanish on exit. A persisted session's file appears only after the first prompt.
- Keep draining stdout even with no browser attached, or Pi stalls on backpressure. Buffer events for replay, or just re-sync with `get_messages` on reconnect.
