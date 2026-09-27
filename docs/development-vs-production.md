# Development vs production

## Development (this prototype)

| Concern | Dev choice |
|---------|------------|
| Session state | SQLite file under `apps/server/data/` (`better-sqlite3`) |
| Ephemeral keys | SQLite with TTL + single-use delete |
| Client local DB | **sql.js (SQLite WASM)** persisted to `localStorage` — browser cannot use Node `better-sqlite3` |
| Logging | `LOG_LEVEL` stdout; truncated IDs allowed |
| Transport | `ws://localhost` |
| ICE | Public Google STUN only (no TURN) |

SQLite is for **developer convenience** so restarts and inspection are easy.

### Documented deviations from the preferred stack

1. **Client SQLite = sql.js**, not `better-sqlite3` (Node-only). Same SQL schema semantics.
2. **No TURN** — localhost / same-network WebRTC is sufficient for the prototype.
3. **Turborepo + pnpm** as specified; React + Vite for the client.

## Production architecture (target)

| Concern | Production |
|---------|------------|
| Session state | **RAM-only**, aggressive TTL |
| Ephemeral keys | **RAM-only**, short TTL, single-use default |
| Message DB | **Does not exist** |
| Contact DB | **Does not exist** |
| Logging | Privacy-preserving defaults; no stable long-term IDs |
| Transport | WSS + authenticated sessions |
| NAT traversal | TURN as last resort; still no message content on TURN if using DataChannels carefully |
| Client | Native apps with secure enclaves / platform keystores |

## What must never become persistent on the server

- Chat plaintext or ciphertext mailboxes
- Contact lists
- Private keys
- Conversation history
- Attachment bodies

## Mental model

```
Development persistence ≠ production retention policy
```

The prototype may write operational rows to disk. The **architecture and protocol** are designed so those rows are only ephemeral infrastructure state — never user conversation content.
