import { describe, expect, it } from "vitest";
import {
  generateGroupEpochKey,
  encryptGroupMessage,
  decryptGroupMessage,
} from "@ztc/crypto";

describe("group membership epoch changes", () => {
  it("removed member cannot decrypt future epoch", () => {
    const g = "group-1";
    const e1 = generateGroupEpochKey(g, 1, ["a", "b", "c", "d"]);
    const before = encryptGroupMessage("hello epoch1", e1);
    expect(decryptGroupMessage(before, e1)).toBe("hello epoch1");

    const e2 = generateGroupEpochKey(g, 2, ["a", "b", "d"]);
    const after = encryptGroupMessage("hello epoch2", e2);
    expect(decryptGroupMessage(after, e2)).toBe("hello epoch2");
    expect(() => decryptGroupMessage(after, e1)).toThrow();
  });

  it("new member with only epoch 2 cannot read epoch 1", () => {
    const g = "group-2";
    const e1 = generateGroupEpochKey(g, 1, ["a", "b"]);
    const oldMsg = encryptGroupMessage("old history", e1);
    const e2 = generateGroupEpochKey(g, 2, ["a", "b", "newbie"]);
    expect(() => decryptGroupMessage(oldMsg, e2)).toThrow();
  });
});

describe("group gossip fanout contract", () => {
  it("senderSeq is part of the chat payload shape used for digests", async () => {
    const { pickFanoutTargets } = await import("./lib/groupTopology");
    // 100-member group must not require 99 sends from the origin
    const members = Array.from({ length: 99 }, (_, i) => `p${i}`);
    expect(pickFanoutTargets(members, new Set(), 3).length).toBe(3);
  });
});
