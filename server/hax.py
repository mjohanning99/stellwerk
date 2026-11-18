"""hax backend: runs `hax --json` one turn at a time and exposes it to browsers over /ws/hax.

hax (https://github.com/OleksandrChekhovskyi/hax) has no RPC mode, but its one-shot
`--json` stream and its session files share one documented, versioned record format
(docs/sessions.md): control records carry `type`, conversation items carry `kind`.
A turn is `hax --json [--resume=ID] [--provider/--model/--effort] ` with the prompt on
stdin; SIGINT interrupts (outcome `interrupted`, work saved), SIGUSR1 pauses after the
current step (outcome `paused`) so the next prompt steers. History comes from the
session file, which already holds everything the stream showed.

Browser <-> bridge protocol (JSON-RPC 2.0 over the websocket):

  requests from the browser
    hax.sessions   {limit?, offset?, query?}          -> {sessions:[...], next_offset}
    hax.open       {path}                             -> {header, items, selection, running, replay}
    hax.send       {path?|cwd, text, provider?, model?, effort?} -> {run}
    hax.interrupt  {run}  /  hax.pause {run}          -> {}
    hax.delete     {path}                             -> {trashed}
    hax.models     {}                                 -> {presets, current, efforts}
    hax.complete   {cwd, word}                        -> {items}   (@ path completion)

  notifications to the browser
    hax.event      {run, record}      every stdout record of a running turn
    hax.exit       {run, code, stderr, path}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import signal
from pathlib import Path

from aiohttp import WSMsgType, web

from server import env
from server.pi import complete_path, make_snippet

log = logging.getLogger("stellwerk.hax")

HOME = Path.home()
STATE = Path(os.environ.get("XDG_STATE_HOME") or HOME / ".local/state") / "hax"
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "hax"
SESSIONS_DIR = STATE / "sessions"
TRASH = Path(env("TRASH", HOME / ".cache/stellwerk/trash")) / "hax"
EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]   # hax src/effort.c


# ------------------------------------------------------------------ session files

def _records(path: Path):
    try:
        with path.open("rb") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue   # a crash can leave a partial last line
    except OSError:
        return


def read_session(path: Path) -> dict:
    """The live conversation of a session file: header, items with /undo applied, and the
    current provider/model/effort selection."""
    header, items, selection = None, [], None
    for r in _records(path):
        t = r.get("type")
        if t == "session":
            header = header or r
        elif t == "selection":
            selection = r
        elif t == "undo":
            keep = int(r.get("keep_user_turns") or 0)
            n = 0
            for i, it in enumerate(items):
                if it.get("kind") == "user" and not it.get("origin"):
                    n += 1
                    if n > keep:
                        # drop this prompt and the turn_boundary just before it
                        cut = i - 1 if i and items[i - 1].get("kind") == "turn_boundary" else i
                        items = items[:cut]
                        break
        elif r.get("kind"):
            items.append(r)
    sel = {k: (selection or header or {}).get(k) for k in ("provider", "model", "effort", "preset")}
    return {"header": header or {}, "items": items, "selection": sel}


_SUMMARIES: dict[str, tuple[float, int, dict | None]] = {}


def _summary(path: Path, st: os.stat_result) -> dict | None:
    hit = _SUMMARIES.get(str(path))
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    header, first, msgs = None, None, 0
    for r in _records(path):
        if r.get("type") == "session" and header is None:
            header = r
        elif r.get("kind") in ("user", "assistant") and not r.get("origin"):
            msgs += 1
            if first is None and r["kind"] == "user":
                first = (r.get("text") or "")[:200]
    s = None
    if header:
        s = {"path": str(path), "id": header.get("id"), "cwd": header.get("cwd"), "first": first, "messages": msgs,
             "model": header.get("model"), "provider": header.get("provider"), "mtime": st.st_mtime}
    _SUMMARIES[str(path)] = (st.st_mtime, st.st_size, s)
    return s


def _search(path: Path, needle: str) -> str | None:
    for r in _records(path):
        if r.get("kind") in ("user", "assistant"):
            text = r.get("text") or ""
            at = text.lower().find(needle)
            if at >= 0:
                return make_snippet(text, at, len(needle))
    return None


def list_sessions(limit: int = 40, offset: int = 0, query: str = "") -> dict:
    if not SESSIONS_DIR.is_dir():
        return {"sessions": [], "next_offset": None}
    stats = []
    for p in SESSIONS_DIR.glob("*/*.jsonl"):
        try:
            stats.append((p, p.stat()))
        except OSError:
            pass
    stats.sort(key=lambda x: x[1].st_mtime, reverse=True)
    q = query.strip().lower()
    out, want = [], offset + limit + 1
    for p, st in stats:
        s = _summary(p, st)
        if not s or not s["messages"]:
            continue
        if q:
            hay = f"{s.get('first') or ''} {s.get('cwd') or ''}".lower()
            snip = None if q in hay else _search(p, q)
            if q not in hay and snip is None:
                continue
            s = {**s, "snippet": snip}
        out.append(s)
        if len(out) >= want:
            break
    return {"sessions": out[offset:offset + limit], "next_offset": offset + limit if len(out) > offset + limit else None}


def session_path(sid: str) -> Path | None:
    for p in SESSIONS_DIR.glob(f"*/*_{sid}.jsonl"):
        return p
    return None


def _checked(path: str) -> Path:
    p = Path(os.path.realpath(path))
    if not str(p).startswith(str(SESSIONS_DIR.resolve()) + os.sep) or p.suffix != ".jsonl" or not p.is_file():
        raise ValueError("not a hax session file")
    return p


def models() -> dict:
    """Presets from hax's config.json and the remembered selection from state.json."""
    presets, current = [], {}
    try:
        cfg = json.loads((CONFIG / "config.json").read_text())
        for name, p in (cfg.get("presets") or {}).items():
            if isinstance(p, dict) and p.get("model"):
                presets.append({"name": name, "provider": p.get("provider") or cfg.get("provider"), "model": p["model"],
                                "effort": p.get("effort"), "description": p.get("description")})
        current = {k: cfg.get(k) for k in ("provider", "model", "effort") if cfg.get(k)}
    except (OSError, ValueError):
        pass
    try:
        st = json.loads((STATE / "state.json").read_text())
        current.update({k: st.get(k) for k in ("provider", "model", "effort") if st.get(k)})
    except (OSError, ValueError):
        pass
    return {"presets": presets, "current": current, "efforts": EFFORTS}


