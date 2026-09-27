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
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from "@noble/hashes/utils.js";
import { generateDisplayName } from "@ztc/shared";

export interface IdentityKeyPair {
  publicKey: string; // hex
  privateKey: string; // hex
  peerId: string; // public key hex used as peer identity
  displayName: string;
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
  const nameBytes = randomBytes(4);
  return {
    publicKey: publicHex,
    privateKey: bytesToHex(privateKey),
    peerId: publicHex,
    displayName: generateDisplayName(nameBytes),
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

export { bytesToHex, hexToBytes, uuid, randomBytes };
