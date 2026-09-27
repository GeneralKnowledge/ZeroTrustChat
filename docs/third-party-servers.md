# Third-party / interchangeable infrastructure

The developer owns the **app and protocol**, not the infrastructure.

```
Official App
     │
     │ one-time bootstrap / signed manifest (via server-interface)
     ▼
Network configuration
     │
     ├── Official server
     ├── Community server
     └── Self-hosted server
             │
             ▼
        P2P connection
             │
        Alice ◄──► Bob
```

## Signed network manifest

Fetched once (and refreshable) from a bootstrap HTTP endpoint:

`GET {bootstrap}/manifest`

Verified with the **developer public key embedded in the client** (`EMBEDDED_DEVELOPER_PUBLIC_KEY`).

Fields:

| Field | Purpose |
|-------|---------|
| `protocolVersion` | Wire protocol compatibility |
| `manifestVersion` | Manifest schema revision |
| `developerPublicKey` | Must match embedded key |
| `minClientVersion` | Soft compatibility hint |
| `issuedAt` / `expiresAt` | Freshness |
| `servers[]` | Official / community entries with `wsUrl`, `publicKey`, `capabilities` |
| `signature` | Ed25519 over canonical JSON body |

Tampering the server list invalidates the signature.

## Server identity

Every compatible server has its own Ed25519 keypair and answers `hello` with a signed `server_info`:

- `serverId` (public key)
- `displayName`
- `capabilities`: `signalling`, `rendezvous`, `ephemeral_keys`, `relay`, optional `stun`/`turn`
- `protocolVersion`
- `signature`

Clients pin expected public keys from the manifest when using listed servers. Custom servers may omit the pin (user trusts the URL) or supply an expected key.

## Client selection

Via `@ztc/server-interface` only:

- `fetchNetworkManifest(bootstrapHttpUrl)`
- `selectOfficialServer()` / `selectCommunityServer(id)` / `setCustomServer(wsUrl)`
- WebSocket `connect()` performs the hello handshake automatically

Local SQLite stores the chosen server so the official bootstrap is **not** required on every launch.

## What still never happens

Third-party servers remain infrastructure. They must not store:

- messages / history
- contacts
- private keys
- profiles / accounts

The protocol still rejects mailbox operations.

## Running your own server

```bash
pnpm --filter @ztc/server start
# exposes ws://HOST:PORT , GET /manifest , GET /health , GET /server-info
```

Point the client custom URL at your `ws://` endpoint. For production, generate a fresh server keypair (do not reuse prototype keys) and optionally ask the developer to list you in a signed community manifest.
