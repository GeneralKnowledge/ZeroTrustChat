import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { SignallingServer } from "./index.js";

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.once("message", (d) => {
      clearTimeout(t);
      resolve(JSON.parse(d.toString()));
    });
  });
}

describe("SignallingServer", () => {
  let server: SignallingServer;
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ztc-"));
    port = 18000 + Math.floor(Math.random() * 1000);
    server = new SignallingServer();
    server.start(port, join(dir, "test.sqlite"));
    // wait until health responds
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects forbidden store_message", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => ws.once("open", () => res()));
    ws.send(JSON.stringify({ type: "store_message", body: "hello" }));
    const msg = (await waitForMessage(ws)) as { type: string; code: string };
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("forbidden_operation");
    ws.close();
  });

  it("rejects unknown fields on register", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => ws.once("open", () => res()));
    ws.send(
      JSON.stringify({
        type: "register_session",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        peerId: "peer-alice-xxxxxxxx",
        expiresAt: Date.now() + 60_000,
        plaintext: "nope",
      }),
    );
    const msg = (await waitForMessage(ws)) as { code: string };
    expect(msg.code).toBe("unexpected_fields");
    ws.close();
  });

  it("never has a messages table and stats show zero storage", async () => {
    expect(server.getMessageTableCount()).toBe(0);
    const stats = server.getStats();
    expect(stats.messagesStored).toBe(0);
    expect(stats.messagePlaintextReceived).toBe(0);
    expect(stats.contactListsReceived).toBe(0);
    expect(stats.privateKeysReceived).toBe(0);
  });

  it("expires ephemeral keys", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => ws.once("open", () => res()));
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";
    ws.send(
      JSON.stringify({
        type: "register_session",
        sessionId,
        peerId: "peer-bob-yyyyyyyyyy",
        expiresAt: Date.now() + 60_000,
      }),
    );
    await waitForMessage(ws);

    const keyId = "550e8400-e29b-41d4-a716-446655440099";
    ws.send(
      JSON.stringify({
        type: "publish_ephemeral_key",
        sessionId,
        keyId,
        encryptedKeyMaterial: "aabbccddee",
        expiresAt: Date.now() - 1,
        singleUse: true,
      }),
    );
    await waitForMessage(ws);

    ws.send(JSON.stringify({ type: "retrieve_ephemeral_key", sessionId, keyId }));
    const retrieved = (await waitForMessage(ws)) as { type: string };
    expect(retrieved.type).toBe("ephemeral_key_missing");
    ws.close();
  });

  it("relays signalling without storing chat", async () => {
    const a = new WebSocket(`ws://127.0.0.1:${port}`);
    const b = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([
      new Promise<void>((res) => a.once("open", () => res())),
      new Promise<void>((res) => b.once("open", () => res())),
    ]);
    const sidA = "550e8400-e29b-41d4-a716-446655440010";
    const sidB = "550e8400-e29b-41d4-a716-446655440011";
    a.send(
      JSON.stringify({
        type: "register_session",
        sessionId: sidA,
        peerId: "peer-alice-aaaaaaa1",
        expiresAt: Date.now() + 60_000,
      }),
    );
    b.send(
      JSON.stringify({
        type: "register_session",
        sessionId: sidB,
        peerId: "peer-bob-bbbbbbbb1",
        expiresAt: Date.now() + 60_000,
      }),
    );
    await waitForMessage(a);
    await waitForMessage(b);
    // drain presence
    await Promise.race([waitForMessage(a), new Promise((r) => setTimeout(r, 100))]);

    const bWait = waitForMessage(b);
    a.send(
      JSON.stringify({
        type: "signalling",
        sessionId: sidA,
        fromPeerId: "peer-alice-aaaaaaa1",
        toPeerId: "peer-bob-bbbbbbbb1",
        payload: { kind: "offer", sdp: "v=0-test" },
      }),
    );
    const delivered = (await bWait) as { type: string; payload?: { sdp: string } };
    // may receive presence first
    if (delivered.type === "presence_update") {
      const next = (await waitForMessage(b)) as { type: string; payload: { sdp: string } };
      expect(next.type).toBe("signalling");
      expect(next.payload.sdp).toBe("v=0-test");
    } else {
      expect(delivered.type).toBe("signalling");
      expect(delivered.payload!.sdp).toBe("v=0-test");
    }
    expect(server.getStats().messagesStored).toBe(0);
    a.close();
    b.close();
  });
});
