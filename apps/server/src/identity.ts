/**
 * Server cryptographic identity + capability advertisement.
 * Each compatible server (official or third-party) has its own Ed25519 keypair.
 */

import {
  generateSigningKeyPair,
  signMessage,
  type Ed25519KeyPair,
} from "@ztc/crypto";
import {
  PROTOCOL_VERSION,
  canonicalJson,
  type ServerCapability,
} from "@ztc/protocol";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CAPABILITIES: ServerCapability[] = [
  "signalling",
  "rendezvous",
  "ephemeral_keys",
  "relay",
];

export interface ServerIdentityConfig {
  displayName: string;
  keyPath?: string;
  privateKeyHex?: string;
  publicKeyHex?: string;
  capabilities?: ServerCapability[];
}

export class ServerIdentity {
  readonly keyPair: Ed25519KeyPair;
  readonly serverId: string;
  readonly displayName: string;
  readonly capabilities: ServerCapability[];

  constructor(config: ServerIdentityConfig) {
    this.displayName = config.displayName;
    this.capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;

    if (config.privateKeyHex && config.publicKeyHex) {
      this.keyPair = { privateKey: config.privateKeyHex, publicKey: config.publicKeyHex };
    } else if (config.keyPath && existsSync(config.keyPath)) {
      const raw = JSON.parse(readFileSync(config.keyPath, "utf8")) as Ed25519KeyPair;
      this.keyPair = raw;
    } else {
      this.keyPair = generateSigningKeyPair();
      if (config.keyPath) {
        mkdirSync(dirname(config.keyPath), { recursive: true });
        writeFileSync(config.keyPath, JSON.stringify(this.keyPair, null, 2));
      }
    }

    this.serverId = this.keyPair.publicKey;
  }

  /** Signed server_info payload for the hello handshake. */
  buildServerInfo() {
    const unsigned = {
      serverId: this.serverId,
      displayName: this.displayName,
      publicKey: this.keyPair.publicKey,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.capabilities,
    };
    const signature = signMessage(canonicalJson(unsigned), this.keyPair.privateKey);
    return { type: "server_info" as const, ...unsigned, signature };
  }
}

/** Prototype developer private key — signs official network manifests only. */
export const PROTOTYPE_DEVELOPER_PRIVATE_KEY =
  process.env.ZTC_DEVELOPER_PRIVATE_KEY ??
  "890a7b758b3562a1a5c75da9ca679e32b542018cb137af1683592425b62e234d";

export const PROTOTYPE_DEVELOPER_PUBLIC_KEY =
  "7133411ff89d3983863648858ded072bcdfd9bc3e230150af0c22aff00c37513";

/** Fixed prototype official server key so clients can pin it via manifest. */
export const PROTOTYPE_OFFICIAL_SERVER_PRIVATE =
  process.env.ZTC_SERVER_PRIVATE_KEY ??
  "b313252d2506fc5310127ead7b49c4b281b96aa4d9a5253d2b353e4c5898bbe5";

export const PROTOTYPE_OFFICIAL_SERVER_PUBLIC =
  "7dd1f3fce757127d5844612f20affc79d09210e34db880f83542f47e8aba172a";
