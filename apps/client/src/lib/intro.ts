/**
 * One-shot CPace short-code peer introduction over signalling intro_* frames.
 * Never uploads chat — only opaque PAKE shares + sealed identity blobs.
 */

import {
  beginCPace,
  decodeIntroFrame,
  encodeIntroFrame,
  finishCPace,
  generateIntroCode,
  openIntroIdentity,
  parseIntroCode,
  sealIntroIdentity,
  shareToHex,
  type IntroIdentityPayload,
  type IntroWireFrame,
} from "@ztc/crypto";
import type { ServerInterface } from "@ztc/server-interface";
import type { ServerToClientMessage } from "@ztc/protocol";
import type { LocalIdentity } from "./store";

const INTRO_TTL_MS = 5 * 60 * 1000;
const INTRO_TIMEOUT_MS = 90_000;

export interface IntroPeerResult {
  peerId: string;
  publicKey: string;
  signingPublicKey: string | null;
  displayName: string;
  invitationCode: string;
}

function identityPayload(identity: LocalIdentity): IntroIdentityPayload {
  return {
    v: 1,
    peerId: identity.peerId,
    publicKey: identity.publicKey,
    signingPublicKey: identity.signingPublicKey,
    displayName: identity.displayName,
  };
}

type IntroEvent = Extract<
  ServerToClientMessage,
  | { type: "intro_claimed" }
  | { type: "intro_joined" }
  | { type: "intro_peer_joined" }
  | { type: "intro_frame" }
  | { type: "intro_released" }
>;

/** Subscribe early and buffer so frames cannot race past waiters. */
class IntroSession {
  private readonly queue: IntroEvent[] = [];
  private readonly waiters: Array<{
    pred: (m: IntroEvent) => boolean;
    resolve: (m: IntroEvent) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly unsub: () => void;
  private readonly unsubErr: () => void;
  private closed = false;

  constructor(si: ServerInterface) {
    this.unsub = si.onIntro((msg) => this.push(msg));
    this.unsubErr = si.onError((err) => {
      if (
        err.code === "intro_crowded" ||
        err.code === "intro_expired" ||
        err.code === "intro_not_found"
      ) {
        this.failAll(new Error(err.message));
      }
    });
  }

  private push(msg: IntroEvent): void {
    if (this.closed) return;
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w!.timer);
      w!.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  wait(pred: (m: IntroEvent) => boolean, timeoutMs = INTRO_TIMEOUT_MS): Promise<IntroEvent> {
    if (this.closed) return Promise.reject(new Error("Intro session closed"));
    const queuedIdx = this.queue.findIndex(pred);
    if (queuedIdx >= 0) {
      const [msg] = this.queue.splice(queuedIdx, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("Intro timed out"));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  async waitFrame(
    nameplate: string,
    phase: IntroWireFrame["phase"],
  ): Promise<IntroWireFrame> {
    const msg = await this.wait((m) => {
      if (m.type !== "intro_frame" || m.nameplate !== nameplate) return false;
      try {
        return decodeIntroFrame(m.opaquePayload).phase === phase;
      } catch {
        return false;
      }
    });
    if (msg.type !== "intro_frame") throw new Error("Expected intro_frame");
    return decodeIntroFrame(msg.opaquePayload);
  }

  private failAll(err: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.length = 0;
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("Intro session closed"));
    this.unsub();
    this.unsubErr();
  }
}

export class IntroService {
  private readonly si: ServerInterface;
  private readonly identity: LocalIdentity;

  constructor(si: ServerInterface, identity: LocalIdentity) {
    this.si = si;
    this.identity = identity;
  }

  /** Host: create spoken code, wait for joiner, exchange CPace + identity. */
  async host(opts?: { onCode?: (code: string) => void }): Promise<{ code: string; peer: IntroPeerResult }> {
    const session = new IntroSession(this.si);
    try {
      const { nameplate, code } = generateIntroCode();
      opts?.onCode?.(code);
      const expiresAt = Date.now() + INTRO_TTL_MS;

      await this.si.introClaim(nameplate, expiresAt);
      await session.wait((m) => m.type === "intro_claimed" && m.nameplate === nameplate);
      await session.wait((m) => m.type === "intro_peer_joined" && m.nameplate === nameplate);

      const local = beginCPace(code, "initiator");
      await this.si.introRelay(
        nameplate,
        encodeIntroFrame({ v: 1, phase: "cpace_share", share: shareToHex(local.share) }),
      );

      const theirShare = await session.waitFrame(nameplate, "cpace_share");
      if (theirShare.phase !== "cpace_share") throw new Error("Expected CPace share");
      const isk = finishCPace(local, theirShare.share);

      await this.si.introRelay(
        nameplate,
        encodeIntroFrame({
          v: 1,
          phase: "identity",
          sealed: sealIntroIdentity(isk, identityPayload(this.identity)),
        }),
      );

      const theirId = await session.waitFrame(nameplate, "identity");
      if (theirId.phase !== "identity") throw new Error("Expected identity");
      const peerIdPayload = openIntroIdentity(isk, theirId.sealed);

      await this.si.introRelease(nameplate);
      return { code, peer: toResult(peerIdPayload, code) };
    } finally {
      session.close();
    }
  }

  /** Join: enter spoken code, complete CPace + identity. */
  async join(codeInput: string): Promise<IntroPeerResult> {
    const session = new IntroSession(this.si);
    try {
      const { nameplate, code } = parseIntroCode(codeInput);
      await this.si.introJoin(nameplate);
      await session.wait((m) => m.type === "intro_joined" && m.nameplate === nameplate);

      const theirShare = await session.waitFrame(nameplate, "cpace_share");
      if (theirShare.phase !== "cpace_share") throw new Error("Expected CPace share");

      const local = beginCPace(code, "responder");
      await this.si.introRelay(
        nameplate,
        encodeIntroFrame({ v: 1, phase: "cpace_share", share: shareToHex(local.share) }),
      );
      const isk = finishCPace(local, theirShare.share);

      const theirId = await session.waitFrame(nameplate, "identity");
      if (theirId.phase !== "identity") throw new Error("Expected identity");
      const peerIdPayload = openIntroIdentity(isk, theirId.sealed);

      await this.si.introRelay(
        nameplate,
        encodeIntroFrame({
          v: 1,
          phase: "identity",
          sealed: sealIntroIdentity(isk, identityPayload(this.identity)),
        }),
      );

      await this.si.introRelease(nameplate);
      return toResult(peerIdPayload, code);
    } finally {
      session.close();
    }
  }
}

function toResult(p: IntroIdentityPayload, code: string): IntroPeerResult {
  return {
    peerId: p.peerId,
    publicKey: p.publicKey,
    signingPublicKey: p.signingPublicKey,
    displayName: p.displayName,
    invitationCode: code,
  };
}
