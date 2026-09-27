import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import Database from "better-sqlite3";
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

describe("no server mailbox + restart", () => {
  let server: SignallingServer;
  let dir: string;
  let port: number;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ztc-mail-"));
    dbPath = join(dir, "dev.sqlite");
    port = 19100 + Math.floor(Math.random() * 500);
    server = new SignallingServer();
    server.start(port, dbPath);
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

  it("rejects mailbox_deposit", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "mailbox_deposit", message: "offline for bob" }));
    const err = await waitMsg(ws, (m) => m.type === "error");
    expect(err.code).toBe("forbidden_operation");
    ws.close();
  });

  it("sqlite has no messages/contacts tables", async () => {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[];
    db.close();
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("messages");
    expect(names).not.toContain("contacts");
  });

  it("restart destroys infrastructure sessions, not a message store", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(
      JSON.stringify({
        type: "register_session",
        sessionId: "550e8400-e29b-41d4-a716-446655440080",
        peerId: "peer-restart-aaaaaa01",
        expiresAt: Date.now() + 60_000,
      }),
    );
    await waitMsg(ws, (m) => m.type === "session_registered");
    ws.close();

    server.stop();
    server = new SignallingServer();
    server.start(port, dbPath);
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      messagesStored: number;
      activeSessions: number;
    };
    expect(health.messagesStored).toBe(0);
    expect(health.activeSessions).toBe(0);
  });
});
