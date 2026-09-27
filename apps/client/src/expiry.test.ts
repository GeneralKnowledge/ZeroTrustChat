import { describe, expect, it } from "vitest";
import {
  decryptWithMessageKey,
  encryptWithMessageKey,
  generateMessageKey,
  destroyMessageKey,
} from "@ztc/crypto";
import { resolvePolicy } from "@ztc/shared";

/**
 * Unit-level coverage for expiry / time-limited decryption.
 * Full offline queue behaviour is also covered in e2e and messaging integration tests.
 */

describe("message expiry policies", () => {
  it("expiring mode sets delivery and retention windows", () => {
    const now = 1_700_000_000_000;
    const p = resolvePolicy("expiring", undefined, now);
    expect(p.deliveryDeadlineMs).toBe(24 * 60 * 60 * 1000);
    expect(p.retentionDeadlineMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("time-limited decryption destroys key after deadline", () => {
    const key = generateMessageKey({ decryptionDeadlineAt: Date.now() + 60_000 });
    const enc = encryptWithMessageKey("Meet me at 8.", key);
    key.decryptionDeadlineAt = Date.now() - 1;
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/deadline/);
    expect(key.destroyed).toBe(true);
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/destroyed/);
  });

  it("destroyed key leaves ciphertext useless", () => {
    const key = generateMessageKey();
    const enc = encryptWithMessageKey("secret", key);
    destroyMessageKey(key);
    expect(key.key).toBe("");
    expect(() => decryptWithMessageKey(enc, key)).toThrow();
  });
});
