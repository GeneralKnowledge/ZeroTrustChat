# ZeroTrustChat

Privacy-first peer-to-peer messaging prototype.

**Devices own the data. The server is signalling infrastructure — never a mailbox.**

## Quick start

```bash
pnpm install
pnpm dev
```

This starts:

- Signalling server at `ws://localhost:8787`
- Client at `http://localhost:5173`

Open **two browser windows** (or profiles), copy each invitation code into the other, connect, and chat over WebRTC DataChannels.

## Demo script

1. Start Alice and Bob clients; exchange invitations.
2. Establish P2P (dashboard shows P2P connected).
3. Send messages — confirm **Server messages stored: 0** and **Server plaintext recv: 0**.
4. Disconnect signalling — P2P chat continues.
5. Stop/restart the server — local history remains; no message DB on server.
6. Send while peer offline — message stays in local pending queue (not uploaded).

## Workspace

```
apps/client          React UI + local SQLite (sql.js) + WebRTC
apps/server          Signalling / ephemeral key server
packages/crypto      AES-256-GCM, X25519, HKDF (@noble)
packages/protocol    Strict Zod schemas (no message-store ops)
packages/server-interface   Auditable network boundary (ONLY network I/O)
packages/shared      Shared types / display names / policies
packages/test-utils  Privacy-boundary assertions
docs/                Architecture, threat model, protocol, privacy
tests/e2e            Playwright end-to-end
```

## Tests

```bash
pnpm test           # unit tests (turbo)
pnpm test:privacy   # protocol + server-interface audits
pnpm test:e2e       # Playwright (server must be available or harness starts it)
```

## Principles

| Rule | Enforcement |
|------|-------------|
| No server message storage | Protocol forbids `send_message` / `store_*`; server has no message tables |
| All server I/O via boundary | Only `@ztc/server-interface` may use WebSocket |
| App-level encryption | AES-256-GCM per message; not relying on WebRTC alone |
| Offline = local queue | Sender retains ciphertext until delivery / expiry |

## Documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Privacy model](docs/privacy-model.md)
- [Threat model](docs/threat-model.md)
- [Development vs production](docs/development-vs-production.md)
- [Third-party servers](docs/third-party-servers.md)
- [Server interface README](packages/server-interface/README.md)

## Intentionally not built

iOS/Android apps, push, TURN production infra, phone discovery, email accounts, analytics, cloud mailboxes, voice/video.

## Crypto primitives

| Use | Primitive | Library |
|-----|-----------|---------|
| Identity / key agreement | X25519 | `@noble/curves` |
| Message AEAD | AES-256-GCM | `@noble/ciphers` |
| KDF | HKDF-SHA256 | `@noble/hashes` |

Do not invent cryptography.
