import {
  FORBIDDEN_FIELD_NAMES,
  ALLOWED_CLIENT_FIELDS,
  type ClientToServerMessage,
} from "@ztc/protocol";
import { auditOutbound } from "@ztc/server-interface";

/**
 * Inspect every outbound client operation and assert privacy invariants.
 * Fails loudly if future developers expand the server API unsafely.
 */
export function assertPrivacyBoundary(messages: readonly ClientToServerMessage[]): void {
  for (const msg of messages) {
    auditOutbound(msg);

    const allowed = ALLOWED_CLIENT_FIELDS[msg.type];
    if (!allowed) {
      throw new Error(`Disallowed message type crossed boundary: ${msg.type}`);
    }

    const serialized = JSON.stringify(msg);
    for (const field of FORBIDDEN_FIELD_NAMES) {
      if (serialized.includes(`"${field}"`)) {
        throw new Error(`Forbidden field "${field}" in outbound ${msg.type}`);
      }
    }

    // Heuristic: no long free-text that looks like chat
    if ("opaquePayload" in msg && typeof msg.opaquePayload === "string") {
      if (/\s{2,}/.test(msg.opaquePayload) && msg.opaquePayload.length > 40) {
        throw new Error("opaquePayload looks like plaintext prose");
      }
    }
  }
}

export function assertNoPlaintextChat(messages: readonly ClientToServerMessage[], plaintextSamples: string[]): void {
  const blob = JSON.stringify(messages);
  for (const sample of plaintextSamples) {
    if (sample.length >= 4 && blob.includes(sample)) {
      throw new Error(`Plaintext chat leaked across server interface: "${sample}"`);
    }
  }
}

export function assertNoPrivateKeys(messages: readonly ClientToServerMessage[], privateKeyHexes: string[]): void {
  const blob = JSON.stringify(messages);
  for (const key of privateKeyHexes) {
    if (key.length >= 16 && blob.includes(key)) {
      throw new Error("Private key material leaked across server interface");
    }
  }
}
