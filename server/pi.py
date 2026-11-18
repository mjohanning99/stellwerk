"""Pi backend: owns long-lived `pi --mode rpc` child processes and exposes them
to browsers over /ws/pi.

Browser <-> bridge protocol (JSON-RPC 2.0 over the websocket):

  requests from the browser
    pi.sessions        {cwd?, limit?, offset?, query?} -> {sessions:[...], next_offset}
    pi.dirs            {path?}                   -> {path, dirs:[...], home}
    pi.open            {session_path?|new:true, cwd}  -> {handle, state, replay:[records], open_ui:[records]}
    pi.close           {handle}                  -> {}           (stops the process)
    pi.delete          {session_path}            -> {trashed}    (stops it, moves the file to the trash folder)
    pi.detach          {handle}                  -> {}           (keeps it running)
    pi.cmd             {handle, command:{type,...}} -> pi's response record (data / error)
    pi.ui_response     {handle, id, ...fields}   -> {}           (answers extension_ui_request)
    pi.live            {}                        -> {live:[{handle, cwd, session_file, streaming}]}

  notifications to the browser
    pi.event           {handle, record}          (every stdout record that is not a response)
    pi.exit            {handle, code, stderr}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from server import env, missing_folder

log = logging.getLogger("stellwerk.pi")

HOME = Path.home()
SESSIONS_DIR = Path(os.environ.get("PI_SESSIONS_DIR", HOME / ".pi/agent/sessions"))
TRASH = Path(env("TRASH", HOME / ".cache/stellwerk/trash/pi"))
IDLE_TIMEOUT = 30 * 60
REPLAY_MAX = 5000


class PiProcess:
    def __init__(self, manager: "PiManager", cwd: str, session_path: str | None):
        self.manager = manager
        self.handle = "pi_" + secrets.token_hex(6)
        self.cwd = cwd
        self.session_path = session_path
        self.proc: asyncio.subprocess.Process | None = None
        self.subscribers: set[web.WebSocketResponse] = set()
        self.pending: dict[str, asyncio.Future] = {}
        self.replay: list[dict] = []          # records of the current/last run
        self.open_ui: dict[str, dict] = {}    # extension_ui_request id -> record
        self.status: dict[str, dict] = {}     # statusKey -> latest setStatus record
        self.widgets: dict[str, dict] = {}    # widgetKey -> latest setWidget record
        self.streaming = False
        self.last_active = time.time()
        self.stderr_tail: list[str] = []
        self.session_file: str | None = session_path
        self.exited = False

    async def start(self) -> None:
        pi = self.manager.command()
        if not pi:
            raise RuntimeError("pi was not found; set its path in Settings")
        args = [pi, "--mode", "rpc"]
        if self.session_path:
            args += ["--session", self.session_path]
        env = dict(os.environ)
        env.setdefault("TERM", "dumb")
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=self.cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024, start_new_session=True,
        )
        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())
        asyncio.create_task(self._wait())
        log.info("pi %s started in %s (session=%s)", self.handle, self.cwd, self.session_path)

    async def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        buf = b""
        while True:
            chunk = await self.proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            # strict LF framing (do not split on U+2028/2029)
            while (i := buf.find(b"\n")) >= 0:
                line, buf = buf[:i].rstrip(b"\r"), buf[i + 1:]
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    log.warning("pi %s: bad line %r", self.handle, line[:200])
                    continue
                self._on_record(rec)

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        async for line in self.proc.stderr:
            s = line.decode(errors="replace").rstrip()
            self.stderr_tail = (self.stderr_tail + [s])[-50:]

    async def _wait(self) -> None:
        assert self.proc
        code = await self.proc.wait()
        self.exited = True
        self.streaming = False
        for f in self.pending.values():
            if not f.done():
                f.set_exception(RuntimeError("pi exited"))
        log.info("pi %s exited with %s", self.handle, code)
        await self._broadcast({"jsonrpc": "2.0", "method": "pi.exit",
                               "params": {"handle": self.handle, "code": code, "stderr": "\n".join(self.stderr_tail[-15:])}})
        self.manager.forget(self)

    def _on_record(self, rec: dict) -> None:
        self.last_active = time.time()
        t = rec.get("type")
        if t == "response":
            rid = rec.get("id")
            f = self.pending.pop(rid, None) if rid else None
            if f and not f.done():
                f.set_result(rec)
            # remember the session file once pi tells us
            data = rec.get("data") or {}
            if isinstance(data, dict):
                sf = data.get("sessionFile") or data.get("session_file")
                if sf:
                    self.session_file = sf
            return
        if t == "agent_start":
            self.streaming = True
            self.replay = []
        elif t == "agent_settled":
            self.streaming = False
        elif t == "extension_ui_request":
            rid, m = rec.get("id"), rec.get("method")
            if rid and m in ("select", "confirm", "input", "editor"):
                self.open_ui[rid] = rec
            elif m == "setStatus" and rec.get("statusKey"):
                self.status[rec["statusKey"]] = rec
            elif m == "setWidget" and rec.get("widgetKey"):
                self.widgets[rec["widgetKey"]] = rec
        self.replay.append(rec)
        if len(self.replay) > REPLAY_MAX:
            self.replay = self.replay[-REPLAY_MAX:]
        asyncio.create_task(self._broadcast({"jsonrpc": "2.0", "method": "pi.event",
                                             "params": {"handle": self.handle, "record": rec}}))

    async def _broadcast(self, frame: dict) -> None:
        data = json.dumps(frame)
        for ws in list(self.subscribers):
            try:
                await ws.send_str(data)
            except Exception:
                self.subscribers.discard(ws)

    async def write(self, obj: dict) -> None:
        if not self.proc or self.exited or not self.proc.stdin:
            raise RuntimeError("pi is not running")
        self.proc.stdin.write(json.dumps(obj).encode() + b"\n")
        await self.proc.stdin.drain()
        self.last_active = time.time()

    async def command(self, cmd: dict, timeout: float = 120) -> dict:
        rid = "hw_" + secrets.token_hex(6)
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        await self.write({**cmd, "id": rid})
        try:
            rec = await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(rid, None)
        rec = dict(rec)
        rec.pop("id", None)
        return rec

    async def ui_response(self, rid: str, fields: dict) -> None:
        self.open_ui.pop(rid, None)
        await self.write({"type": "extension_ui_response", "id": rid, **fields})
        # tell other tabs the dialog is gone
        await self._broadcast({"jsonrpc": "2.0", "method": "pi.event",
                               "params": {"handle": self.handle, "record": {"type": "hw_ui_answered", "id": rid}}})

    async def stop(self) -> None:
        if self.proc and not self.exited:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), 10)
            except asyncio.TimeoutError:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), 5)
                except asyncio.TimeoutError:
                    self.proc.kill()


class PiManager:
    def __init__(self, command=lambda: shutil.which("pi")):
        self.command = command          # () -> path of the pi executable, or None
        self.procs: dict[str, PiProcess] = {}
        self._reaper: asyncio.Task | None = None

    def start_reaper(self) -> None:
        self._reaper = asyncio.create_task(self._reap())

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for p in list(self.procs.values()):
                if not p.subscribers and not p.streaming and not p.open_ui and now - p.last_active > IDLE_TIMEOUT:
                    log.info("pi %s idle, stopping", p.handle)
                    await p.stop()

    def forget(self, p: PiProcess) -> None:
        self.procs.pop(p.handle, None)

    def find_by_session(self, path: str) -> PiProcess | None:
        rp = os.path.realpath(path)
        for p in self.procs.values():
            if p.session_file and os.path.realpath(p.session_file) == rp:
                return p
        return None

    async def open(self, session_path: str | None, cwd: str) -> PiProcess:
        if session_path:
            existing = self.find_by_session(session_path)
            if existing and not existing.exited:
                return existing
        if session_path:
            session_path = os.path.realpath(session_path)
            if not session_path.startswith(str(SESSIONS_DIR.resolve()) + os.sep) or not session_path.endswith(".jsonl"):
                raise ValueError("not a pi session file")
            if not os.path.isfile(session_path):
                raise ValueError("session file not found")
            header = _read_header(Path(session_path))
            cwd = (header or {}).get("cwd") or cwd
            if not cwd or not os.path.isdir(cwd):
                raise ValueError(missing_folder(cwd))
        cwd = os.path.realpath(os.path.expanduser(cwd or str(HOME)))
        if not os.path.isdir(cwd):
            raise ValueError(f"not a directory: {cwd}")
        p = PiProcess(self, cwd, session_path)
        await p.start()
        self.procs[p.handle] = p
        return p

    async def delete(self, session_path: str) -> str:
        """Stop the session's process, if any, and move its file to the trash folder."""
        path = os.path.realpath(session_path)
        if not path.startswith(str(SESSIONS_DIR.resolve()) + os.sep) or not path.endswith(".jsonl"):
            raise ValueError("not a pi session file")
        if not os.path.isfile(path):
            raise ValueError("session file not found")
        live = self.find_by_session(path)
        if live:
            await live.stop()
        TRASH.mkdir(parents=True, exist_ok=True)
        dest = TRASH / f"{Path(path).parent.name}{Path(path).name}"
        shutil.move(path, dest)
        log.info("pi session %s moved to %s", path, dest)
        return str(dest)

    async def shutdown(self) -> None:
        if self._reaper:
            self._reaper.cancel()
        await asyncio.gather(*(p.stop() for p in list(self.procs.values())), return_exceptions=True)


