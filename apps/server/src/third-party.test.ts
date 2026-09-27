import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { EMBEDDED_DEVELOPER_PUBLIC_KEY, verifyMessage } from "@ztc/crypto";
import { canonicalJson, parseNetworkManifest } from "@ztc/protocol";
import { SignallingServer } from "./index.js";

function waitMsg(
  ws: WebSocket,
  predicate?: (m: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 8000);
    const handler = (d: WebSocket.RawData) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      if (!predicate || predicate(m)) {
        clearTimeout(t);
        ws.off("message", handler);
        resolve(m);
      }
    };
    ws.on("message", handler);
  });
}

describe("third-party compatible server identity", () => {
  let server: SignallingServer;
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ztc-tp-"));
    port = 19200 + Math.floor(Math.random() * 400);
    server = new SignallingServer();
    server.start(port, join(dir, "dev.sqlite"));
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a developer-signed network manifest", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    expect(res.ok).toBe(true);
    const raw: unknown = await res.json();
    const parsed = parseNetworkManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.developerPublicKey).toBe(EMBEDDED_DEVELOPER_PUBLIC_KEY);
    const { signature, ...body } = parsed.value;
    expect(verifyMessage(canonicalJson(body), signature, EMBEDDED_DEVELOPER_PUBLIC_KEY)).toBe(true);
    expect(parsed.value.servers.some((s) => s.official)).toBe(true);
    expect(parsed.value.servers.some((s) => s.community)).toBe(true);
  });

  it("answers hello with signed server_info", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientVersion: "0.1.0" }));
    const info = await waitMsg(ws, (m) => m.type === "server_info");
    expect(info.capabilities).toEqual(expect.arrayContaining(["signalling", "rendezvous"]));
    const { signature, type: _t, ...unsigned } = info as {
      signature: string;
      type: string;
      publicKey: string;
      [k: string]: unknown;
    };
    expect(verifyMessage(canonicalJson(unsigned), signature, unsigned.publicKey as string)).toBe(
      true,
    );
    ws.close();
  });

  it("rejects mismatched protocol on hello", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", protocolVersion: 999, clientVersion: "0.1.0" }));
    const err = await waitMsg(ws, (m) => m.type === "error");
    expect(err.code).toBe("protocol_mismatch");
    ws.close();
  });
});
