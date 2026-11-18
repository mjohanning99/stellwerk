#!/usr/bin/env python3
"""Read-only probe of the Hermes shared gateway (hermes-gateway-v1).

Runs `hermes gateway attach --json` (discover only, never --start), dials the
WebSocket with the returned subprotocols, waits for gateway.ready, sends
client.capabilities, then calls a fixed list of READ-ONLY methods and prints
truncated frames. Never prints the ticket, never calls prompt.submit /
session.create / session.mutate or anything else that changes state.

Run it with a Python that has `websockets` (Hermes' own venv under
~/.hermes/installs/<...>/venv has it):
  <python> tools/probe.py [--raw]
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys

import websockets

HERMES = shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")
MAXSTR = 160      # truncate long strings
MAXLIST = 3       # keep at most N items of lists
SECRET_KEYS = {"ticket", "protocols", "api_key", "token", "secret", "password", "authorization"}

# (method, params). Strictly read-only.
CALLS = [
    ("runtime.describe", {}),
    ("ping", {}),
    ("commands.catalog", {}),
    ("session.list", {"picker": True, "limit": 3}),
    ("session.list", {"scope": "stored", "picker": True, "limit": 2}),
    ("model.options", {}),
    ("config.get", {"key": "reasoning"}),
    ("complete.slash", {"text": "/mo"}),
    ("complete.path", {"word": "./"}),
]


def trim(v, depth=0):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k.lower() in SECRET_KEYS or "ticket" in k.lower():
                out[k] = "<redacted>"
            else:
                out[k] = trim(x, depth + 1)
        return out
    if isinstance(v, list):
        # Short lists of scalars (capabilities, sources) are shown whole.
        cap = 40 if all(isinstance(x, (str, int, float, bool)) for x in v) and MAXLIST < 40 else MAXLIST
        items = [trim(x, depth + 1) for x in v[:cap]]
        if len(v) > cap:
            items.append(f"... (+{len(v) - cap} more)")
        return items
    if isinstance(v, str):
        if "hermes-gateway-ticket." in v:
            return "<redacted>"
        return v if len(v) <= MAXSTR else v[:MAXSTR] + f"...(+{len(v) - MAXSTR})"
    return v


def show(label, obj):
    print(f"\n=== {label}")
    print(json.dumps(trim(obj), indent=1, ensure_ascii=False))


def attach():
    out = subprocess.run([HERMES, "gateway", "attach", "--json"], capture_output=True, text=True, timeout=60)
    line = (out.stdout or "").strip().splitlines()[-1] if out.stdout.strip() else "{}"
    grant = json.loads(line)
    show(f"attach (exit {out.returncode})", grant)
    if "url" not in grant:
        sys.exit("no attachable gateway (probe never starts one)")
    return grant


async def main():
    grant = attach()
    async with websockets.connect(grant["url"], subprotocols=grant["protocols"], origin=None,
                                  max_size=64 * 1024 * 1024, open_timeout=10) as ws:
        print(f"\nselected subprotocol: {ws.subprotocol!r}")
        ready = json.loads(await asyncio.wait_for(ws.recv(), 10))
        show("first frame (gateway.ready)", ready)

        nid = 0
        async def call(method, params):
            nonlocal nid
            nid += 1
            rid = f"p{nid}"
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), 60))
                if frame.get("id") == rid:
                    return frame
                if frame.get("method") == "event":
                    show(f"(interleaved event {frame['params'].get('type')})", frame)
                elif "method" in frame:
                    # A server->client request: decline instead of leaving it hanging.
                    show(f"(server request {frame['method']}; declined -32601)", frame)
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"],
                                              "error": {"code": -32601, "message": "probe"}}))

        show("client.capabilities {server_requests:true}", await call("client.capabilities", {"server_requests": True}))
        show("gateway.ping", await call("gateway.ping", {}))
        for method, params in CALLS:
            show(f"{method} {json.dumps(params)}", await call(method, params))

        # Read one stored conversation without attaching (session.transcript and session.info
        # never subscribe the caller or start an agent: gateway-local-sessions.md).
        listing = await call("session.list", {"scope": "stored", "limit": 200})
        stored = (listing.get("result") or {}).get("sessions", [])
        print(f"\n(stored sessions listed: {len(stored)}, with message_count>0: "
              f"{sum(1 for r in stored if r.get('message_count', 0) > 0)})")
        rows = sorted(stored, key=lambda r: r.get("message_count", 0), reverse=True)
        if rows:
            sid = rows[0]["session_id"]
            show("session.transcript {order: latest, limit: 8}",
                 await call("session.transcript", {"session_id": sid, "order": "latest", "limit": 8}))
            show("session.info", await call("session.info", {"session_id": sid}))


if __name__ == "__main__":
    if "--raw" in sys.argv:
        MAXSTR, MAXLIST = 100000, 100000
    asyncio.run(main())