# ------------------------------------------------------------- session files

def _read_header(path: Path) -> dict | None:
    try:
        with path.open("rb") as f:
            h = json.loads(f.readline())
        return h if h.get("type") == "session" else None
    except (OSError, json.JSONDecodeError):
        return None


def _read_session_summary(path: Path) -> dict | None:
    """Cheap summary of a pi session JSONL file: header + name + first user text."""
    try:
        st = path.stat()
        info = {"path": str(path), "mtime": st.st_mtime, "size": st.st_size,
                "id": None, "cwd": None, "name": None, "first": None, "created": None, "messages": 0}
        with path.open("rb") as f:
            for i, line in enumerate(f):
                if i > 4000:
                    break
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = e.get("type")
                if i == 0 and t != "session":
                    return None
                if t == "session":
                    info["id"] = e.get("id")
                    info["cwd"] = e.get("cwd")
                    info["created"] = e.get("timestamp")
                elif t == "session_info":
                    info["name"] = (e.get("name") or "").strip() or None
                elif t == "message":
                    info["messages"] += 1
                    m = e.get("message") or {}
                    if m.get("role") in ("user", "assistant") and isinstance(m.get("timestamp"), (int, float)):
                        info["modified"] = max(info.get("modified") or 0, m["timestamp"] / 1000)
                    if info["first"] is None and m.get("role") == "user":
                        c = m.get("content")
                        if isinstance(c, str):
                            info["first"] = c[:200]
                        elif isinstance(c, list):
                            txt = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                            info["first"] = txt[:200]
        return info
    except OSError:
        return None


