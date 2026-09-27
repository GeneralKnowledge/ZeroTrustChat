# @ztc/server-interface

**Public / auditable network boundary** for ZeroTrustChat.

This package is the *only* client module allowed to communicate with central infrastructure.
It is intentionally small so it can be independently open-sourced and audited even if the
rest of the application remains closed source.

## What this module CAN send

| Operation | Fields | Purpose |
|-----------|--------|---------|
| `register_session` | `sessionId`, `peerId`, `expiresAt` | Ephemeral signalling session |
| `close_session` | `sessionId` | End session |
| `request_peer` | `sessionId`, `targetPeerId` | Ask if peer is online |
| `signalling` | `sessionId`, `fromPeerId`, `toPeerId`, `payload` | WebRTC SDP / ICE only |
| `presence` | `sessionId`, `peerId`, `status` | online/offline |
| `publish_ephemeral_key` | `sessionId`, `keyId`, `encryptedKeyMaterial`, `expiresAt`, `singleUse` | Temporary opaque ciphertext |
| `retrieve_ephemeral_key` | `sessionId`, `keyId` | Fetch opaque key material |
| `relay_packet` | `sessionId`, `fromPeerId`, `toPeerId`, `opaquePayload` | Opaque ciphertext relay |
| `get_stats` | `sessionId` | Developer dashboard counters |

Signalling `payload` is restricted to:

- `{ kind: "offer", sdp }`
- `{ kind: "answer", sdp }`
- `{ kind: "ice_candidate", candidate, sdpMid, sdpMLineIndex }`

## What this module CANNOT send

- Plaintext chat messages
- Private identity / device keys
- Contact lists / address books
- Conversation history
- Attachment plaintext
- Profiles, emails, phone numbers
- Any `send_message` / `store_*` / `upload_*` / `mailbox_*` operations

These are rejected by:

1. TypeScript API surface (no such methods)
2. Zod strict schemas (`additionalProperties: false`)
3. `auditOutbound()` runtime checks
4. Automated privacy-boundary tests

## Network endpoint

| Transport | Default (dev) | Purpose |
|-----------|---------------|---------|
| WebSocket | `ws://localhost:8787` | All protocol messages |

There is **no** REST API for messages. There is **no** HTTP upload endpoint.

## Retention expectations

| Data | Server retention |
|------|------------------|
| Sessions | Until expiry or disconnect (dev may use SQLite; production = RAM) |
| Ephemeral keys | Until `expiresAt` or single-use retrieval |
| Signalling | Not stored — relayed then discarded |
| Chat messages | **Never stored** (`messagesStored` always `0`) |
| Contacts | **Never received** |

## Security assumptions

1. Clients treat the server as untrusted infrastructure.
2. Compromising the server must not reveal message plaintext, contacts, or private keys.
3. WebRTC DataChannels carry application-encrypted payloads; transport encryption is additional, not sufficient.
4. Ephemeral key material on the server is already wrapped ciphertext, never raw message keys in the clear relative to identity.
5. This package does not authenticate users with email/password — only ephemeral session + peerId.

## Machine-readable protocol

See `@ztc/protocol/schema/protocol.schema.json`.

## API

```ts
const si = new ServerInterface({ url: "ws://localhost:8787" });
await si.connect();
await si.registerEphemeralSession(peerId);
await si.requestPeer(bobPeerId);
si.onSignallingMessage((msg) => { /* WebRTC */ });
await si.sendSignallingMessage(bobPeerId, { kind: "offer", sdp });
await si.disconnect();
```

## Publishing as open source

This package has no dependency on application chat UI, local databases, or private crypto
beyond protocol types. It can be extracted to its own repository with:

- `src/`
- `@ztc/protocol` (or vendored schemas)
- this README
- privacy-boundary tests
