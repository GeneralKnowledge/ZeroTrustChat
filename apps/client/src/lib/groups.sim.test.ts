import { afterEach, describe, expect, it } from "vitest";
import { generateGroupEpochKey } from "@ztc/crypto";
import { DEFAULT_FANOUT, DEFAULT_MAX_DEGREE } from "./groupTopology";
import { FakeP2pHub } from "./test/fakeP2p";
import {
  advanceAntiEntropy,
  createSimPeer,
  groupMessageIds,
  linkContacts,
  type SimPeer,
} from "./test/simPeer";

function seedGroupOnAll(
  peers: SimPeer[],
  groupId: string,
  name: string,
  members: string[],
  epoch = 1,
): void {
  const epochKey = generateGroupEpochKey(groupId, epoch, members);
  for (const p of peers) {
    p.store.saveGroup({
      groupId,
      name,
      epoch,
      membersJson: JSON.stringify(members),
      epochKeyHex: epochKey.key,
      createdAt: Date.now(),
    });
  }
}

describe("GroupService FakeP2P simulation", () => {
  const peersToStop: SimPeer[] = [];

  afterEach(() => {
    for (const p of peersToStop) {
      p.groups.stop();
      p.messaging.stop();
    }
    peersToStop.length = 0;
  });

  function track(...peers: SimPeer[]): SimPeer[] {
    peersToStop.push(...peers);
    return peers;
  }

  it("create group → all connected members decrypt", async () => {
    const hub = new FakeP2pHub();
    const alice = createSimPeer(hub, "alice");
    const bob = createSimPeer(hub, "bob");
    const carol = createSimPeer(hub, "carol");
    track(alice, bob, carol);
    linkContacts([alice, bob, carol]);
    hub.fullyConnect([alice.identity.peerId, bob.identity.peerId, carol.identity.peerId]);

    const groupId = alice.groups.createGroup("trio", [
      bob.identity.peerId,
      carol.identity.peerId,
    ]);
    expect(bob.store.getGroup(groupId)?.epochKeyHex).toBeTruthy();
    expect(carol.store.getGroup(groupId)?.epochKeyHex).toBeTruthy();

    const mid = alice.groups.sendGroupMessage(groupId, "hello-group");
    expect(bob.store.getMessage(mid)?.plaintextCache).toContain("hello-group");
    expect(carol.store.getMessage(mid)?.plaintextCache).toContain("hello-group");
  });

  it("membership remove → removed peer cannot decrypt next epoch", async () => {
    const hub = new FakeP2pHub();
    const alice = createSimPeer(hub, "alice");
    const bob = createSimPeer(hub, "bob");
    const carol = createSimPeer(hub, "carol");
    track(alice, bob, carol);
    linkContacts([alice, bob, carol]);
    hub.fullyConnect([alice.identity.peerId, bob.identity.peerId, carol.identity.peerId]);

    const groupId = alice.groups.createGroup("drop", [
      bob.identity.peerId,
      carol.identity.peerId,
    ]);
    const oldKey = carol.store.getGroup(groupId)!.epochKeyHex;
    alice.groups.updateMembership(groupId, [bob.identity.peerId]);

    expect(bob.store.getGroup(groupId)!.epoch).toBe(2);
    expect(bob.store.getGroup(groupId)!.epochKeyHex).not.toBe(oldKey);
    // Carol never receives the new wrapped key (not in membership)
    expect(carol.store.getGroup(groupId)!.epochKeyHex).toBe(oldKey);

    const mid = alice.groups.sendGroupMessage(groupId, "after-remove");
    expect(bob.store.getMessage(mid)?.plaintextCache).toContain("after-remove");
    // Carol may see ciphertext via residual edges but cannot decrypt epoch-2 with epoch-1 key
    const carolMsg = carol.store.getMessage(mid);
    expect(carolMsg?.plaintextCache ?? null).toBeNull();
  });

  it("small-N: fanout then digest rounds converge message sets", async () => {
    const hub = new FakeP2pHub();
    const n = 5;
    const peers = track(
      ...Array.from({ length: n }, (_, i) => createSimPeer(hub, `p${i}`)),
    );
    linkContacts(peers);
    const ids = peers.map((p) => p.identity.peerId);
    hub.fullyConnect(ids);

    const groupId = peers[0]!.groups.createGroup("five", ids.slice(1));
    const mid = peers[0]!.groups.sendGroupMessage(groupId, "converge-me");

    // Immediate neighbors get it; after a few anti-entropy rounds everyone has it
    await advanceAntiEntropy(peers, 4);
    for (const p of peers) {
      expect(groupMessageIds(p, groupId).has(mid)).toBe(true);
    }
  });

  it("partition heal: each side converges, then anti-entropy merges", async () => {
    const hub = new FakeP2pHub();
    const peers = track(
      ...Array.from({ length: 6 }, (_, i) => createSimPeer(hub, `g${i}`)),
    );
    linkContacts(peers);
    const ids = peers.map((p) => p.identity.peerId);
    const groupId = "partition-g";
    seedGroupOnAll(peers, groupId, "part", ids);

    const left = peers.slice(0, 3);
    const right = peers.slice(3);
    hub.partition([left.map((p) => p.identity.peerId), right.map((p) => p.identity.peerId)]);
    hub.fullyConnect(left.map((p) => p.identity.peerId));
    hub.fullyConnect(right.map((p) => p.identity.peerId));

    const midL = left[0]!.groups.sendGroupMessage(groupId, "left-only");
    const midR = right[0]!.groups.sendGroupMessage(groupId, "right-only");
    await advanceAntiEntropy(left, 3);
    await advanceAntiEntropy(right, 3);

    for (const p of left) expect(groupMessageIds(p, groupId).has(midL)).toBe(true);
    for (const p of right) expect(groupMessageIds(p, groupId).has(midR)).toBe(true);
    for (const p of left) expect(groupMessageIds(p, groupId).has(midR)).toBe(false);
    for (const p of right) expect(groupMessageIds(p, groupId).has(midL)).toBe(false);

    hub.healPartitions();
    // Bridge the two components
    hub.connect(left[0]!.identity.peerId, right[0]!.identity.peerId);
    await advanceAntiEntropy(peers, 8);

    for (const p of peers) {
      const set = groupMessageIds(p, groupId);
      expect(set.has(midL)).toBe(true);
      expect(set.has(midR)).toBe(true);
    }
  });

  it("forward storm control: same messageId not re-forwarded forever", async () => {
    const hub = new FakeP2pHub();
    const peers = track(
      ...Array.from({ length: 4 }, (_, i) => createSimPeer(hub, `s${i}`)),
    );
    linkContacts(peers);
    const ids = peers.map((p) => p.identity.peerId);
    hub.fullyConnect(ids);
    const groupId = peers[0]!.groups.createGroup("storm", ids.slice(1));
    const before = hub.deliveryLog.length;
    const mid = peers[0]!.groups.sendGroupMessage(groupId, "once");
    await advanceAntiEntropy(peers, 6);
    const chatSends = hub.deliveryLog
      .slice(before)
      .filter((d) => d.kind === "group_chat" && d.messageId === mid).length;
    // Bound: even with full mesh + forwards, should not explode (fanout*depth, not exponential forever)
    expect(chatSends).toBeLessThan(40);
    // Service-level: each peer has exactly one copy
    for (const p of peers) {
      expect(p.store.listMessages(`group:${groupId}`).filter((m) => m.messageId === mid)).toHaveLength(1);
    }
  });

  it("large-N: origin fanout ≤ 3, degree ≤ 8, ≥95% converge", async () => {
    const hub = new FakeP2pHub();
    const n = 25;
    const peers = track(
      ...Array.from({ length: n }, (_, i) => createSimPeer(hub, `L${i}`)),
    );
    linkContacts(peers);
    const ids = peers.map((p) => p.identity.peerId);
    const groupId = "large-g";
    seedGroupOnAll(peers, groupId, "large", ids);

    // Regular sparse mesh with degree ≤ MAX (ring + chords) — O(degree) not O(N)
    const half = Math.floor(DEFAULT_MAX_DEGREE / 2);
    for (let i = 0; i < n; i++) {
      for (let d = 1; d <= half; d++) {
        hub.connect(ids[i]!, ids[(i + d) % n]!);
      }
    }
    for (const p of peers) p.groups.start();

    const origin = peers[0]!;
    const before = hub.deliveryLog.length;
    const mid = origin.groups.sendGroupMessage(groupId, "scale-msg");
    const originFanout = hub.metrics().originFanout(origin.identity.peerId, mid);
    expect(originFanout).toBeLessThanOrEqual(DEFAULT_FANOUT);
    expect(originFanout).toBeGreaterThan(0);

    let roundsTo95 = -1;
    let roundsTo100 = -1;
    const maxRounds = 25;
    for (let r = 1; r <= maxRounds; r++) {
      await advanceAntiEntropy(peers, 1);
      const have = peers.filter((p) => groupMessageIds(p, groupId).has(mid)).length;
      const pct = have / n;
      if (roundsTo95 < 0 && pct >= 0.95) roundsTo95 = r;
      if (roundsTo100 < 0 && pct >= 1) {
        roundsTo100 = r;
        break;
      }
    }

    const report = {
      originFanout,
      maxDegreeObserved: hub.metrics().maxDegreeObserved(),
      roundsTo95pct: roundsTo95,
      roundsTo100pct: roundsTo100,
      duplicateDeliveries: hub.metrics().duplicateDeliveries(mid),
      wireSendsAfter: hub.deliveryLog.length - before,
    };

    expect(report.maxDegreeObserved).toBeLessThanOrEqual(DEFAULT_MAX_DEGREE);
    expect(report.roundsTo95pct).toBeGreaterThan(0);
    expect(report.roundsTo100pct).toBeGreaterThan(0);
    expect(report.roundsTo100pct).toBeLessThanOrEqual(maxRounds);
    for (const p of peers) {
      expect(p.store.listMessages(`group:${groupId}`).filter((m) => m.messageId === mid)).toHaveLength(1);
    }
  });

  it("multi-device: distinct deviceId namespaces senderSeq without digest clash", async () => {
    const hub = new FakeP2pHub();
    const alice = createSimPeer(hub, "alice");
    const bob = createSimPeer(hub, "bob");
    track(alice, bob);
    linkContacts([alice, bob]);
    hub.connect(alice.identity.peerId, bob.identity.peerId);

    const groupId = alice.groups.createGroup("md", [bob.identity.peerId]);
    const m1 = alice.groups.sendGroupMessage(groupId, "from-device-a");
    expect(bob.store.getMessage(m1)?.plaintextCache).toContain("from-device-a");

    // Second device of same identity: inject group_chat with same senderId, other deviceId, seq 1
    const g = alice.store.getGroup(groupId)!;
    const src = alice.store.getMessage(m1)!;
    const payload = {
      groupId,
      epoch: g.epoch,
      messageId: crypto.randomUUID(),
      senderId: alice.identity.peerId,
      senderDeviceId: "device-b",
      senderSeq: 1,
      ciphertext: src.ciphertext,
      nonce: src.nonce,
      createdAt: Date.now(),
      deliveryDeadline: null as number | null,
    };
    alice.p2p.send(bob.identity.peerId, { v: 1, kind: "group_chat", payload });
    expect(bob.store.getMessage(payload.messageId)).not.toBeNull();
    expect(groupMessageIds(bob, groupId).size).toBeGreaterThanOrEqual(2);
  });
});
