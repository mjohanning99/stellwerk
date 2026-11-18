# Fake stores for the search/paging test: 60 Pi sessions and a minimal Hermes state.db.
import json, os, shutil, sqlite3, sys, time

root = sys.argv[1]
shutil.rmtree(root, ignore_errors=True)
pi = os.path.join(root, "pisess", "--home-me-project--")
os.makedirs(pi)
now = time.time()
for i in range(60):
    ts = now - i * 3600
    path = os.path.join(pi, f"2026-11-18T00-00-{i:02d}-000Z_{i:08d}-0000-4000-8000-000000000000.jsonl")
    body = f"Question number {i} about the parser."
    if i == 47:
        body = "Can you explain why the flux capacitor test fails on CI?"
    lines = [
        {"type": "session", "version": 3, "id": f"{i:08d}", "timestamp": "2026-11-18T00:00:00.000Z", "cwd": "/tmp"},
        {"type": "message", "id": "a1", "parentId": None, "timestamp": "2026-11-18T00:00:01.000Z",
         "message": {"role": "user", "content": [{"type": "text", "text": f"Session {i}"}], "timestamp": int(ts * 1000)}},
        {"type": "message", "id": "a2", "parentId": "a1", "timestamp": "2026-11-18T00:00:02.000Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": body}], "timestamp": int(ts * 1000) + 1,
                     "provider": "local", "model": "qwen" if i % 2 else "gemma", "durationMs": 2000,
                     "usage": {"input": 100, "output": 50, "cacheRead": 1000, "cacheWrite": 10, "totalTokens": 1160,
                               "cost": {"total": 0.01}}}},
    ]
    with open(path, "w") as f:
        f.write("\n".join(json.dumps(l) for l in lines) + "\n")
    os.utime(path, (ts, ts))

db = os.path.join(root, "state.db")
con = sqlite3.connect(db)
con.executescript("""
CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT, cwd TEXT, message_count INT,
  started_at REAL, last_activity_at REAL, hidden INT DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
""")
con.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)", [
    ("local-a", None, "Refactor the login form", "/home/me/project", 4, now - 500, now - 100, 0),
    ("local-a2", "local-a", None, "/home/me/project", 2, now - 90, now - 80, 0),      # compression child of a
    ("local-b", None, None, "/home/me/other", 2, now - 900, now - 800, 0),
    ("local-h", None, "Hidden one about wombats", "/tmp", 1, now - 50, now - 40, 1),
])
con.executemany("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", [
    ("local-a", "user", "please tidy the form", now - 400),
    ("local-a2", "assistant", "I moved the WOMBAT validation into a helper 100%_done", now - 85),
    ("local-b", "user", "what is a wombat anyway", now - 850),
    ("local-h", "user", "wombats again", now - 45),
])
con.executescript("""
CREATE TABLE session_model_usage (session_id TEXT, model TEXT, api_call_count INT, input_tokens INT, output_tokens INT,
  cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, estimated_cost_usd REAL, actual_cost_usd REAL, last_seen REAL);
""")
con.executemany("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    ("local-a", "anthropic/claude", 3, 1000, 200, 5000, 300, 50, 0.5, None, now - 100),
    ("local-b", "anthropic/claude", 1, 400, 100, 0, 0, 0, 0.2, 0.25, now - 10 * 86400),
    ("local-b", "local/qwen", 2, 300, 300, 0, 0, 20, 0, None, now - 40 * 86400),
])
con.commit()
print("fixtures in", root)
