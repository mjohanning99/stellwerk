"""All-time token usage for the Usage drawer.

Hermes: summed from its session store (state.db, opened read-only), per model.
Its per-model rows carry a last-seen time, so the periods attribute a session's
usage to when it was last used.
Pi: summed from the per-message `usage` in its session files (exact times),
cached per file by size and mtime.

Both return {available, sessions, periods: {today, week, month, all}}, where
each period is {total: Totals, models: [Totals + {model}]} and Totals is
{input, output, cache_read, cache_write, reasoning, calls, cost}.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import time
from pathlib import Path

FIELDS = ("input", "output", "cache_read", "cache_write", "reasoning", "calls", "cost")


def _empty() -> dict:
    return dict.fromkeys(FIELDS, 0)


def _cutoffs(now: float | None = None) -> dict[str, float]:
    now = now or time.time()
    midnight = dt.datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    return {"today": midnight, "week": now - 7 * 86400, "month": now - 30 * 86400, "all": 0.0}


def _aggregate(entries, sessions: int) -> dict:
    """entries: iterable of (timestamp, model, totals-dict)."""
    cuts = _cutoffs()
    periods = {p: {"total": _empty(), "models": {}} for p in cuts}
    for ts, model, t in entries:
        for p, cut in cuts.items():
            if (ts or 0) < cut:
                continue
            per = periods[p]
            m = per["models"].setdefault(model or "unknown", _empty())
            for k in FIELDS:
                v = t.get(k) or 0
                per["total"][k] += v
                m[k] += v
    for per in periods.values():
        per["models"] = sorted(({"model": k, **v} for k, v in per["models"].items()),
                               key=lambda m: (m["cost"], m["input"] + m["output"]), reverse=True)
    return {"available": True, "sessions": sessions, "periods": periods}


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _when(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return dt.datetime.fromisoformat(str(v)).timestamp()
    except ValueError:
        return 0.0


# ------------------------------------------------------------------ hermes

def hermes_usage(db: Path) -> dict:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
    try:
        sessions = con.execute("SELECT COUNT(*) FROM sessions WHERE COALESCE(message_count, 0) > 0").fetchone()[0]
        try:
            rows = con.execute(
                "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,"
                " api_call_count, COALESCE(actual_cost_usd, estimated_cost_usd, 0), last_seen FROM session_model_usage").fetchall()
        except sqlite3.OperationalError:   # older layout: per-session totals only
            rows = con.execute(
                "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,"
                " api_call_count, COALESCE(actual_cost_usd, estimated_cost_usd, 0), COALESCE(last_activity_at, started_at)"
                " FROM sessions").fetchall()
    finally:
        con.close()
    entries = ((_when(r[8]), r[0], {"input": _num(r[1]), "output": _num(r[2]), "cache_read": _num(r[3]),
                "cache_write": _num(r[4]), "reasoning": _num(r[5]), "calls": _num(r[6]), "cost": _num(r[7])}) for r in rows)
    return _aggregate(entries, sessions)


# ------------------------------------------------------------------ pi

_PI_CACHE: dict[str, tuple[float, int, list]] = {}   # path -> (mtime, size, [(hour, model, totals)])


def _pi_file_usage(path: Path, st: os.stat_result) -> list:
    hit = _PI_CACHE.get(str(path))
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    buckets: dict[tuple[int, str], dict] = {}
    try:
        with path.open("rb") as f:
            for line in f:
                if b'"usage"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                m = e.get("message") or {}
                u = m.get("usage")
                if e.get("type") != "message" or m.get("role") != "assistant" or not isinstance(u, dict):
                    continue
                ts = _num(m.get("timestamp")) / 1000 or _when(e.get("timestamp"))
                model = "/".join(x for x in (m.get("provider"), m.get("model")) if x) or "unknown"
                cost = u.get("cost")
                b = buckets.setdefault((int(ts // 3600), model), _empty())
                b["input"] += _num(u.get("input"))
                b["output"] += _num(u.get("output"))
                b["cache_read"] += _num(u.get("cacheRead"))
                b["cache_write"] += _num(u.get("cacheWrite"))
                b["reasoning"] += _num(u.get("reasoning"))
                b["calls"] += 1
                b["cost"] += _num(cost.get("total") if isinstance(cost, dict) else cost)
    except OSError:
        pass
    out = [(h, model, t) for (h, model), t in buckets.items()]
    _PI_CACHE[str(path)] = (st.st_mtime, st.st_size, out)
    return out


def pi_usage(sessions_dir: Path) -> dict:
    if not sessions_dir.is_dir():
        return _aggregate([], 0)
    entries, seen = [], set()
    for p in sessions_dir.glob("*/*.jsonl"):
        try:
            st = p.stat()
        except OSError:
            continue
        seen.add(str(p))
        # an hour bucket counts from its end, so "today" includes the current hour
        entries += [((h + 1) * 3600 - 1, model, t) for h, model, t in _pi_file_usage(p, st)]
    for k in [k for k in _PI_CACHE if k not in seen]:
        del _PI_CACHE[k]
    return _aggregate(entries, len(seen))
