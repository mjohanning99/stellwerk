"""Stellwerk bridge: serves the web UI and relays a browser WebSocket to the
Hermes shared gateway (/api/ws, protocol hermes-gateway-v1).

Each browser connection gets its own single-use ticket from
`hermes gateway attach --json`, so the browser never sees a ticket and the
gateway itself stays bound to loopback. Frames are relayed verbatim.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import getpass
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import shutil
import socket
import sqlite3
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web, ClientSession, WSServerHandshakeError

from server import __version__, env
from server.pi import PiManager, ws_pi

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
WEB = ROOT / "web"
def _config_dir() -> Path:
    if env("CONFIG"):
        return Path(env("CONFIG"))
    new, old = Path.home() / ".config" / "stellwerk", Path.home() / ".config" / "hermes-web"
    # installs from before the rename keep their settings where they are
    return old if not new.exists() and (old / "config.json").exists() else new


CONFIG_DIR = _config_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"
COOKIE = "sw_session"
SESSION_TTL = 30 * 24 * 3600

log = logging.getLogger("stellwerk")


# ---------------------------------------------------------------- config / auth

def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text())
    except FileNotFoundError:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(CONFIG_FILE)
    global _cfg_mtime
    _cfg_mtime = CONFIG_FILE.stat().st_mtime_ns


_cfg_mtime: int | None = None   # mtime of config.json as this process last wrote or read it


def reload_if_changed(cfg: dict) -> bool:
    """Pick up edits made while running (e.g. `--set-password` from a shell), so the
    running server neither ignores them nor overwrites them on its next save."""
    global _cfg_mtime
    try:
        m = CONFIG_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        return False
    if m == _cfg_mtime:
        return False
    _cfg_mtime = m
    try:
        new = load_config()
    except (OSError, json.JSONDecodeError):
        return False
    if not new.get("secret"):
        return False
    cfg.clear()
    cfg.update(new)
    log.info("config.json changed on disk; reloaded")
    return True


def hash_password(pw: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt_b64, dk_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except ValueError:
        return False
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024)
    return hmac.compare_digest(dk, expected)


def make_token(secret: bytes, generation: int) -> str:
    exp = int(time.time()) + SESSION_TTL
    body = f"{exp}.{generation}.{secrets.token_hex(8)}"
    sig = hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_token(secret: bytes, generation: int, token: str | None) -> bool:
    if not token:
        return False
    try:
        exp, gen, nonce, sig = token.split(".")
    except ValueError:
        return False
    body = f"{exp}.{gen}.{nonce}"
    good = hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(good, sig) and int(gen) == generation and int(exp) > time.time()


class Auth:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.failures: dict[str, list[float]] = {}

    @property
    def generation(self) -> int:
        return int(self.cfg.get("session_generation", 0))

    @property
    def secret(self) -> bytes:
        return base64.b64decode(self.cfg["secret"])

    @property
    def password_set(self) -> bool:
        return bool(self.cfg.get("password"))

    def authed(self, request: web.Request) -> bool:
        if not self.password_set:
            # Open mode: no password, but only for host names that a web page
            # elsewhere cannot DNS-rebind to this machine.
            return host_allowed(request)
        return verify_token(self.secret, self.generation, request.cookies.get(COOKIE))

    def bump_generation(self) -> None:
        self.cfg["session_generation"] = self.generation + 1

    def throttled(self, ip: str) -> bool:
        now = time.time()
        recent = [t for t in self.failures.get(ip, []) if now - t < 600]
        self.failures[ip] = recent
        return len(recent) >= 8

    def fail(self, ip: str) -> None:
        self.failures.setdefault(ip, []).append(time.time())


def client_ip(request: web.Request) -> str:
    # tailscale serve proxies from loopback and sets X-Forwarded-For.
    fwd = request.headers.get("X-Forwarded-For")
    if fwd and request.remote in ("127.0.0.1", "::1"):
        return fwd.split(",")[0].strip()
    return request.remote or "?"


TRUSTED_PROXY_ORIGIN_SUFFIXES = tuple(
    s for s in env("PROXY_ORIGINS", ".ts.net").split(",") if s
)


def _host_name(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host[1:]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _machine_names() -> set[str]:
    names = {socket.gethostname().lower()}
    try:
        names.add(socket.getfqdn().lower())
    except OSError:
        pass
    names |= {n + ".local" for n in list(names) if "." not in n}
    extra = env("ALLOWED_HOSTS", "")
    names |= {h.strip().lower() for h in extra.split(",") if h.strip()}
    return names


MACHINE_NAMES = _machine_names()


def host_allowed(request: web.Request) -> bool:
    """Is the Host header an IP literal, localhost, this machine's name, a trusted
    proxy domain or an allowed host? This guards the password-less mode against
    DNS rebinding, where a page on evil.example resolves its own name to 127.0.0.1."""
    name = _host_name(request.host or "")
    if not name:
        return False
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    if name == "localhost" or name.endswith(".localhost") or name in MACHINE_NAMES:
        return True
    return any(name.endswith(sfx) for sfx in TRUSTED_PROXY_ORIGIN_SUFFIXES)


def is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def same_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return True  # non-browser client; cookie still required
    o_host = origin.split("://", 1)[-1]
    hosts = {request.host, request.headers.get("X-Forwarded-Host"), request.headers.get("Host")}
    if o_host in hosts:
        return True
    # Behind `tailscale serve` (which connects from loopback) the Host header may be
    # rewritten; accept the tailnet's https origin in that case only.
    if request.remote in ("127.0.0.1", "::1") and origin.startswith("https://"):
        name = o_host.split(":", 1)[0]
        return any(name.endswith(sfx) for sfx in TRUSTED_PROXY_ORIGIN_SUFFIXES)
    return False


# ---------------------------------------------------------------- backends

BACKENDS = {
    "hermes": {"label": "Hermes", "binary": "hermes"},
    "pi": {"label": "Pi", "binary": "pi"},
}


def _executable(path: str) -> str | None:
    p = Path(os.path.expanduser(path))
    if p.is_file() and os.access(p, os.X_OK):
        return str(p)
    return shutil.which(path)


def backend_command(cfg: dict, name: str) -> str | None:
    """The agent's executable: the configured command, else PATH, else ~/.local/bin."""
    conf = (cfg.get("backends") or {}).get(name) or {}
    if conf.get("command"):
        return _executable(conf["command"])
    binary = BACKENDS[name]["binary"]
    return shutil.which(binary) or _executable(str(Path.home() / ".local/bin" / binary))


