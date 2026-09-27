/**
 * Application-level cryptography for ZeroTrustChat.
 *
 * Primitives (via @noble — audited, no invented crypto):
 * - Identity: X25519 key agreement (@noble/curves via x25519 from @noble/ciphers/utils patterns)
 *   Actually we use Ed25519-style identity via @noble/hashes + X25519 from @noble/ciphers
 * - Message encryption: AES-256-GCM (authenticated encryption) via @noble/ciphers
 * - Key derivation: HKDF-SHA256 via @noble/hashes
 * - Hashing: SHA-256 via @noble/hashes
 *
 * Each message gets a random 256-bit message key.
 * Message keys can expire (destroyed) for time-limited / one-time decryption.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from "@noble/hashes/utils.js";
import { generateDisplayName } from "@ztc/shared";

export interface IdentityKeyPair {
  publicKey: string; // hex X25519
  privateKey: string; // hex X25519
  peerId: string; // public key hex used as peer identity
  displayName: string;
  /** Ed25519 — signs group epochs / control messages */
  signingPublicKey: string;
  signingPrivateKey: string;
}

export interface EncryptedMessage {
  ciphertext: string; // hex
  nonce: string; // hex
  messageKeyId: string;
  encryptionMetadata: {
    algorithm: "AES-256-GCM";
    version: 1;
  };
}

export interface MessageKeyRecord {
  messageKeyId: string;
  key: string; // hex — destroyed after expiry / one-time use
  decryptionDeadlineAt?: number;
  oneTime: boolean;
  destroyed: boolean;
}

export interface GroupEpochKey {
  groupId: string;
  epoch: number;
  key: string; // hex
  memberPeerIds: string[];
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function uuid(): string {
  return crypto.randomUUID();
}

export function generateIdentity(): IdentityKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const publicHex = bytesToHex(publicKey);
  const signing = generateSigningKeyPair();
  const nameBytes = randomBytes(4);
  return {
    publicKey: publicHex,
    privateKey: bytesToHex(privateKey),
    peerId: publicHex,
    displayName: generateDisplayName(nameBytes),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
  };
}

/** Attach signing keys to an older X25519-only identity. */
export function ensureSigningKeys(identity: {
  publicKey: string;
  privateKey: string;
  peerId: string;
  displayName: string;
  signingPublicKey?: string;
  signingPrivateKey?: string;
}): IdentityKeyPair {
  if (identity.signingPublicKey && identity.signingPrivateKey) {
    return identity as IdentityKeyPair;
  }
  const signing = generateSigningKeyPair();
  return {
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    peerId: identity.peerId,
    displayName: identity.displayName,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
  };
}

export function deriveSharedSecret(privateKeyHex: string, peerPublicKeyHex: string): string {
  const shared = x25519.getSharedSecret(hexToBytes(privateKeyHex), hexToBytes(peerPublicKeyHex));
  const derived = hkdf(sha256, shared, undefined, utf8ToBytes("ztc-msg-v1"), 32);
  return bytesToHex(derived);
}

export function generateMessageKey(
  options: { decryptionDeadlineAt?: number; oneTime?: boolean } = {},
): MessageKeyRecord {
  return {
    messageKeyId: uuid(),
    key: bytesToHex(randomBytes(32)),
    decryptionDeadlineAt: options.decryptionDeadlineAt,
    oneTime: options.oneTime ?? false,
    destroyed: false,
  };
}

export function encryptWithMessageKey(
  plaintext: string,
  messageKey: MessageKeyRecord,
): EncryptedMessage {
  if (messageKey.destroyed) {
    throw new Error("Message key has been destroyed");
  }
  if (
    messageKey.decryptionDeadlineAt !== undefined &&
    Date.now() > messageKey.decryptionDeadlineAt
  ) {
    throw new Error("Message key past decryption deadline — cannot encrypt");
  }

  const nonce = randomBytes(12);
  const key = hexToBytes(messageKey.key);
  const aes = gcm(key, nonce);
  const ciphertext = aes.encrypt(utf8ToBytes(plaintext));

  return {
    ciphertext: bytesToHex(ciphertext),
    nonce: bytesToHex(nonce),
    messageKeyId: messageKey.messageKeyId,
    encryptionMetadata: { algorithm: "AES-256-GCM", version: 1 },
  };
}

export function decryptWithMessageKey(
  encrypted: Pick<EncryptedMessage, "ciphertext" | "nonce">,
  messageKey: MessageKeyRecord,
  now = Date.now(),
): string {
  if (messageKey.destroyed) {
    throw new Error("Message key destroyed — cannot decrypt");
  }
  if (
    messageKey.decryptionDeadlineAt !== undefined &&
    now > messageKey.decryptionDeadlineAt
  ) {
    destroyMessageKey(messageKey);
    throw new Error("Decryption deadline passed — key destroyed");
  }

  const key = hexToBytes(messageKey.key);
  const nonce = hexToBytes(encrypted.nonce);
  const aes = gcm(key, nonce);
  const plaintext = aes.decrypt(hexToBytes(encrypted.ciphertext));
  const text = bytesToUtf8(plaintext);

  if (messageKey.oneTime) {
    destroyMessageKey(messageKey);
  }

  return text;
}

