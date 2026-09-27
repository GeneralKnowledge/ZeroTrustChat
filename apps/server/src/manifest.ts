/**
 * Build and sign the official network manifest.
 * Third-party operators do NOT need the developer private key — they only need
 * their own server identity. The developer key only attests the bootstrap list.
 */

import { EMBEDDED_DEVELOPER_PUBLIC_KEY, signMessage } from "@ztc/crypto";
import {
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
  canonicalJson,
  type NetworkManifest,
  type NetworkManifestBody,
} from "@ztc/protocol";
import {
  DEFAULT_CAPABILITIES,
  PROTOTYPE_DEVELOPER_PRIVATE_KEY,
  PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
} from "./identity.js";

export function buildOfficialManifest(opts: {
  port: number;
  /** Optional second community-compatible endpoint (same process for prototype). */
  includeCommunityAlias?: boolean;
}): NetworkManifest {
  const httpUrl = `http://127.0.0.1:${opts.port}`;
  const wsUrl = `ws://127.0.0.1:${opts.port}`;
  const now = Date.now();

  const servers: NetworkManifestBody["servers"] = [
    {
      serverId: PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
      displayName: "Official (local prototype)",
      wsUrl,
      httpUrl,
      publicKey: PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
      capabilities: DEFAULT_CAPABILITIES,
      official: true,
    },
  ];

  if (opts.includeCommunityAlias) {
    // Same host listed as community so the UI can demonstrate selection.
    // A real community server would be a different operator/key/URL.
    servers.push({
      serverId: PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
      displayName: "Community mirror (local)",
      wsUrl,
      httpUrl,
      publicKey: PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
      capabilities: DEFAULT_CAPABILITIES,
      community: true,
    });
  }

  const body: NetworkManifestBody = {
    protocolVersion: PROTOCOL_VERSION,
    manifestVersion: 1,
    developerPublicKey: EMBEDDED_DEVELOPER_PUBLIC_KEY,
    minClientVersion: MIN_CLIENT_VERSION,
    issuedAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    servers,
  };

  const signature = signMessage(canonicalJson(body), PROTOTYPE_DEVELOPER_PRIVATE_KEY);
  return { ...body, signature };
}
