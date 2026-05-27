---
type: "query"
date: "2026-05-27T11:40:57.147199+00:00"
question: "Why does getPool() appear in 16 different communities — and what would break if the DB connection pool changed?"
contributor: "graphify"
source_nodes: ["getPool()", "closePool()", "runSerializedCommandWrite()", "shutdown()", "setStreamerLive()", "clearStreamerLive()"]
---

# Q: Why does getPool() appear in 16 different communities — and what would break if the DB connection pool changed?

## Answer

getPool() in src/db/pool.ts is the entire DB abstraction — no service layer, no DI, just direct calls everywhere. It spans 16 communities because every db/ module and most web routes call it directly. Breaking changes: shutdown() closePool() breaks graceful exit; setStreamerLive/clearStreamerLive lose live state; runSerializedCommandWrite() breaks all command/counter writes; server.ts session store logs everyone out; all three bots (Twitch/Discord/TikTok) fail simultaneously.

## Source Nodes

- getPool()
- closePool()
- runSerializedCommandWrite()
- shutdown()
- setStreamerLive()
- clearStreamerLive()