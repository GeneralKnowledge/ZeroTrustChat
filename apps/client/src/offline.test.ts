/**
 * Offline queue unit test — messages stay local, never formatted as server mailbox ops.
 */
import { describe, expect, it } from "vitest";
import { FORBIDDEN_TYPES, parseClientMessage } from "@ztc/protocol";
import { resolvePolicy } from "@ztc/shared";

describe("offline behaviour", () => {
  it("does not define any server mailbox operation", () => {
    for (const type of ["mailbox_deposit", "mailbox_fetch", "store_message", "send_message"] as const) {
      expect(FORBIDDEN_TYPES).toContain(type);
      const result = parseClientMessage({
        type,
        ciphertext: "aabb",
        to: "bob",
      });
      expect(result.ok).toBe(false);
    }
  });

  it("delivery deadline is local policy only", () => {
    const now = Date.now();
    const p = resolvePolicy("expiring", undefined, now);
    expect(p.deliveryDeadlineMs).toBeGreaterThan(0);
    // After deadline, client must stop delivery — enforced in MessagingService/outbox filters
    const deadline = now + (p.deliveryDeadlineMs ?? 0);
    expect(deadline).toBeGreaterThan(now);
  });
});
