/**
 * Wormhole-style short codes + CPace for one-shot peer introduction.
 * Uses @cipherman/pake-js (CPace on Ristretto255) and @noble AES-GCM for identity wrap.
 */

import { cpace } from "@cipherman/pake-js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from "@noble/hashes/utils.js";

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

const ADJECTIVES = [
  "red", "blue", "green", "amber", "silver", "quiet", "swift", "bold",
  "calm", "bright", "dark", "warm", "cool", "keen", "soft", "wild",
] as const;

const ANIMALS = [
  "otter", "wolf", "fox", "hawk", "bear", "lynx", "seal", "crane",
  "deer", "owl", "raven", "trout", "heron", "falcon", "badger", "mink",
] as const;

const CI = utf8ToBytes("ztc-intro-v1");
const SID_LABEL = utf8ToBytes("ztc-cpace-sid-v1");
const WRAP_INFO = utf8ToBytes("ztc-intro-wrap-v1");

export interface IntroIdentityPayload {
  v: 1;
  peerId: string;
  publicKey: string;
  signingPublicKey: string;
  displayName: string;
}

export interface CPaceLocalState {
  ephemeralSecret: Uint8Array;
  share: Uint8Array;
  role: "initiator" | "responder";
  sid: Uint8Array;
  prs: Uint8Array;
}

export function generateIntroCode(): { nameplate: string; code: string } {
  const npBytes = randomBytes(2);
  const nameplate = String((npBytes[0]! << 8 | npBytes[1]!) % 9000 + 1000);
  const w = randomBytes(2);
  const adj = ADJECTIVES[w[0]! % ADJECTIVES.length]!;
  const animal = ANIMALS[w[1]! % ANIMALS.length]!;
  return { nameplate, code: `${nameplate}-${adj}-${animal}` };
}

export function parseIntroCode(code: string): { nameplate: string; code: string } {
  const normalized = code.trim().toLowerCase();
  const m = /^([1-9][0-9]{0,5})-([a-z]+)-([a-z]+)$/.exec(normalized);
  if (!m) throw new Error("Invalid short code (expected N-word-word)");
  return { nameplate: m[1]!, code: normalized };
}

export function deriveIntroSid(code: string): Uint8Array {
  return sha256(new Uint8Array([...SID_LABEL, ...utf8ToBytes(code)])).slice(0, 16);
}

export function beginCPace(
  code: string,
  role: "initiator" | "responder",
): CPaceLocalState {
  const prs = utf8ToBytes(code);
  const sid = deriveIntroSid(code);
  const local = cpace.ristretto255.init({ PRS: prs, sid, CI });
  return {
    ephemeralSecret: local.ephemeralSecret,
    share: local.share,
    role,
    sid,
    prs,
  };
}

export function finishCPace(local: CPaceLocalState, peerShareHex: string): Uint8Array {
  const peerShare = hexToBytes(peerShareHex);
  return cpace.ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: local.ephemeralSecret,
    ownShare: local.share,
    peerShare,
    sid: local.sid,
    role: local.role,
  });
}

export function shareToHex(share: Uint8Array): string {
  return bytesToHex(share);
}

function wrapKeyFromIsk(isk: Uint8Array): Uint8Array {
  return hkdf(sha256, isk, undefined, WRAP_INFO, 32);
}

export function sealIntroIdentity(isk: Uint8Array, identity: IntroIdentityPayload): string {
  const key = wrapKeyFromIsk(isk);
  const nonce = randomBytes(12);
  const aes = gcm(key, nonce);
  const ct = aes.encrypt(utf8ToBytes(JSON.stringify(identity)));
  return `${bytesToHex(nonce)}.${bytesToHex(ct)}`;
}

export function openIntroIdentity(isk: Uint8Array, sealed: string): IntroIdentityPayload {
  const [nonceHex, ctHex] = sealed.split(".");
  if (!nonceHex || !ctHex) throw new Error("Invalid intro identity blob");
  const key = wrapKeyFromIsk(isk);
  const plain = bytesToUtf8(gcm(key, hexToBytes(nonceHex)).decrypt(hexToBytes(ctHex)));
  const parsed = JSON.parse(plain) as IntroIdentityPayload;
  if (parsed.v !== 1 || !parsed.peerId || !parsed.publicKey) {
    throw new Error("Malformed intro identity");
  }
  return parsed;
}

/** Wire frame kinds exchanged over intro_relay (opaque to server). */
export type IntroWireFrame =
  | { v: 1; phase: "cpace_share"; share: string }
  | { v: 1; phase: "identity"; sealed: string };

export function encodeIntroFrame(frame: IntroWireFrame): string {
  return bytesToHex(utf8ToBytes(JSON.stringify(frame)));
}

export function decodeIntroFrame(opaquePayload: string): IntroWireFrame {
  const parsed = JSON.parse(bytesToUtf8(hexToBytes(opaquePayload))) as IntroWireFrame;
  if (parsed.v !== 1) throw new Error("Unsupported intro frame version");
  if (parsed.phase === "cpace_share" && typeof parsed.share === "string") return parsed;
  if (parsed.phase === "identity" && typeof parsed.sealed === "string") return parsed;
  throw new Error("Malformed intro frame");
}