_SUMMARIES: dict[str, tuple[float, int, dict | None]] = {}   # path -> (mtime, size, summary)


def _summary_cached(path: Path, st: os.stat_result) -> dict | None:
    """Summaries are re-read only when a file's size or mtime changes."""
    hit = _SUMMARIES.get(str(path))
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    s = _read_session_summary(path)
    _SUMMARIES[str(path)] = (st.st_mtime, st.st_size, s)
    return s


def make_snippet(text: str, at: int, n: int, before: int = 60, after: int = 120) -> str:
    start, end = max(0, at - before), min(len(text), at + n + after)
    s = " ".join(text[start:end].split())
    return ("…" if start > 0 else "") + s + ("…" if end < len(text) else "")


def _message_texts(path: Path):
    """The user/assistant text of a session file, one string per message."""
    try:
        with path.open("rb") as f:
            for line in f:
                if b'"message"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                m = e.get("message") or {}
                if e.get("type") != "message" or m.get("role") not in ("user", "assistant"):
                    continue
                c = m.get("content")
                if isinstance(c, str):
                    yield c
                elif isinstance(c, list):
                    yield " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    except OSError:
        return


def _search_file(path: Path, needle: str) -> str | None:
    for text in _message_texts(path):
        at = text.lower().find(needle)
        if at >= 0:
            return make_snippet(text, at, len(needle))
    return None


def list_sessions(cwd: str | None = None, limit: int = 50, offset: int = 0, query: str | None = None) -> dict:
    """A page of sessions, newest first. With a query, sessions whose name, first message,
    folder or any message text contains it (case-insensitive), each with a snippet."""
    if not SESSIONS_DIR.is_dir():
        return {"sessions": [], "next_offset": None}
    stats = []
    for p in SESSIONS_DIR.glob("*/*.jsonl"):
        try:
            stats.append((p, p.stat()))
        except OSError:
            pass
    stats.sort(key=lambda x: x[1].st_mtime, reverse=True)
    live = {str(p) for p, _ in stats}
    for k in [k for k in _SUMMARIES if k not in live]:
        del _SUMMARIES[k]
    q = (query or "").strip().lower()
    want = offset + limit + 1
    out: list[dict] = []
    for p, st in stats:
        s = _summary_cached(p, st)
        if not s:
            continue
        if cwd and s.get("cwd") and os.path.realpath(s["cwd"]) != os.path.realpath(cwd):
            continue
        if q:
            hay = f"{s.get('name') or ''} {s.get('first') or ''} {s.get('cwd') or ''}".lower()
            snip = None if q in hay else _search_file(p, q)
            if q not in hay and snip is None:
                continue
            s = {**s, "snippet": snip}
        out.append(s)
        if len(out) >= want:
            break
    return {"sessions": out[offset:offset + limit], "next_offset": offset + limit if len(out) > offset + limit else None}


def list_dirs(path: str | None) -> dict:
    base = Path(os.path.expanduser(path or str(HOME / "Code"))).resolve()
    if not base.is_dir():
        base = HOME
    dirs = []
    try:
        for e in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if e.is_dir() and not e.name.startswith("."):
                dirs.append({"name": e.name, "path": str(e), "git": (e / ".git").exists()})
    except PermissionError:
        pass
    return {"path": str(base), "parent": str(base.parent), "dirs": dirs, "home": str(HOME)}


