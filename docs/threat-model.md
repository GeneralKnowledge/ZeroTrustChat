# Threat model

## Assets

- Message plaintext
- Long-term identity private keys
- Contact graphs
- Group epoch keys
- Local message history

## Adversaries & expectations

### Compromised central server / malicious operator

**Should not obtain:** historical plaintext, contact lists, private identity keys, attachments.

**May obtain:** ephemeral session IDs, peerIds, signalling metadata (SDP/ICE), presence, opaque ephemeral key blobs until expiry.

### Database leak (dev SQLite)

Reveals sessions and opaque ephemeral key material only — not a message store. Production design is RAM-only with aggressive expiry (see development-vs-production).

### Network interception

TLS/WSS should protect signalling in production. Prototype may use plain `ws://` locally. Even if signalling is visible, chat plaintext is not on that channel. P2P still uses DTLS + app AEAD.

### Compromised client / stolen device

**Out of scope for strong protection.** Attacker with device access can read local DB/keys while unlocked. Time-limited keys reduce *ongoing* access after expiry but cannot revoke observed plaintext.

### Malicious group member

Can read messages for epochs they participated in. After removal, new epoch keys are not distributed to them — they cannot decrypt future messages. They may retain old ciphertext they already received.

### Malicious signalling messages

Clients should treat signalling as untrusted. Prototype performs basic WebRTC handling; production needs tighter validation, rate limits, and authentication of signalling authenticity (e.g. signed offers).

### Replay attacks

Message IDs are UUIDs; clients ignore duplicate IDs on ingest. Production should add ratchet/nonces and stronger anti-replay.

### Expired-key attacks

After decryption deadline, keys are destroyed locally. Ciphertext without keys is useless to the normal app. Attackers with prior key exfiltration are not stopped.

### Metadata leakage

Who is online, who requests whom, connection timing — visible to the server. Mitigations (production): shorter sessions, cover traffic, mixnets — not in this prototype.

## Threats (additions for third-party infrastructure)

### Malicious or compromised third-party server

Same blast radius as the official server: may observe signalling metadata and ephemeral opaque blobs. Must not obtain plaintext messages, contacts, or private keys because those never cross the server interface.

### Malicious signed manifest

Clients reject manifests not signed by the embedded developer public key. Compromising the developer private key would allow publishing a malicious server list — protect that key as a release signing secret.

## Explicit non-claims

We do **not** claim:

- “Impossible to hack”
- Perfect anonymity
- Screenshot prevention
- Protection against a fully compromised endpoint

We **do** claim for this architecture:

> If the central server is compromised, the attacker should not obtain historical plaintext messages because those messages are never stored there.
