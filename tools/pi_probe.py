#!/usr/bin/env python3
"""Probe a live `pi --mode rpc` process and record real response/event shapes.

Stdlib only. Safe by default:
  * starts `pi --mode rpc --no-session` in a fresh temp directory (nothing persisted),
  * sends read-only commands (get_state, get_available_models, get_commands,
    get_available_thinking_levels, get_session_stats, get_messages),
  * auto-cancels any extension dialog so nothing blocks,
  * redacts anything that looks like a credential and truncates long values,
  * closes stdin for an orderly shutdown (SIGTERM / SIGKILL only as fallback).

Optional:
  --bash      also run the RPC `bash` command (`echo hi`), no model involved.
  --prompt    also send one tiny prompt that should trigger a bash tool call
              (and, mid-run, a prompt without streamingBehavior + a follow_up).
  --edit      also ask the model for one `edit` tool call on a temp file (diff details).
              Refused unless the current model is free (cost 0) and its baseUrl
              is a LAN/localhost address. Aborted if no model output arrives
              within --model-timeout seconds (default 60).

Usage:
  python3 tools/pi_probe.py [--bash] [--prompt] [--out records.jsonl]
                            [--workdir DIR] [--pi pi] [--model-timeout 60]
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse

SECRET_EXACT = {"apikey", "api_key", "key", "token", "accesstoken", "refreshtoken", "secret", "password",
                "authorization", "cookie", "headers", "bearer"}
SECRET_SUFFIXES = ("apikey", "api_key", "token", "secret", "password")
MAX_STR = 240
MAX_LIST = 4

EDIT_PROMPT_TEXT = ("Use the edit tool (not bash, not write) to change the text 'hello world' to 'hello there' "
                    "in the file hello.txt in the current directory. Do not read it first. Then reply with just: edited")
PROMPT_TEXT = "Reply with just the word ok, then run the bash command `echo hi` with your bash tool."


def redact(value, key: str | None = None, depth: int = 0):
    """Redact credential-like keys and truncate long strings / lists."""
    lk = (key or "").lower()
    if key is not None and (lk in SECRET_EXACT or lk.endswith(SECRET_SUFFIXES)) and not isinstance(value, (bool, int, float)):
        # keep obviously harmless shapes visible, e.g. {"auth": null}
        if value is None:
            return None
        return "<redacted>"
    if isinstance(value, dict):
        return {k: redact(v, k, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        limit = MAX_LIST if any(isinstance(v, (dict, list)) for v in value) else 16
        items = [redact(v, None, depth + 1) for v in value[:limit]]
        if len(value) > limit:
            items.append(f"<... {len(value) - limit} more items>")
        return items
    if isinstance(value, str) and len(value) > MAX_STR:
        return value[:MAX_STR] + f"<... {len(value) - MAX_STR} more chars>"
    return value


class PiRpc:
    def __init__(self, argv: list[str], cwd: str, stderr_path: str):
        self.stderr_file = open(stderr_path, "wb")
        self.t0 = time.monotonic()
        self.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.stderr_file,
            start_new_session=True,  # keep our Ctrl+C away from pi; we shut it down ourselves
        )
        self.records: queue.Queue = queue.Queue()
        self.log: list[dict] = []  # every stdout record, raw (unredacted, in memory only)
        self._next_id = 0
        threading.Thread(target=self._reader, daemon=True).start()

    def elapsed(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    def _reader(self):
        assert self.proc.stdout is not None
        buf = b""
        while True:
            chunk = self.proc.stdout.read1(65536) if hasattr(self.proc.stdout, "read1") else self.proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            # Split on LF only (U+2028/2029 inside JSON strings are not record boundaries).
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.rstrip(b"\r")
                if not line:
                    continue
                try:
                    rec = json.loads(line.decode("utf-8"))
                except Exception as exc:  # noqa: BLE001
                    rec = {"type": "<unparseable>", "error": str(exc), "raw": line[:200].decode("utf-8", "replace")}
                entry = {"t": self.elapsed(), "rec": rec}
                self.log.append(entry)
                self.records.put(entry)
        self.records.put(None)

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def command(self, cmd: dict, timeout: float = 30.0) -> dict | None:
        self._next_id += 1
        cmd = {"id": f"probe-{self._next_id}", **cmd}
        self.send(cmd)
        return self.wait_for(lambda r: r.get("type") == "response" and r.get("id") == cmd["id"], timeout)

    def wait_for(self, pred, timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                entry = self.records.get(timeout=remaining)
            except queue.Empty:
                return None
            if entry is None:
                return None
            rec = entry["rec"]
            self._auto_answer(rec)
            if pred(rec):
                return rec

    def _auto_answer(self, rec: dict) -> None:
        """Never leave an extension dialog hanging: cancel it."""
        if rec.get("type") == "extension_ui_request" and rec.get("method") in ("select", "confirm", "input", "editor"):
            self.send({"type": "extension_ui_response", "id": rec["id"], "cancelled": True})

    def close(self, grace: float = 15.0) -> int | None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            return self.proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            self.proc.send_signal(signal.SIGTERM)
            try:
                return self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                return self.proc.wait()
        finally:
            self.stderr_file.close()


def run_prompt(pi: "PiRpc", results: dict, notes: list, label: str, text: str, model_timeout: float,
               mid_run_checks: bool = False) -> None:
    """Send one prompt, wait for settle; abort if the model does not start answering in time."""
    resp = pi.command({"type": "prompt", "message": text}, timeout=30)
    results[label] = resp
    if not (resp and resp.get("success")):
        notes.append(f"{label}: prompt rejected: {resp}")
        return
    first = pi.wait_for(
        lambda r: r.get("type") in ("message_update", "agent_settled")
        or (r.get("type") == "message_start" and (r.get("message") or {}).get("role") == "assistant"),
        model_timeout,
    )
    if first is None:
        notes.append(f"{label}: no model output within {model_timeout}s -> abort")
        results[label + "_abort"] = pi.command({"type": "abort"}, timeout=30)
        return
    if mid_run_checks and first.get("type") != "agent_settled":
        # While streaming: a prompt without streamingBehavior must fail; a follow_up is queued.
        results[label + "_busy_prompt"] = pi.command({"type": "prompt", "message": "ignored"}, timeout=10)
        results[label + "_follow_up"] = pi.command({"type": "follow_up", "message": "Now reply with just the word done."}, timeout=10)
    if first.get("type") != "agent_settled":
        settled = pi.wait_for(lambda r: r.get("type") == "agent_settled", 240)
        if settled is None:
            notes.append(f"{label}: run did not settle within 240s -> abort")
            results[label + "_abort"] = pi.command({"type": "abort"}, timeout=30)


def is_lan_or_local(base_url: str | None) -> bool:
    if not base_url:
        return False
    host = urlparse(base_url).hostname or ""
    if host in ("localhost",):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def model_is_free(model: dict | None) -> bool:
    if not model:
        return False
    cost = model.get("cost") or {}
    return all((cost.get(k) or 0) == 0 for k in ("input", "output", "cacheRead", "cacheWrite"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pi", default="pi")
    ap.add_argument("--workdir", default=None, help="parent dir for the temp cwd (default: system temp)")
    ap.add_argument("--out", default=None, help="write all redacted records as JSONL here")
    ap.add_argument("--bash", action="store_true", help="also run the RPC bash command (echo hi)")
    ap.add_argument("--prompt", action="store_true", help="also send one tiny prompt (LAN/free models only)")
    ap.add_argument("--edit", action="store_true", help="also prompt for one edit-tool call on a temp file (LAN/free models only)")
    ap.add_argument("--model-timeout", type=float, default=60.0)
    args = ap.parse_args()

    cwd = tempfile.mkdtemp(prefix="pi-probe-", dir=args.workdir)
    stderr_path = os.path.join(cwd, "..", os.path.basename(cwd) + ".stderr.log")
    stderr_path = os.path.abspath(stderr_path)
    argv = [args.pi, "--mode", "rpc", "--no-session"]
    print(f"# cwd={cwd}\n# argv={argv}\n# stderr={stderr_path}", file=sys.stderr)

    pi = PiRpc(argv, cwd, stderr_path)
    results: dict[str, dict | None] = {}
    notes: list[str] = []
    try:
        for name in ("get_state", "get_available_models", "get_commands",
                     "get_available_thinking_levels", "get_session_stats", "get_messages"):
            t = pi.elapsed()
            results[name] = pi.command({"type": name}, timeout=60.0)
            print(f"# {name}: {'ok' if results[name] else 'TIMEOUT'} after {round(pi.elapsed() - t, 3)}s", file=sys.stderr)

        # Unknown command and malformed JSON: record the error shapes.
        results["unknown_command"] = pi.command({"type": "definitely_not_a_command"}, timeout=10)
        assert pi.proc.stdin is not None
        pi.proc.stdin.write(b"{not json\n")
        pi.proc.stdin.flush()
        results["parse_error"] = pi.wait_for(lambda r: r.get("type") == "response" and r.get("command") == "parse", 10)

        if args.bash:
            results["bash"] = pi.command({"type": "bash", "command": "echo hi", "excludeFromContext": True}, timeout=30)

        if args.prompt or args.edit:
            state = (results.get("get_state") or {}).get("data") or {}
            model = state.get("model")
            if not model_is_free(model) or not is_lan_or_local(model.get("baseUrl") if model else None):
                notes.append(f"prompts skipped: model {model and model.get('provider')}/{model and model.get('id')} is not free+LAN")
            else:
                notes.append(f"prompts go to {model['provider']}/{model['id']} at {model.get('baseUrl')}")
                if args.prompt:
                    run_prompt(pi, results, notes, "prompt", PROMPT_TEXT, args.model_timeout, mid_run_checks=True)
                if args.edit:
                    with open(os.path.join(cwd, "hello.txt"), "w", encoding="utf-8") as fh:
                        fh.write("line one\nhello world\nline three\n")
                    run_prompt(pi, results, notes, "edit_prompt", EDIT_PROMPT_TEXT, args.model_timeout)
                results["get_messages_after"] = pi.command({"type": "get_messages"}, timeout=30)
                results["get_session_stats_after"] = pi.command({"type": "get_session_stats"}, timeout=30)
                results["get_state_after"] = pi.command({"type": "get_state"}, timeout=30)
        # drain a little
        pi.wait_for(lambda r: False, 1.0)
    finally:
        code = pi.close()
        notes.append(f"exit code after stdin close: {code} at t={pi.elapsed()}s")

    redacted_log = [{"t": e["t"], "rec": redact(e["rec"])} for e in pi.log]
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            for e in redacted_log:
                fh.write(json.dumps(e, ensure_ascii=False) + "\n")

    cmds = ((results.get("get_commands") or {}).get("data") or {}).get("commands") or []
    if cmds:
        notes.append("get_commands names: " + ", ".join(f"/{c.get('name')} ({c.get('source')})" for c in cmds))
    models = ((results.get("get_available_models") or {}).get("data") or {}).get("models") or []
    if models:
        notes.append("models: " + ", ".join(f"{m.get('provider')}/{m.get('id')}" for m in models))
    print("## notes")
    for n in notes:
        print("-", n)
    print("## stdout records (redacted, in order)")
    for e in redacted_log:
        print(json.dumps(e, ensure_ascii=False))
    try:
        with open(stderr_path, "rb") as fh:
            err = fh.read().decode("utf-8", "replace")
        print("## stderr (first 2000 chars)")
        print(err[:2000])
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
