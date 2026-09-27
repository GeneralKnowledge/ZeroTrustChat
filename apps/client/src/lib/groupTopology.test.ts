import { describe, expect, it } from "vitest";
import {
  buildGroupsByPeer,
  pickFanoutTargets,
  pickPeersToDial,
  rankPeersForPool,
  DEFAULT_MAX_DEGREE,
} from "./groupTopology";

describe("shared connection pool", () => {
  it("ranks peers that cover more groups higher", () => {
    const groupsByPeer = new Map<string, string[]>([
      ["bob", ["g1", "g2", "g3"]],
      ["carol", ["g1"]],
      ["dave", ["g2"]],
    ]);
    const ranked = rankPeersForPool({
      localPeerId: "alice",
      candidates: ["bob", "carol", "dave"],
      groupsByPeer,
      connected: new Set(),
      timeBucket: 0,
    });
    expect(ranked[0]).toBe("bob");
  });

  it("prefers already-connected peers", () => {
    const groupsByPeer = new Map<string, string[]>([
      ["bob", ["g1"]],
      ["carol", ["g1", "g2"]],
    ]);
    const ranked = rankPeersForPool({
      localPeerId: "alice",
      candidates: ["bob", "carol"],
      groupsByPeer,
      connected: new Set(["bob"]),
      timeBucket: 0,
    });
    expect(ranked[0]).toBe("bob");
  });

  it("does not dial beyond degree budget", () => {
    const ranked = Array.from({ length: 20 }, (_, i) => `peer${i}`);
    const connected = new Set(["peer0", "peer1"]);
    const connecting = new Set(["peer2"]);
    const dial = pickPeersToDial(ranked, connected, connecting, 5, 8);
    // maxDegree 5, used 3 → 2 slots
    expect(dial.length).toBeLessThanOrEqual(2);
    expect(dial).not.toContain("peer0");
    expect(dial).not.toContain("peer2");
  });

  it("fanout stays bounded", () => {
    const members = ["a", "b", "c", "d", "e", "f"];
    const targets = pickFanoutTargets(members, new Set(["a"]), 3);
    expect(targets).not.toContain("a");
    expect(targets.length).toBe(3);
  });

  it("buildGroupsByPeer unions membership", () => {
    const map = buildGroupsByPeer("alice", [
      { groupId: "g1", members: ["alice", "bob", "carol"] },
      { groupId: "g2", members: ["alice", "bob"] },
    ]);
    expect(map.get("bob")?.sort()).toEqual(["g1", "g2"]);
    expect(map.get("carol")).toEqual(["g1"]);
    expect(map.has("alice")).toBe(false);
  });

  it("default max degree is small vs full mesh", () => {
    expect(DEFAULT_MAX_DEGREE).toBeLessThan(20);
  });
});
