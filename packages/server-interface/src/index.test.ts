import { describe, expect, it } from "vitest";
import { EMBEDDED_DEVELOPER_PUBLIC_KEY, signMessage, verifyMessage } from "@ztc/crypto";
import {
  PROTOCOL_VERSION,
  canonicalJson,
  parseNetworkManifest,
  type NetworkManifestBody,
} from "@ztc/protocol";
import { auditOutbound, ServerInterface } from "./index.js";
import type { ClientToServerMessage } from "@ztc/protocol";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const peerId = "abcdef0123456789abcdef0123456789";

/** Matches packages/crypto EMBEDDED + apps/server prototype developer private key. */
const DEV_PRIVATE =
  "890a7b758b3562a1a5c75da9ca679e32b542018cb137af1683592425b62e234d";

describe("auditOutbound", () => {
  it("allows valid register_session", () => {
    expect(() =>
      auditOutbound({
        type: "register_session",
        sessionId,
        peerId,
        expiresAt: Date.now() + 1000,
      }),
    ).not.toThrow();
  });

  it("allows hello", () => {
    expect(() =>
      auditOutbound({
        type: "hello",
        protocolVersion: 1,
        clientVersion: "0.1.0",
      }),
    ).not.toThrow();
  });

  it("blocks plaintext field injection", () => {
    const sneaky = {
      type: "signalling",
      sessionId,
      fromPeerId: peerId,
      toPeerId: peerId,
      payload: { kind: "offer", sdp: "v=0" },
      plaintext: "hello",
    } as unknown as ClientToServerMessage;
    expect(() => auditOutbound(sneaky)).toThrow(/Unexpected field|Forbidden/);
  });
});

describe("manifest verification", () => {
  it("accepts a developer-signed manifest", () => {
    const body: NetworkManifestBody = {
      protocolVersion: PROTOCOL_VERSION,
      manifestVersion: 1,
      developerPublicKey: EMBEDDED_DEVELOPER_PUBLIC_KEY,
      minClientVersion: "0.1.0",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      servers: [
        {
          serverId: "7dd1f3fce757127d5844612f20affc79d09210e34db880f83542f47e8aba172a",
          displayName: "Test",
          wsUrl: "ws://127.0.0.1:8787",
          httpUrl: "http://127.0.0.1:8787",
          publicKey: "7dd1f3fce757127d5844612f20affc79d09210e34db880f83542f47e8aba172a",
          capabilities: ["signalling", "rendezvous"],
          official: true,
        },
      ],
    };
    const signature = signMessage(canonicalJson(body), DEV_PRIVATE);
    expect(verifyMessage(canonicalJson(body), signature, EMBEDDED_DEVELOPER_PUBLIC_KEY)).toBe(true);

    const si = new ServerInterface({ url: "ws://127.0.0.1:8787" });
    const manifest = si.verifyAndStoreManifest({ ...body, signature });
    expect(manifest.servers).toHaveLength(1);
    expect(si.selectOfficialServer().kind).toBe("official");
  });

  it("rejects tampered manifest", () => {
    const body: NetworkManifestBody = {
      protocolVersion: PROTOCOL_VERSION,
      manifestVersion: 1,
      developerPublicKey: EMBEDDED_DEVELOPER_PUBLIC_KEY,
      minClientVersion: "0.1.0",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      servers: [
        {
          serverId: "7dd1f3fce757127d5844612f20affc79d09210e34db880f83542f47e8aba172a",
          displayName: "Test",
          wsUrl: "ws://127.0.0.1:8787",
          publicKey: "7dd1f3fce757127d5844612f20affc79d09210e34db880f83542f47e8aba172a",
          capabilities: ["signalling"],
          official: true,
        },
      ],
    };
    const signature = signMessage(canonicalJson(body), DEV_PRIVATE);
    const tampered = {
      ...body,
      servers: [
        {
          ...body.servers[0]!,
          wsUrl: "ws://evil.example:9",
        },
      ],
      signature,
    };
    const si = new ServerInterface({ url: "ws://127.0.0.1:8787" });
    expect(() => si.verifyAndStoreManifest(tampered)).toThrow(/signature/);
  });

  it("parseNetworkManifest rejects mailbox fields", () => {
    const result = parseNetworkManifest({
      protocolVersion: 1,
      manifestVersion: 1,
      developerPublicKey: EMBEDDED_DEVELOPER_PUBLIC_KEY,
      minClientVersion: "0.1.0",
      issuedAt: 1,
      expiresAt: 2,
      servers: [],
      messages: [],
      signature: "aa",
    });
    expect(result.ok).toBe(false);
  });
});

describe("ServerInterface API surface", () => {
  it("exposes bootstrap + selection without message APIs", () => {
    const si = new ServerInterface({ url: "ws://localhost:8787" });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(si)).filter(
      (m) => m !== "constructor",
    );
    expect(methods).toContain("fetchNetworkManifest");
    expect(methods).toContain("selectOfficialServer");
    expect(methods).toContain("setCustomServer");
    expect(methods).not.toContain("sendMessage");
    expect(methods).not.toContain("storeContact");
    expect(methods).not.toContain("uploadHistory");
  });
});
