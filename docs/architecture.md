# Architecture

ZeroTrustChat is a prototype proving that useful chat can work when:

1. Devices are authoritative for identities, keys, contacts, messages, and groups.
2. The central server is rendezvous/signalling only.
3. All client↔server traffic crosses one small auditable package: `@ztc/server-interface`.

## High-level

```mermaid
flowchart LR
  subgraph devices [User devices]
    A[Alice client]
    B[Bob client]
  end
  M[Signed network manifest]
  S1[Official server]
  S2[Community / self-hosted]
  A -->|bootstrap once| M
  M --> S1
  M --> S2
  A -->|server-interface only| S1
  B -->|server-interface only| S2
  A <-->|WebRTC DataChannel + app encryption| B
```

## 1. Initial rendezvous

```mermaid
sequenceDiagram
  participant A as Alice
  participant S as Server
  participant B as Bob
  A->>S: register_session(peerId)
  B->>S: register_session(peerId)
  A->>S: request_peer(Bob)
  S-->>A: peer_available
  Note over A,B: Invitation codes exchanged out-of-band (copy/paste)
```

## 2. WebRTC connection

```mermaid
sequenceDiagram
  participant A as Alice
  participant S as Server
  participant B as Bob
  A->>S: signalling(offer)
  S->>B: signalling(offer)
  B->>S: signalling(answer)
  S->>A: signalling(answer)
  A->>S: signalling(ice)
  S->>B: signalling(ice)
  A<<->>B: DataChannel open
```

## 3. Direct messaging

```mermaid
flowchart LR
  P[Plaintext] --> K[Random message key]
  K --> E[AES-256-GCM]
  E --> C[Ciphertext]
  C --> DC[WebRTC DataChannel]
  K --> W[Wrap key for recipient X25519]
  W --> DC
```

The server never sees plaintext or message keys in the clear as chat content.

## 4. Server disconnect

```mermaid
flowchart TB
  A[Alice] ---|DataChannel still up| B[Bob]
  S[Server offline]
  A -.->|no signalling needed| S
  B -.->|no signalling needed| S
```

Once P2P is established, signalling can drop and chat continues (until NAT/network forces reconnect).

## 5. Offline message behaviour

```mermaid
flowchart TD
  A[Alice sends] --> Q{Bob P2P up?}
  Q -->|yes| D[Deliver on DataChannel]
  Q -->|no| L[Local encrypted outbox]
  L --> R[Retry when Bob online]
  R --> DL{Delivery deadline?}
  DL -->|passed| X[Mark expired — never upload]
  DL -->|ok| D
```

**There is no server mailbox.**

## 6. Message expiry

- **Delivery deadline**: stop attempting send.
- **Retention deadline**: delete local ciphertext + key material.
- Independent timers.

## 7. Ephemeral server keys

```mermaid
sequenceDiagram
  participant A as Alice
  participant S as Server
  participant B as Bob
  A->>S: publish_ephemeral_key(opaque ciphertext, expiresAt)
  Note over S: Dev: SQLite / Prod: RAM-only
  B->>S: retrieve_ephemeral_key(keyId)
  S-->>B: encryptedKeyMaterial
  Note over S: single_use deletes after retrieve
```

Not message storage — opaque key material only.

## 8. Group formation

```mermaid
flowchart LR
  C[Creator] --> E1[Epoch 1 group key]
  E1 -->|P2P distribute| M[Current members]
  M --> Mesh[P2P mesh DataChannels]
```

Prototype historically used a full mesh for small groups. Large-group delivery now uses a **shared connection pool**, **gossip + compressed digests**, **signed epoch key-wrap**, and **soft helper preference within the degree budget** — see [Distributed group chat](distributed-group-chat.md). MLS and push tickles remain future work.

## 9. Group membership changes

```mermaid
flowchart TD
  M1[Members A B C D] --> Leave[C leaves]
  Leave --> E2[Epoch 2 new key]
  E2 -->|send key| ABD[A B D only]
  E2 -.->|no key| C[C cannot decrypt future]
```

New members do not receive old epoch keys → no automatic history access.

## 10. Group message delivery

```mermaid
flowchart LR
  Sender --> Encrypt[Encrypt with epoch key]
  Encrypt --> Peers[Send to each online member via P2P]
  Peers --> Offline[Offline members: local retain + sync on reconnect]
```

**Prototype (updated):** sender fans out to a small set of live pool neighbors; gossip + digest anti-entropy repair the rest. Soft helper ranking (capability ads on existing edges only) and signed epoch key-wrap are implemented — see [Distributed group chat](distributed-group-chat.md). MLS and push tickles remain out of scope.

## Package boundaries

| Package | May use network? |
|---------|------------------|
| `@ztc/server-interface` | **Yes** (only) |
| `@ztc/crypto` | No |
| `@ztc/protocol` | No |
| Client chat/contacts/messages/groups | No — call server-interface |
| Server | Is the infrastructure |

## Group encryption (prototype)

The prototype uses a **shared AES-256-GCM group key per cryptographic epoch**:

1. On create / membership change, a new random epoch key is generated.
2. The key is distributed to *current* members over existing P2P DataChannels.
3. Removed members do not receive the new key and cannot decrypt future messages.
4. New members do not receive old epoch keys → no automatic history access.

**Must strengthen for production:**

- Replace ad-hoc key distribution with MLS (or similar continuous group key agreement).
- Persist prior epoch keys only under explicit policy; currently only the current epoch key is kept locally.
- Handle concurrent membership changes and partitions.
- Forward secrecy beyond simple epoch rotation.
- Soft helpers today are preference-within-budget only (no election/rotation beyond pool ranking).
- Scale further using the [distributed group chat design](distributed-group-chat.md).