# ------------------------------------------------------------------ runs

class HaxRun:
    """One `hax --json` process: one user turn."""

    def __init__(self, manager: "HaxManager", cwd: str, path: str | None):
        self.manager = manager
        self.id = "run_" + secrets.token_hex(6)
        self.cwd = cwd
        self.path = path              # session file; known after the header for a new session
        self.proc: asyncio.subprocess.Process | None = None
        self.records: list[dict] = []
        self.subscribers: set[web.WebSocketResponse] = set()
        self.stderr = ""
        self.done = False

    async def start(self, text: str, sid: str | None, flags: dict) -> None:
        hax = self.manager.command()
        if not hax:
            raise RuntimeError("hax was not found; set its path in Settings")
        args = [hax, "--json"]
        if sid:
            args.append(f"--resume={sid}")
        for k in ("provider", "model", "effort"):
            if flags.get(k):
                args.append(f"--{k}={flags[k]}")
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=self.cwd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=64 * 1024 * 1024, start_new_session=True)
        self.proc.stdin.write(text.encode())
        await self.proc.stdin.drain()
        self.proc.stdin.close()
        asyncio.create_task(self._pump())
        log.info("hax %s started in %s (resume=%s)", self.id, self.cwd, sid)

    async def _pump(self) -> None:
        assert self.proc and self.proc.stdout and self.proc.stderr
        err_task = asyncio.create_task(self.proc.stderr.read())
        async for line in self.proc.stdout:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") == "session" and rec.get("id") and not self.path:
                p = session_path(rec["id"])
                self.path = str(p) if p else None
            self.records.append(rec)
            await self._broadcast({"jsonrpc": "2.0", "method": "hax.event", "params": {"run": self.id, "path": self.path, "record": rec}})
        code = await self.proc.wait()
        self.stderr = (await err_task).decode(errors="replace")[-2000:]
        if not self.path:
            sid = next((r.get("session_id") for r in self.records if r.get("type") == "result"), None)
            p = session_path(sid) if sid else None
            self.path = str(p) if p else None
        self.done = True
        await self._broadcast({"jsonrpc": "2.0", "method": "hax.exit", "params": {"run": self.id, "code": code, "stderr": self.stderr, "path": self.path}})
        self.manager.forget(self)
        log.info("hax %s exited %s", self.id, code)

    async def _broadcast(self, frame: dict) -> None:
        for ws in list(self.subscribers):
            try:
                await ws.send_json(frame)
            except Exception:
                self.subscribers.discard(ws)

    def signal(self, sig: int) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.send_signal(sig)