def backend_state(cfg: dict, name: str) -> dict:
    conf = (cfg.get("backends") or {}).get(name) or {}
    path = backend_command(cfg, name)
    wanted = conf.get("enabled")
    if wanted is None:
        wanted = path is not None  # never configured: on if it's installed
    return {
        "label": BACKENDS[name]["label"],
        "enabled": bool(wanted and path),
        "wanted": bool(wanted),
        "available": path is not None,
        "path": path,
        "command": conf.get("command") or "",
    }


def backends_state(cfg: dict) -> dict:
    return {name: backend_state(cfg, name) for name in BACKENDS}


async def attach(hermes: str, start: bool = True) -> dict:
    args = [hermes, "gateway", "attach", "--json"] + (["--start"] if start else [])
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("hermes gateway attach timed out")
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError(f"hermes gateway attach failed: {err.decode(errors='replace')[-400:]}")
    if proc.returncode != 0 or data.get("state") != "ready":
        raise RuntimeError(f"gateway not ready: {data.get('state')} {data.get('reason_code') or ''} {data.get('detail') or ''}")
    return data


# ---------------------------------------------------------------- handlers

async def index(request: web.Request) -> web.StreamResponse:
    resp = web.FileResponse(WEB / "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def api_me(request: web.Request) -> web.Response:
    auth: Auth = request.app["auth"]
    if not auth.authed(request):
        if not auth.password_set:
            return web.json_response({"authed": False, "password_set": False, "error":
                f"{_host_name(request.host or '')} is not an allowed host name. Open this page by IP "
                "address, or add the name to STELLWERK_ALLOWED_HOSTS."})
        return web.json_response({"authed": False, "password_set": True})
    home = str(Path.home())
    code = Path.home() / "Code"
    return web.json_response({
        "authed": True, "home": home, "default_cwd": str(code if code.is_dir() else home),
        "password_set": auth.password_set, "backends": backends_state(auth.cfg),
        "version": __version__,
    })


def exposure(request: web.Request) -> list[str]:
    """Where the server can be reached from, besides this machine."""
    out = [h for h in request.app["listen"] if not is_loopback(h)]
    if request.headers.get("X-Forwarded-For") and request.remote in ("127.0.0.1", "::1"):
        out.append(f"a proxy ({request.headers.get('X-Forwarded-Host') or request.host})")
    return out


def settings_payload(request: web.Request) -> dict:
    auth: Auth = request.app["auth"]
    return {
        "password_set": auth.password_set,
        "backends": backends_state(auth.cfg),
        "exposed": exposure(request),
        "user": getpass.getuser(),
        "config_file": str(CONFIG_FILE),
        "version": __version__,
    }


async def close_stale_sockets(app: web.Application) -> None:
    """After a password change or a sign-out of other browsers, close every live
    socket whose cookie is no longer valid. Code 4401 makes the page check /api/me:
    the browser that made the change has a fresh cookie and simply reconnects."""
    auth: Auth = app["auth"]
    for ws, req in list(app["sockets"].items()):
        if not auth.authed(req):
            await ws.close(code=4401, message=b"signed out")


def issue_cookie(request: web.Request, resp: web.Response, auth: "Auth") -> None:
    secure = request.headers.get("X-Forwarded-Proto") == "https" or request.secure
    resp.set_cookie(COOKIE, make_token(auth.secret, auth.generation), max_age=SESSION_TTL,
                    httponly=True, samesite="Strict", secure=secure, path="/")


def settings_guard(request: web.Request) -> web.Response | None:
    if not request.app["auth"].authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    if request.method != "GET" and not same_origin(request):
        return web.json_response({"error": "bad origin"}, status=403)
    return None


async def read_json(request: web.Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


async def api_settings(request: web.Request) -> web.Response:
    if (bad := settings_guard(request)):
        return bad
    return web.json_response(settings_payload(request))


async def api_settings_backends(request: web.Request) -> web.Response:
    """{name, enabled?, command?}: turn a backend on or off, or point it at an executable."""
    if (bad := settings_guard(request)):
        return bad
    auth: Auth = request.app["auth"]
    body = await read_json(request)
    name = body.get("name")
    if name not in BACKENDS:
        return web.json_response({"error": "unknown backend"}, status=400)
    conf = dict(auth.cfg.get("backends", {}).get(name) or {})
    if "command" in body:
        cmd = str(body.get("command") or "").strip()
        if cmd and not _executable(cmd):
            return web.json_response({"error": f"{cmd} is not an executable file or a command on PATH"}, status=400)
        if cmd:
            conf["command"] = cmd
        else:
            conf.pop("command", None)
    if "enabled" in body:
        conf["enabled"] = bool(body["enabled"])
    auth.cfg.setdefault("backends", {})[name] = conf
    save_config(auth.cfg)
    log.info("backend %s: %s", name, conf)
    return web.json_response(settings_payload(request))


async def api_settings_password(request: web.Request) -> web.Response:
    """{current, new}: set, change or (with an empty `new`) remove the password.
    The current password is required whenever one is set. Every other browser is
    signed out, and this one gets a fresh cookie."""
    if (bad := settings_guard(request)):
        return bad
    auth: Auth = request.app["auth"]
    ip = client_ip(request)
    if auth.throttled(ip):
        return web.json_response({"error": "too many attempts, wait a few minutes"}, status=429)
    body = await read_json(request)
    loop = asyncio.get_running_loop()
    had = auth.password_set
    if had:
        ok = await loop.run_in_executor(None, check_password, str(body.get("current") or ""), auth.cfg["password"])
        if not ok:
            auth.fail(ip)
            await asyncio.sleep(1)
            return web.json_response({"error": "The current password is wrong."}, status=403)
    new = str(body.get("new") or "")
    if new:
        if len(new) < 8:
            return web.json_response({"error": "Use at least 8 characters."}, status=400)
        auth.cfg["password"] = await loop.run_in_executor(None, hash_password, new)
        log.info("password %s from %s", "changed" if had else "set", ip)
    elif had:
        auth.cfg.pop("password", None)
        log.warning("password removed from %s", ip)
    else:
        return web.json_response({"error": "Type a new password."}, status=400)
    auth.bump_generation()
    save_config(auth.cfg)
    await close_stale_sockets(request.app)
    resp = web.json_response(settings_payload(request))
    if auth.password_set:
        issue_cookie(request, resp, auth)
    else:
        resp.del_cookie(COOKIE, path="/")
    return resp


async def api_settings_revoke(request: web.Request) -> web.Response:
    """Sign out every other browser."""
    if (bad := settings_guard(request)):
        return bad
    auth: Auth = request.app["auth"]
    auth.bump_generation()
    save_config(auth.cfg)
    await close_stale_sockets(request.app)
    resp = web.json_response(settings_payload(request))
    if auth.password_set:
        issue_cookie(request, resp, auth)
    return resp


async def api_dirs(request: web.Request) -> web.Response:
    if not request.app["auth"].authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    from server.pi import list_dirs
    return web.json_response(list_dirs(request.query.get("path") or None))


UPLOADS = Path(env("UPLOADS", Path.home() / ".cache" / "stellwerk" / "uploads"))


async def api_upload(request: web.Request) -> web.Response:
    """Store an uploaded file so an agent can read it by path. Returns {path}."""
    if not request.app["auth"].authed(request) or not same_origin(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    reader = await request.multipart()
    part = await reader.next()
    if part is None or part.name != "file":
        return web.json_response({"error": "no file"}, status=400)
    name = Path(part.filename or "upload").name.replace("/", "_")[:120] or "upload"
    folder = UPLOADS / secrets.token_hex(6)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / name
    size = 0
    with dest.open("wb") as f:
        while chunk := await part.read_chunk(1 << 16):
            size += len(chunk)
            if size > 50 * 1024 * 1024:
                f.close(); dest.unlink(missing_ok=True)
                return web.json_response({"error": "file too large (50 MB max)"}, status=413)
            f.write(chunk)
    return web.json_response({"path": str(dest), "name": name, "size": size})


HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def hermes_search(q: str, limit: int = 60) -> list[dict]:
    """Search Hermes' session store (read-only) for q in titles and message text.
    The gateway only searches titles, so this reads Hermes' SQLite file directly;
    if its layout ever changes, the caller falls back to the gateway's title search."""
    from server.pi import make_snippet
    db = Path(env("HERMES_DB") or HERMES_HOME / "state.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
    try:
        like = "%" + q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        parent = dict(con.execute("SELECT id, parent_session_id FROM sessions"))

        def root(sid: str) -> str:   # the picker lists the first session of a compression chain
            seen = set()
            while parent.get(sid) and sid not in seen:
                seen.add(sid)
                sid = parent[sid]
            return sid

        hits: dict[str, str | None] = {}
        for (sid,) in con.execute("SELECT id FROM sessions WHERE LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'", (like,)):
            hits.setdefault(root(sid), None)
        for sid, content in con.execute(
                "SELECT session_id, content FROM messages WHERE role IN ('user', 'assistant') AND content IS NOT NULL"
                " AND LOWER(content) LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 2000", (like,)):
            r = root(sid)
            if hits.get(r) is None:
                text = str(content)
                hits[r] = make_snippet(text, text.lower().find(q.lower()), len(q))
        if not hits:
            return []
        ids = list(hits)
        marks = ",".join("?" * len(ids))
        rows = con.execute(
            f"SELECT id, title, cwd, message_count, started_at, last_activity_at, hidden FROM sessions WHERE id IN ({marks})", ids)
        out = [{"id": r[0], "title": r[1], "cwd": r[2], "message_count": r[3], "started_at": r[4],
                "last_active_at": r[5] or r[4], "snippet": hits[r[0]]} for r in rows if not r[6]]
        out.sort(key=lambda s: s["last_active_at"] or 0, reverse=True)
        return out[:limit]
    finally:
        con.close()


async def api_search_hermes(request: web.Request) -> web.Response:
    if not request.app["auth"].authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    q = (request.query.get("q") or "").strip()[:200]
    if not q:
        return web.json_response({"available": True, "sessions": []})
    try:
        res = await asyncio.get_running_loop().run_in_executor(None, hermes_search, q)
    except (sqlite3.Error, OSError) as e:
        log.warning("hermes search unavailable: %s", e)
        return web.json_response({"available": False, "sessions": []})
    return web.json_response({"available": True, "sessions": res})


async def api_usage(request: web.Request) -> web.Response:
    """All-time token usage for one backend (see server/usage.py)."""
    if not request.app["auth"].authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    from server import usage
    from server.pi import SESSIONS_DIR
    name = request.match_info["backend"]
    loop = asyncio.get_running_loop()
    try:
        if name == "hermes":
            db = Path(env("HERMES_DB") or HERMES_HOME / "state.db")
            res = await loop.run_in_executor(None, usage.hermes_usage, db)
        elif name == "pi":
            res = await loop.run_in_executor(None, usage.pi_usage, SESSIONS_DIR)
        else:
            return web.json_response({"error": "unknown backend"}, status=404)
    except (sqlite3.Error, OSError) as e:
        log.warning("usage for %s unavailable: %s", name, e)
        return web.json_response({"available": False, "error": str(e)})
    return web.json_response(res)


async def api_gitdiff(request: web.Request) -> web.Response:
    """git status + diff for a working folder (Pi's Changes drawer)."""
    if not request.app["auth"].authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    cwd = os.path.realpath(request.query.get("cwd") or "")
    if not os.path.isdir(cwd):
        return web.json_response({"error": "no such folder"}, status=400)

    async def git(*args):
        p = await asyncio.create_subprocess_exec("git", "-C", cwd, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(p.communicate(), 30)
        return p.returncode, out.decode(errors="replace"), err.decode(errors="replace")

    rc, top, _ = await git("rev-parse", "--show-toplevel")
    if rc != 0:
        return web.json_response({"git": False})
    _, status, _ = await git("status", "--short", "--branch")
    _, diff, _ = await git("diff", "HEAD", "--no-color", "--no-ext-diff")
    _, untracked, _ = await git("ls-files", "--others", "--exclude-standard")
    if len(diff) > 2_000_000:
        diff = diff[:2_000_000] + "\n… (truncated)"
    return web.json_response({"git": True, "root": top.strip(), "status": status, "diff": diff,
                              "untracked": [u for u in untracked.splitlines() if u][:200]})


async def api_login(request: web.Request) -> web.Response:
    auth: Auth = request.app["auth"]
    ip = client_ip(request)
    if not same_origin(request):
        return web.json_response({"error": "bad origin"}, status=403)
    if auth.throttled(ip):
        return web.json_response({"error": "too many attempts, wait a few minutes"}, status=429)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not auth.password_set:
        return web.json_response({"ok": True})
    pw = str(body.get("password", ""))
    ok = await asyncio.get_running_loop().run_in_executor(None, check_password, pw, auth.cfg["password"])
    if not ok:
        auth.fail(ip)
        await asyncio.sleep(1)
        log.warning("failed login from %s", ip)
        return web.json_response({"error": "wrong password"}, status=401)
    resp = web.json_response({"ok": True})
    issue_cookie(request, resp, auth)
    log.info("login from %s", ip)
    return resp


async def api_logout(request: web.Request) -> web.Response:
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE, path="/")
    return resp


async def ws_bridge(request: web.Request) -> web.StreamResponse:
    auth: Auth = request.app["auth"]
    if not auth.authed(request):
        return web.Response(status=401, text="unauthorized")
    if not same_origin(request):
        return web.Response(status=403, text="bad origin")

    hermes = backend_state(auth.cfg, "hermes")
    if not hermes["enabled"]:
        return web.Response(status=404, text="the Hermes backend is turned off")

    browser = web.WebSocketResponse(heartbeat=25, max_msg_size=64 * 1024 * 1024)
    await browser.prepare(request)

    try:
        info = await attach(hermes["path"], start=True)
    except Exception as e:  # tell the client why, then close
        log.error("attach failed: %s", e)
        await browser.send_json({"jsonrpc": "2.0", "method": "bridge.error", "params": {"message": str(e)}})
        await browser.close(code=1011, message=b"attach failed")
        return browser

    session: ClientSession = request.app["http"]
    try:
        upstream = await session.ws_connect(
            info["url"], protocols=info["protocols"], max_msg_size=64 * 1024 * 1024,
            heartbeat=None, autoping=True,
        )
    except (WSServerHandshakeError, OSError) as e:
        log.error("upstream connect failed: %s", e)
        await browser.send_json({"jsonrpc": "2.0", "method": "bridge.error", "params": {"message": f"connect failed: {e}"}})
        await browser.close(code=1011)
        return browser

    ep = info.get("endpoint") or {}
    await browser.send_json({"jsonrpc": "2.0", "method": "bridge.hello", "params": {
        "profile_id": ep.get("profile_id"), "instance_id": ep.get("instance_id"),
        "capabilities": ep.get("capabilities"), "code_sha": ep.get("code_sha"),
    }})
    request.app["sockets"][browser] = request
    if not auth.authed(request):  # signed out while the gateway attached
        request.app["sockets"].pop(browser, None)
        await upstream.close()
        await browser.close(code=4401, message=b"signed out")
        return browser
    log.info("bridge open for %s", client_ip(request))

    async def pump(src, dst, name):
        async for msg in src:
            if msg.type == WSMsgType.TEXT:
                await dst.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await dst.send_bytes(msg.data)
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
        log.debug("%s ended", name)

    tasks = [asyncio.create_task(pump(browser, upstream, "browser->gw")),
             asyncio.create_task(pump(upstream, browser, "gw->browser"))]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await upstream.close()
        request.app["sockets"].pop(browser, None)
        await browser.close()
        log.info("bridge closed for %s", client_ip(request))
    return browser


@web.middleware
async def config_watch(request: web.Request, handler):
    if reload_if_changed(request.app["auth"].cfg):
        await close_stale_sockets(request.app)
    return await handler(request)


@web.middleware
async def security_headers(request: web.Request, handler):
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; script-src 'self'; frame-ancestors 'none'",
    )
    return resp


async def on_startup(app: web.Application) -> None:
    app["http"] = ClientSession()
    app["pi"].start_reaper()


async def on_cleanup(app: web.Application) -> None:
    await app["pi"].shutdown()
    await app["http"].close()


def build_app(cfg: dict, listen: list[str] | None = None) -> web.Application:
    app = web.Application(middlewares=[config_watch, security_headers], client_max_size=64 * 1024 * 1024)
    app["auth"] = Auth(cfg)
    app["listen"] = listen or ["127.0.0.1"]
    app["sockets"] = {}  # live browser websockets -> the request that opened them
    app["same_origin"] = same_origin
    app["backend_state"] = lambda name: backend_state(cfg, name)
    app["pi"] = PiManager(lambda: backend_command(cfg, "pi"))
    app.router.add_get("/", index)
    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/dirs", api_dirs)
    app.router.add_get("/api/gitdiff", api_gitdiff)
    app.router.add_get("/api/search/hermes", api_search_hermes)
    app.router.add_get("/api/usage/{backend}", api_usage)
    app.router.add_post("/api/upload", api_upload)
    app.router.add_post("/api/login", api_login)
    app.router.add_post("/api/logout", api_logout)
    app.router.add_get("/api/settings", api_settings)
    app.router.add_post("/api/settings/backends", api_settings_backends)
    app.router.add_post("/api/settings/password", api_settings_password)
    app.router.add_post("/api/settings/revoke", api_settings_revoke)
    app.router.add_get("/ws", ws_bridge)
    app.router.add_get("/ws/pi", ws_pi)
    app.router.add_static("/static/", WEB, show_index=False)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


# ---------------------------------------------------------------- cli

def main() -> None:
    p = argparse.ArgumentParser(prog="stellwerk")
    p.add_argument("--host", default=env("HOST", "127.0.0.1"),
                   help="address(es) to listen on, comma-separated")
    p.add_argument("--port", type=int, default=int(env("PORT", "7777")))
    p.add_argument("--set-password", action="store_true", help="set the login password and exit")
    p.add_argument("--password-stdin", action="store_true", help="with --set-password: read it from stdin")
    p.add_argument("--clear-password", action="store_true", help="remove the password and exit")
    p.add_argument("--revoke-sessions", action="store_true", help="log out every browser and exit")
    p.add_argument("--version", action="version", version=f"stellwerk {__version__}")
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cfg = load_config()
    cfg.setdefault("secret", base64.b64encode(secrets.token_bytes(32)).decode())

    if a.set_password:
        pw = sys.stdin.readline().rstrip("\n") if a.password_stdin else getpass.getpass("New password: ")
        if len(pw) < 8:
            sys.exit("password must be at least 8 characters")
        cfg["password"] = hash_password(pw)
        cfg["session_generation"] = int(cfg.get("session_generation", 0)) + 1
        save_config(cfg)
        print(f"password saved to {CONFIG_FILE}; existing sessions logged out")
        return
    if a.clear_password:
        cfg.pop("password", None)
        cfg["session_generation"] = int(cfg.get("session_generation", 0)) + 1
        save_config(cfg)
        print("password removed: anyone who can reach the server can now use it")
        return
    if a.revoke_sessions:
        cfg["session_generation"] = int(cfg.get("session_generation", 0)) + 1
        save_config(cfg)
        print("all sessions revoked")
        return
    save_config(cfg)
    hosts = [h.strip() for h in a.host.split(",") if h.strip()]
    exposed = [h for h in hosts if not is_loopback(h)]
    if not cfg.get("password"):
        if exposed:
            log.warning("NO PASSWORD SET and listening on %s: anyone on that network can run commands "
                        "as %s. Set one in Settings or with --set-password.", ", ".join(exposed), getpass.getuser())
        else:
            log.info("no password set, so only this machine can connect; set one in Settings before exposing it")
    on = [n for n, st in backends_state(cfg).items() if st["enabled"]]
    log.info("Stellwerk %s on http://%s:%d (backends: %s)", __version__, hosts[0], a.port, ", ".join(on) or "none")
    web.run_app(build_app(cfg, hosts), host=hosts if len(hosts) > 1 else hosts[0], port=a.port,
                access_log=None, print=None)


if __name__ == "__main__":
    main()
