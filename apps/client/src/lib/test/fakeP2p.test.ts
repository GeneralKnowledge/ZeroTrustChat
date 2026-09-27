import { describe, expect, it } from "vitest";
import { FakeP2pHub } from "./fakeP2p";
import { DEFAULT_MAX_DEGREE } from "../groupTopology";

describe("FakeP2pHub", () => {
  it("routes 1:1 and respects degree-capped ensureConnections", async () => {
    const hub = new FakeP2pHub();
    const a = hub.createEndpoint("a");
    const b = hub.createEndpoint("b");
    const others = Array.from({ length: 12 }, (_, i) => hub.createEndpoint(`p${i}`));

    let got: unknown = null;
    b.onData((from, env) => {
      got = { from, env };
    });
    hub.connect("a", "b");
    expect(a.send("b", { v: 1, kind: "ping", payload: { ok: true } })).toBe(true);
    expect(got).toEqual({ from: "a", env: { v: 1, kind: "ping", payload: { ok: true } } });

    const targets = others.map((o) => o.peerId);
    const dialed = await a.ensureConnections(targets, DEFAULT_MAX_DEGREE);
    // a already has edge to b → 7 slots left
    expect(dialed.length).toBeLessThanOrEqual(DEFAULT_MAX_DEGREE - 1);
    expect(a.listConnectedPeers().length).toBeLessThanOrEqual(DEFAULT_MAX_DEGREE);
  });

  it("partition blocks cross edges; heal restores ability to connect", () => {
    const hub = new FakeP2pHub();
    hub.createEndpoint("a");
    hub.createEndpoint("b");
    hub.partition([["a"], ["b"]]);
    expect(hub.connect("a", "b")).toBe(false);
    hub.healPartitions();
    expect(hub.connect("a", "b")).toBe(true);
  });
});
