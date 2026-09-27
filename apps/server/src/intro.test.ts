/**
 * Integration: CPace short-code intro over real signalling + contact counting.
 * Uses @ztc/crypto + ServerInterface directly (no client UI import).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginCPace,
  decodeIntroFrame,
  encodeIntroFrame,
  finishCPace,
  generateIdentity,
  generateIntroCode,
  openIntroIdentity,
  sealIntroIdentity,
  shareToHex,
} from "@ztc/crypto";
import { ServerInterface } from "@ztc/server-interface";
import { SignallingServer } from "./index.js";

async function connectSi(port: number, peerId: string): Promise<ServerInterface> {
  const si = new ServerInterface({ url: `ws://127.0.0.1:${port}` });
  await si.connect();
  await si.registerEphemeralSession(peerId);
  await si.publishPresence("online");
  return si;
}

function waitIntro(
  si: ServerInterface,
  pred: (m: { type: string; nameplate?: string; opaquePayload?: string }) => boolean,
  ms = 15_000,
): Promise<{ type: string; nameplate?: string; opaquePayload?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error("timeout"));
    }, ms);
    const unsub = si.onIntro((msg) => {
      if (!pred(msg)) return;
      clearTimeout(t);
      unsub();
      resolve(msg);
    });
  });
}

describe("CPace intro over signalling", () => {
  const servers: SignallingServer[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  it("hosts and joins with few essential server contacts; health stays zero messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ztc-intro-"));
    const server = new SignallingServer();
    servers.push(server);
    const port = 18_000 + Math.floor(Math.random() * 1000);
    server.start(port, join(dir, "dev.sqlite"));
    await new Promise((r) => setTimeout(r, 80));

    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceSi = await connectSi(port, alice.peerId);
    const bobSi = await connectSi(port, bob.peerId);
    aliceSi.resetServerContactStats();
    bobSi.resetServerContactStats();

    const { nameplate, code } = generateIntroCode();
    const expiresAt = Date.now() + 5 * 60_000;

    const aliceClaimed = waitIntro(aliceSi, (m) => m.type === "intro_claimed");
    await aliceSi.introClaim(nameplate, expiresAt);
    await aliceClaimed;

    const alicePeerJoined = waitIntro(aliceSi, (m) => m.type === "intro_peer_joined");
    const bobJoined = waitIntro(bobSi, (m) => m.type === "intro_joined");
    await bobSi.introJoin(nameplate);
    await Promise.all([alicePeerJoined, bobJoined]);

    const bobShareWait = waitIntro(bobSi, (m) => m.type === "intro_frame");
    const aliceLocal = beginCPace(code, "initiator");
    await aliceSi.introRelay(
      nameplate,
      encodeIntroFrame({ v: 1, phase: "cpace_share", share: shareToHex(aliceLocal.share) }),
    );
    const bobGotShare = await bobShareWait;
    const bobShareFrame = decodeIntroFrame(bobGotShare.opaquePayload!);
    if (bobShareFrame.phase !== "cpace_share") throw new Error("expected share");

    const aliceShareWait = waitIntro(aliceSi, (m) => m.type === "intro_frame");
    const bobLocal = beginCPace(code, "responder");
    await bobSi.introRelay(
      nameplate,
      encodeIntroFrame({ v: 1, phase: "cpace_share", share: shareToHex(bobLocal.share) }),
    );
    const aliceGotShare = await aliceShareWait;
    const aliceShareFrame = decodeIntroFrame(aliceGotShare.opaquePayload!);
    if (aliceShareFrame.phase !== "cpace_share") throw new Error("expected share");

    const aliceIsk = finishCPace(aliceLocal, aliceShareFrame.share);
    const bobIsk = finishCPace(bobLocal, bobShareFrame.share);

    const bobIdWait = waitIntro(bobSi, (m) => m.type === "intro_frame");
    await aliceSi.introRelay(
      nameplate,
      encodeIntroFrame({
        v: 1,
        phase: "identity",
        sealed: sealIntroIdentity(aliceIsk, {
          v: 1,
          peerId: alice.peerId,
          publicKey: alice.publicKey,
          signingPublicKey: alice.signingPublicKey,
          displayName: alice.displayName,
        }),
      }),
    );
    const bobGotId = await bobIdWait;
    const bobIdFrame = decodeIntroFrame(bobGotId.opaquePayload!);
    if (bobIdFrame.phase !== "identity") throw new Error("expected id");
    const aliceFromBob = openIntroIdentity(bobIsk, bobIdFrame.sealed);
    expect(aliceFromBob.peerId).toBe(alice.peerId);

    const aliceIdWait = waitIntro(aliceSi, (m) => m.type === "intro_frame");
    await bobSi.introRelay(
      nameplate,
      encodeIntroFrame({
        v: 1,
        phase: "identity",
        sealed: sealIntroIdentity(bobIsk, {
          v: 1,
          peerId: bob.peerId,
          publicKey: bob.publicKey,
          signingPublicKey: bob.signingPublicKey,
          displayName: bob.displayName,
        }),
      }),
    );
    const aliceGotId = await aliceIdWait;
    const aliceIdFrame = decodeIntroFrame(aliceGotId.opaquePayload!);
    if (aliceIdFrame.phase !== "identity") throw new Error("expected id");
    expect(openIntroIdentity(aliceIsk, aliceIdFrame.sealed).peerId).toBe(bob.peerId);

    await aliceSi.introRelease(nameplate);
    await bobSi.introRelease(nameplate);

    const aliceContacts = aliceSi.getServerContactStats();
    const bobContacts = bobSi.getServerContactStats();
    expect(aliceContacts.essential).toBeLessThanOrEqual(6);
    expect(bobContacts.essential).toBeLessThanOrEqual(6);
    expect(aliceContacts.byType.intro_claim).toBe(1);
    expect(bobContacts.byType.intro_join).toBe(1);
    expect(aliceContacts.byType.intro_relay).toBe(2);
    expect(bobContacts.byType.intro_relay).toBe(2);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.messagesStored).toBe(0);
    expect(health.messagePlaintextReceived).toBe(0);
    expect(health.contactListsReceived).toBe(0);
    expect(health.privateKeysReceived).toBe(0);

    await aliceSi.disconnect();
    await bobSi.disconnect();
  }, 30_000);
});
