# Privacy model

## Goals

1. **Devices own data** — identities, keys, contacts, conversations, messages, group state.
2. **Server is not a mailbox** — offline peers do not cause message upload.
3. **Small blast radius** — server compromise should not reveal plaintext history, contacts, or private keys.
4. **Auditable boundary** — all infrastructure traffic through `@ztc/server-interface`.

## Data location

| Data | Client | Server |
|------|--------|--------|
| Identity private key | Yes | Never |
| Contacts | Yes | Never |
| Message plaintext | Memory/UI only while decryptable | Never |
| Message ciphertext | Yes (local DB) | Never (no mailbox) |
| WebRTC signalling | Transient via server-interface | Relay only |
| Ephemeral wrapped keys | Optional | Temporary opaque blob |
| Sessions / presence | — | Ephemeral |

## Encryption

Application-level AES-256-GCM with per-message random keys, independent of WebRTC DTLS.

Time-limited / one-time modes destroy key material so the normal application cannot decrypt afterward.

### Limitations (honest)

- Recipients can copy/screenshot plaintext while visible.
- A compromised device can extract secrets.
- Expiry controls *application access*, not physics of information already observed.
- Metadata (who talked to whom, when sessions exist) can leak via signalling patterns.

## Network boundary rules

Client modules under chat/crypto/contacts/messages/groups MUST NOT call:

- `fetch`
- `WebSocket`
- raw sockets / HTTP clients
- WebRTC signalling transports other than via server-interface

## Proof artifacts

- Protocol rejects forbidden ops/fields
- `auditOutbound()` on every send
- Privacy-boundary Vitest suite
- Server stats always report `messagesStored: 0`
- Server restart test: no historical messages on server; clients retain history