def complete_path(cwd: str, word: str, limit: int = 60) -> dict:
    """Complete a path fragment relative to cwd (for @mentions)."""
    base = Path(os.path.expanduser(cwd))
    w = os.path.expanduser(word)
    d, _, frag = w.rpartition("/")
    folder = (Path(d) if os.path.isabs(d) else base / d) if d or w.startswith("/") else base
    if w.startswith("/") and not d:
        folder = Path("/")
    items = []
    try:
        for e in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if e.name.startswith(".") and not frag.startswith("."):
                continue
            if e.name in ("node_modules", "__pycache__", ".git"):
                continue
            if not e.name.lower().startswith(frag.lower()):
                continue
            text = (d + "/" if d or w.startswith("/") else "") + e.name + ("/" if e.is_dir() else "")
            items.append({"text": text, "display": text, "kind": "dir" if e.is_dir() else "file"})
            if len(items) >= limit:
                break
    except OSError:
        pass
    return {"items": items}


# ------------------------------------------------------------- websocket

async def ws_pi(request: web.Request) -> web.StreamResponse:
    if not request.app["auth"].authed(request):
        return web.Response(status=401, text="unauthorized")
    if not request.app["same_origin"](request):
        return web.Response(status=403, text="bad origin")
    if not request.app["backend_state"]("pi")["enabled"]:
        return web.Response(status=404, text="the Pi backend is turned off")
    mgr: PiManager = request.app["pi"]
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    request.app["sockets"][ws] = request
    await ws.send_json({"jsonrpc": "2.0", "method": "bridge.hello", "params": {"backend": "pi", "home": str(HOME)}})
    mine: set[PiProcess] = set()

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
            if method == "pi.sessions":
                loop = asyncio.get_running_loop()
                res = await loop.run_in_executor(None, list_sessions, params.get("cwd"), min(int(params.get("limit", 50)), 500),
                                                 max(int(params.get("offset", 0)), 0), str(params.get("query") or "")[:200])
                live = {os.path.realpath(p.session_file): p for p in mgr.procs.values() if p.session_file}
                for s in res["sessions"]:
                    p = live.get(os.path.realpath(s["path"]))
                    s["live"] = bool(p)
                    s["streaming"] = bool(p and p.streaming)
                await reply(res)
            elif method == "pi.delete":
                await reply({"trashed": await mgr.delete(params.get("session_path") or "")})
            elif method == "pi.dirs":
                await reply(list_dirs(params.get("path")))
            elif method == "pi.complete":
                await reply(complete_path(params.get("cwd") or str(HOME), params.get("word") or ""))
            elif method == "pi.live":
                await reply({"live": [{"handle": p.handle, "cwd": p.cwd, "session_file": p.session_file,
                                       "streaming": p.streaming} for p in mgr.procs.values()]})
            elif method == "pi.open":
                p = await mgr.open(None if params.get("new") else params.get("session_path"), params.get("cwd") or "")
                p.subscribers.add(ws)
                mine.add(p)
                state = None
                try:
                    state = (await p.command({"type": "get_state"}, timeout=60)).get("data")
                except Exception as e:
                    log.warning("get_state failed: %s", e)
                await reply({"handle": p.handle, "cwd": p.cwd, "state": state,
                             "replay": p.replay if p.streaming else [],
                             "open_ui": list(p.open_ui.values()),
                             "status": list(p.status.values()), "widgets": list(p.widgets.values()),
                             "streaming": p.streaming})
            elif method in ("pi.detach", "pi.close"):
                p = mgr.procs.get(params.get("handle"))
                if p:
                    p.subscribers.discard(ws)
                    mine.discard(p)
                    if method == "pi.close":
                        await p.stop()
                await reply({})
            elif method == "pi.cmd":
                p = mgr.procs.get(params.get("handle"))
                if not p:
                    raise RuntimeError("session is not running (reopen it)")
                cmd = params.get("command") or {}
                if not isinstance(cmd, dict) or not cmd.get("type"):
                    raise ValueError("command.type required")
                rec = await p.command(cmd, timeout=float(params.get("timeout", 600)))
                await reply(rec)
            elif method == "pi.ui_response":
                p = mgr.procs.get(params.get("handle"))
                if not p:
                    raise RuntimeError("session is not running")
                fields = {k: v for k, v in params.items() if k not in ("handle", "id")}
                await p.ui_response(params.get("id"), fields)
                await reply({})
            else:
                await ws.send_json({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}})
        except Exception as e:
            log.warning("pi ws %s failed: %s", method, e)
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
        for p in mine:
            p.subscribers.discard(ws)
    return ws