export function destroyMessageKey(messageKey: MessageKeyRecord): void {
  messageKey.key = "";
  messageKey.destroyed = true;
}

export function isKeyAvailable(messageKey: MessageKeyRecord, now = Date.now()): boolean {
  if (messageKey.destroyed || !messageKey.key) return false;
  if (
    messageKey.decryptionDeadlineAt !== undefined &&
    now > messageKey.decryptionDeadlineAt
  ) {
    return false;
  }
  return true;
}

/** Wrap a message key for a recipient using their X25519 public key + sender private key. */
export function wrapMessageKeyForPeer(
  messageKey: MessageKeyRecord,
  senderPrivateKeyHex: string,
  recipientPublicKeyHex: string,
): string {
  const sharedHex = deriveSharedSecret(senderPrivateKeyHex, recipientPublicKeyHex);
  const wrapKey = hexToBytes(sharedHex);
  const nonce = randomBytes(12);
  const aes = gcm(wrapKey, nonce);
  const payload = utf8ToBytes(
    JSON.stringify({
      messageKeyId: messageKey.messageKeyId,
      key: messageKey.key,
      decryptionDeadlineAt: messageKey.decryptionDeadlineAt,
      oneTime: messageKey.oneTime,
    }),
  );
  const ct = aes.encrypt(payload);
  return `${bytesToHex(nonce)}.${bytesToHex(ct)}`;
}

export function unwrapMessageKeyFromPeer(
  wrapped: string,
  recipientPrivateKeyHex: string,
  senderPublicKeyHex: string,
): MessageKeyRecord {
  const [nonceHex, ctHex] = wrapped.split(".");
  if (!nonceHex || !ctHex) throw new Error("Invalid wrapped key format");
  const sharedHex = deriveSharedSecret(recipientPrivateKeyHex, senderPublicKeyHex);
  const aes = gcm(hexToBytes(sharedHex), hexToBytes(nonceHex));
  const plain = bytesToUtf8(aes.decrypt(hexToBytes(ctHex)));
  const parsed = JSON.parse(plain) as {
    messageKeyId: string;
    key: string;
    decryptionDeadlineAt?: number;
    oneTime: boolean;
  };
  return {
    messageKeyId: parsed.messageKeyId,
    key: parsed.key,
    decryptionDeadlineAt: parsed.decryptionDeadlineAt,
    oneTime: parsed.oneTime,
    destroyed: false,
  };
}

export function generateGroupEpochKey(
  groupId: string,
  epoch: number,
  memberPeerIds: string[],
): GroupEpochKey {
  return {
    groupId,
    epoch,
    key: bytesToHex(randomBytes(32)),
    memberPeerIds: [...memberPeerIds].sort(),
  };
}

export function encryptGroupMessage(
  plaintext: string,
  epochKey: GroupEpochKey,
): EncryptedMessage {
  const nonce = randomBytes(12);
  const aes = gcm(hexToBytes(epochKey.key), nonce);
  const ciphertext = aes.encrypt(utf8ToBytes(plaintext));
  return {
    ciphertext: bytesToHex(ciphertext),
    nonce: bytesToHex(nonce),
    messageKeyId: `${epochKey.groupId}:epoch:${epochKey.epoch}`,
    encryptionMetadata: { algorithm: "AES-256-GCM", version: 1 },
  };
}

export function decryptGroupMessage(
  encrypted: Pick<EncryptedMessage, "ciphertext" | "nonce">,
  epochKey: GroupEpochKey,
): string {
  const aes = gcm(hexToBytes(epochKey.key), hexToBytes(encrypted.nonce));
  return bytesToUtf8(aes.decrypt(hexToBytes(encrypted.ciphertext)));
}

/** Wrap a group epoch AES key for one member (X25519 + AES-GCM). */
export function wrapEpochKeyForPeer(
  epochKeyHex: string,
  senderPrivateKeyHex: string,
  recipientPublicKeyHex: string,
): string {
  const shared = x25519.getSharedSecret(
    hexToBytes(senderPrivateKeyHex),
    hexToBytes(recipientPublicKeyHex),
  );
  const wrapKey = hkdf(sha256, shared, undefined, utf8ToBytes("ztc-epoch-v1"), 32);
  const nonce = randomBytes(12);
  const aes = gcm(wrapKey, nonce);
  const ct = aes.encrypt(utf8ToBytes(JSON.stringify({ key: epochKeyHex })));
  return `${bytesToHex(nonce)}.${bytesToHex(ct)}`;
}

