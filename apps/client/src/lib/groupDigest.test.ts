import { describe, expect, it } from "vitest";
import {
  buildGroupDigest,
  computeOffers,
  computeWants,
  type IndexedGroupMessage,
} from "./groupDigest";

function msgs(
  entries: Array<[senderId: string, seq: number, id?: string]>,
): IndexedGroupMessage[] {
  return entries.map(([senderId, senderSeq, messageId], i) => ({
    messageId: messageId ?? `m${i}`,
    senderId,
    senderSeq,
    epoch: 1,
  }));
}

describe("compressed group digests", () => {
  it("builds per-sender maxSeq and gaps", () => {
    const digest = buildGroupDigest(
      "g1",
      1,
      msgs([
        ["alice", 1],
        ["alice", 2],
        ["alice", 4],
        ["bob", 1],
      ]),
    );
    expect(digest.messageCount).toBe(4);
    const alice = digest.senders.find((s) => s.senderId === "alice")!;
    expect(alice.maxSeq).toBe(4);
    expect(alice.gaps).toContain(3);
    expect(alice.gaps).not.toContain(1);
  });

  it("computeWants requests sequences remote has and local lacks", () => {
    const local = msgs([
      ["alice", 1],
      ["alice", 2],
    ]);
    const remote = buildGroupDigest(
      "g1",
      1,
      msgs([
        ["alice", 1],
        ["alice", 2],
        ["alice", 3],
        ["alice", 4],
      ]),
    );
    const wants = computeWants(local, remote);
    expect(wants.map((w) => w.seq).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("computeWants does not request remote gaps", () => {
    const local = msgs([["alice", 1]]);
    // remote has 1,2,4 (missing 3)
    const remote = buildGroupDigest("g1", 1, msgs([
      ["alice", 1],
      ["alice", 2],
      ["alice", 4],
    ]));
    const wants = computeWants(local, remote);
    expect(wants.find((w) => w.seq === 3)).toBeUndefined();
    expect(wants.map((w) => w.seq).sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it("computeOffers pushes what remote is missing", () => {
    const local = msgs([
      ["alice", 1],
      ["alice", 2],
      ["alice", 3],
    ]);
    const remote = buildGroupDigest("g1", 1, msgs([["alice", 1]]));
    const offers = computeOffers(local, remote);
    expect(offers.map((o) => o.seq).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("ignores messages without senderSeq", () => {
    const digest = buildGroupDigest("g1", 1, [
      { messageId: "x", senderId: "alice", senderSeq: 0, epoch: 1 },
    ]);
    expect(digest.senders).toEqual([]);
    expect(digest.messageCount).toBe(1);
  });
});
