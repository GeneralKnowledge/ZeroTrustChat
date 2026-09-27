import { describe, expect, it } from "vitest";
import {
  beginCPace,
  finishCPace,
  generateIntroCode,
  openIntroIdentity,
  parseIntroCode,
  sealIntroIdentity,
  shareToHex,
  encodeIntroFrame,
  decodeIntroFrame,
} from "./intro.js";

describe("intro short codes", () => {
  it("round-trips generate/parse", () => {
    const { nameplate, code } = generateIntroCode();
    expect(code.startsWith(`${nameplate}-`)).toBe(true);
    const parsed = parseIntroCode(code);
    expect(parsed.nameplate).toBe(nameplate);
    expect(parsed.code).toBe(code);
  });

  it("rejects malformed codes", () => {
    expect(() => parseIntroCode("not-a-code")).toThrow(/Invalid short code/);
    expect(() => parseIntroCode("0123-quiet-otter")).toThrow(/Invalid short code/);
  });
});

describe("CPace intro handshake", () => {
  it("both sides derive the same ISK and seal identity", () => {
    const { code } = generateIntroCode();
    const alice = beginCPace(code, "initiator");
    const bob = beginCPace(code, "responder");
    const aliceIsk = finishCPace(alice, shareToHex(bob.share));
    const bobIsk = finishCPace(bob, shareToHex(alice.share));
    expect(Buffer.from(aliceIsk).equals(Buffer.from(bobIsk))).toBe(true);

    const sealed = sealIntroIdentity(aliceIsk, {
      v: 1,
      peerId: "aaaaaaaaaaaaaaaa",
      publicKey: "bbbbbbbbbbbbbbbb",
      signingPublicKey: "cccccccccccccccc",
      displayName: "quiet-otter-100",
    });
    const opened = openIntroIdentity(bobIsk, sealed);
    expect(opened.displayName).toBe("quiet-otter-100");
    expect(opened.peerId).toBe("aaaaaaaaaaaaaaaa");
  });

  it("wrong code yields divergent keys / failed open", () => {
    const alice = beginCPace("1000-quiet-otter", "initiator");
    const bob = beginCPace("1000-quiet-fox", "responder");
    const aliceIsk = finishCPace(alice, shareToHex(bob.share));
    const bobIsk = finishCPace(bob, shareToHex(alice.share));
    expect(Buffer.from(aliceIsk).equals(Buffer.from(bobIsk))).toBe(false);
    const sealed = sealIntroIdentity(aliceIsk, {
      v: 1,
      peerId: "peer-aaaaaaaaaaaa",
      publicKey: "pub",
      signingPublicKey: "sig",
      displayName: "x",
    });
    expect(() => openIntroIdentity(bobIsk, sealed)).toThrow();
  });

  it("encodes opaque wire frames as hex JSON", () => {
    const opaque = encodeIntroFrame({ v: 1, phase: "cpace_share", share: "abcd" });
    expect(decodeIntroFrame(opaque)).toEqual({ v: 1, phase: "cpace_share", share: "abcd" });
  });
});
