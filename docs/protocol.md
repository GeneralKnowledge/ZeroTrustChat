# Protocol

All client↔server messages are strictly typed. Unknown types and unexpected fields are rejected.

Machine-readable schema: `packages/protocol/schema/protocol.schema.json`

## Transport

- WebSocket only (default `ws://localhost:8787`)
- JSON messages with a `type` discriminator
- Zod `.strict()` objects — no extra keys

## Client → server

| type | Purpose |
|------|---------|
| `hello` | Protocol version + expect signed `server_info` |
| `register_session` | Bind ephemeral session + peerId |
| `close_session` | Tear down |
| `request_peer` | Is peer online? |
| `signalling` | WebRTC SDP/ICE relay |
| `presence` | online/offline |
| `publish_ephemeral_key` | Store opaque encrypted key material |
| `retrieve_ephemeral_key` | Fetch opaque material |
| `relay_packet` | Opaque ciphertext relay |
| `intro_claim` | Claim short-lived PAKE intro nameplate |
| `intro_join` | Join intro nameplate (second peer) |
| `intro_relay` | Opaque PAKE / sealed-identity frame (no peerId) |
| `intro_release` | Tear down intro nameplate |
| `get_stats` | Developer counters |

## Forbidden operations (hard reject)

```
send_message, store_message, store_contact, store_profile,
upload_history, upload_private_key, mailbox_deposit, mailbox_fetch
```

## Forbidden field names (audit)

`plaintext`, `message`, `messageText`, `body`, `content`, `privateKey`, `secretKey`,
`identityPrivateKey`, `contacts`, `contactList`, `history`, `messages`, `conversation`,
`attachment`, `attachmentPlaintext`, `password`, `email`, `phone`

## Server → client

`server_info`, `session_registered`, `peer_available`, `peer_unavailable`, `signalling`,
`presence_update`, `ephemeral_key_stored`, `ephemeral_key_retrieved`,
`ephemeral_key_missing`, `relay_packet`, `intro_claimed`, `intro_joined`,
`intro_peer_joined`, `intro_frame`, `intro_released`, `error`, `server_stats`

`server_stats.messagesStored` is always literal `0`.

## Network manifest (HTTP bootstrap)

`GET /manifest` returns a developer-signed JSON document (see `docs/third-party-servers.md`).
Not a WebSocket message; fetched only via `@ztc/server-interface.fetchNetworkManifest`.

## Signalling payload

Only:

- `{ kind: "offer", sdp }`
- `{ kind: "answer", sdp }`
- `{ kind: "ice_candidate", candidate, sdpMid, sdpMLineIndex }`

## Logging

`LOG_LEVEL=error|warn|info|debug` (default `info`).

Logs must not include message contents, private keys, contact lists, or conversation history.
Development logs may include truncated temporary IDs.