export function unwrapEpochKeyFromPeer(
  wrapped: string,
  recipientPrivateKeyHex: string,
  senderPublicKeyHex: string,
): string {
  const [nonceHex, ctHex] = wrapped.split(".");
  if (!nonceHex || !ctHex) throw new Error("Invalid epoch wrap format");
  const shared = x25519.getSharedSecret(
    hexToBytes(recipientPrivateKeyHex),
    hexToBytes(senderPublicKeyHex),
  );
  const wrapKey = hkdf(sha256, shared, undefined, utf8ToBytes("ztc-epoch-v1"), 32);
  const aes = gcm(wrapKey, hexToBytes(nonceHex));
  const parsed = JSON.parse(bytesToUtf8(aes.decrypt(hexToBytes(ctHex)))) as { key: string };
  if (!parsed.key) throw new Error("Epoch wrap missing key");
  return parsed.key;
}

export interface EpochAnnouncementFields {
  groupId: string;
  name: string;
  epoch: number;
  prevEpoch: number;
  members: string[];
  epochId: string;
  changerId: string;
}

/** Canonical bytes for epoch signatures (stable key order, sorted members). */
export function canonicalizeEpochAnnouncement(fields: EpochAnnouncementFields): string {
  return JSON.stringify({
    groupId: fields.groupId,
    name: fields.name,
    epoch: fields.epoch,
    prevEpoch: fields.prevEpoch,
    members: [...fields.members].sort(),
    epochId: fields.epochId,
    changerId: fields.changerId,
  });
}

export function signEpochAnnouncement(
  fields: EpochAnnouncementFields,
  signingPrivateKeyHex: string,
): string {
  return signMessage(canonicalizeEpochAnnouncement(fields), signingPrivateKeyHex);
}

export function verifyEpochAnnouncement(
  fields: EpochAnnouncementFields,
  signatureHex: string,
  signingPublicKeyHex: string,
): boolean {
  return verifyMessage(canonicalizeEpochAnnouncement(fields), signatureHex, signingPublicKeyHex);
}

export interface IdentityBackupPayload {
  v: 1;
  peerId: string;
  publicKey: string;
  privateKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  displayName: string;
}

/**
 * Passphrase-sealed identity backup for simple multi-device restore.
 * Does not include per-install deviceId — each device keeps its own.
 */
export function sealIdentityBackup(identity: IdentityBackupPayload, passphrase: string): string {
  if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
  const salt = randomBytes(16);
  const key = hkdf(sha256, utf8ToBytes(passphrase), salt, utf8ToBytes("ztc-identity-backup-v1"), 32);
  const nonce = randomBytes(12);
  const aes = gcm(key, nonce);
  const ct = aes.encrypt(utf8ToBytes(JSON.stringify(identity)));
  return `ztcbackup1:${btoa(
    JSON.stringify({
      salt: bytesToHex(salt),
      nonce: bytesToHex(nonce),
      ct: bytesToHex(ct),
    }),
  )}`;
}

export function openIdentityBackup(sealed: string, passphrase: string): IdentityBackupPayload {
  if (!sealed.startsWith("ztcbackup1:")) throw new Error("Invalid backup format");
  const parsed = JSON.parse(atob(sealed.slice("ztcbackup1:".length))) as {
    salt: string;
    nonce: string;
    ct: string;
  };
  const key = hkdf(
    sha256,
    utf8ToBytes(passphrase),
    hexToBytes(parsed.salt),
    utf8ToBytes("ztc-identity-backup-v1"),
    32,
  );
  const aes = gcm(key, hexToBytes(parsed.nonce));
  const plain = bytesToUtf8(aes.decrypt(hexToBytes(parsed.ct)));
  const identity = JSON.parse(plain) as IdentityBackupPayload;
  if (identity.v !== 1 || !identity.peerId || !identity.privateKey || !identity.signingPrivateKey) {
    throw new Error("Malformed identity backup");
  }
  return identity;
}

/** Encrypt opaque key material for ephemeral server storage (already wrapped). */
export function toBase64(hex: string): string {
  const bytes = hexToBytes(hex);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytesToHex(bytes);
}

export interface Ed25519KeyPair {
  publicKey: string; // hex
  privateKey: string; // hex
}

export function generateSigningKeyPair(): Ed25519KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey: bytesToHex(privateKey), publicKey: bytesToHex(publicKey) };
}

/** Sign an arbitrary UTF-8 message (typically canonical JSON). */
export function signMessage(message: string, privateKeyHex: string): string {
  const sig = ed25519.sign(utf8ToBytes(message), hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

export function verifyMessage(
  message: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/**
 * Prototype-only developer public key embedded in official clients.
 * Used to verify signed network manifests. Private key lives only on the
 * official bootstrap server (see apps/server). Rotate for production.
 */
export const EMBEDDED_DEVELOPER_PUBLIC_KEY =
  "7133411ff89d3983863648858ded072bcdfd9bc3e230150af0c22aff00c37513";

export { bytesToHex, hexToBytes, uuid, randomBytes };
export {
  generateIntroCode,
  parseIntroCode,
  beginCPace,
  finishCPace,
  shareToHex,
  sealIntroIdentity,
  openIntroIdentity,
  encodeIntroFrame,
  decodeIntroFrame,
  type IntroIdentityPayload,
  type CPaceLocalState,
  type IntroWireFrame,
} from "./intro.js";