class HaxManager:
    def __init__(self, command=lambda: shutil.which("hax")):
        self.command = command
        self.runs: dict[str, HaxRun] = {}

    def forget(self, run: HaxRun) -> None:
        self.runs.pop(run.id, None)

    def running_for(self, path: str | None) -> HaxRun | None:
        if not path:
            return None
        rp = os.path.realpath(path)
        return next((r for r in self.runs.values() if r.path and os.path.realpath(r.path) == rp and not r.done), None)

    async def send(self, path: str | None, cwd: str | None, text: str, flags: dict) -> HaxRun:
        sid = None
        if path:
            p = _checked(path)
            if self.running_for(str(p)):
                raise RuntimeError("a turn is already running in this session")
            data = read_session(p)
            sid = data["header"].get("id")
            cwd = data["header"].get("cwd") or cwd
        cwd = os.path.realpath(os.path.expanduser(cwd or str(HOME)))
        if not os.path.isdir(cwd):
            raise ValueError(f"the session's folder no longer exists: {cwd}")
        run = HaxRun(self, cwd, str(_checked(path)) if path else None)
        self.runs[run.id] = run
        try:
            await run.start(text, sid, flags)
        except Exception:
            self.forget(run)
            raise
        return run

    async def delete(self, path: str) -> str:
        p = _checked(path)
        run = self.running_for(str(p))
        if run:
            run.signal(signal.SIGINT)
        TRASH.mkdir(parents=True, exist_ok=True)
        dest = TRASH / f"{p.parent.name}__{p.name}"
        shutil.move(str(p), dest)
        log.info("hax session %s moved to %s", p, dest)
        return str(dest)

    async def shutdown(self) -> None:
        for r in list(self.runs.values()):
            r.signal(signal.SIGINT)


# ------------------------------------------------------------------ websocket

async def ws_hax(request: web.Request) -> web.StreamResponse:
    if not request.app["auth"].authed(request):
        return web.Response(status=401, text="unauthorized")
    if not request.app["same_origin"](request):
        return web.Response(status=403, text="bad origin")
    if not request.app["backend_state"]("hax")["enabled"]:
        return web.Response(status=404, text="the hax backend is turned off")
    mgr: HaxManager = request.app["hax"]
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    request.app["sockets"][ws] = request
    await ws.send_json({"jsonrpc": "2.0", "method": "bridge.hello", "params": {"backend": "hax", "home": str(HOME)}})
    loop = asyncio.get_running_loop()

    async def handle(f: dict) -> None:
        rid, method, params = f.get("id"), f.get("method"), f.get("params") or {}

        def reply(result=None, error=None):
            frame = {"jsonrpc": "2.0", "id": rid}
            if error is not None:
                frame["error"] = {"code": -32000, "message": str(error)}
            else:
                frame["result"] = result if result is not None else {}
            return ws.send_json(frame)

        try:
            if method == "hax.sessions":
                res = await loop.run_in_executor(None, list_sessions, min(int(params.get("limit", 40)), 500),
                                                 max(int(params.get("offset", 0)), 0), str(params.get("query") or "")[:200])
                for s in res["sessions"]:
                    s["streaming"] = bool(mgr.running_for(s["path"]))
                await reply(res)
            elif method == "hax.open":
                p = _checked(params.get("path") or "")
                data = await loop.run_in_executor(None, read_session, p)
                run = mgr.running_for(str(p))
                if run:
                    run.subscribers.add(ws)
                await reply({**data, "running": run.id if run else None, "replay": run.records if run else []})
            elif method == "hax.send":
                flags = {k: params.get(k) for k in ("provider", "model", "effort") if params.get(k)}
                run = await mgr.send(params.get("path"), params.get("cwd"), str(params.get("text") or ""), flags)
                run.subscribers.add(ws)
                await reply({"run": run.id})
            elif method in ("hax.interrupt", "hax.pause"):
                run = mgr.runs.get(params.get("run"))
                if run:
                    run.signal(signal.SIGINT if method == "hax.interrupt" else signal.SIGUSR1)
                await reply({})
            elif method == "hax.delete":
                await reply({"trashed": await mgr.delete(params.get("path") or "")})
            elif method == "hax.models":
                await reply(await loop.run_in_executor(None, models))
            elif method == "hax.complete":
                await reply(complete_path(params.get("cwd") or str(HOME), params.get("word") or ""))
            else:
                await ws.send_json({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}})
        except Exception as e:
            log.warning("hax ws %s failed: %s", method, e)
            await reply(error=e)

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                f = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            asyncio.create_task(handle(f))
    finally:
        request.app["sockets"].pop(ws, None)
        for r in mgr.runs.values():
            r.subscribers.discard(ws)
    return ws
