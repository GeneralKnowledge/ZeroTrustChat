import { describe, expect, it } from "vitest";
import {
  encodeAppMessage,
  parseAppMessage,
  isHiddenControlMessage,
  displayBody,
} from "./appMessage";

describe("appMessage", () => {
  it("round-trips text with reply", () => {
    const encoded = encodeAppMessage({
      v: 1,
      type: "text",
      body: "hello",
      replyTo: "msg-1",
    });
    const parsed = parseAppMessage(encoded);
    expect(parsed).toEqual({ v: 1, type: "text", body: "hello", replyTo: "msg-1" });
  });

  it("treats legacy plaintext as text", () => {
    expect(parseAppMessage("plain hi")).toEqual({ v: 1, type: "text", body: "plain hi" });
  });

  it("hides reaction and delete control messages", () => {
    expect(
      isHiddenControlMessage({
        v: 1,
        type: "reaction",
        targetId: "a",
        emoji: "👍",
        op: "set",
      }),
    ).toBe(true);
    expect(isHiddenControlMessage({ v: 1, type: "delete", targetId: "a" })).toBe(true);
    expect(isHiddenControlMessage({ v: 1, type: "text", body: "x" })).toBe(false);
  });

  it("displayBody unwraps text", () => {
    expect(displayBody(encodeAppMessage({ v: 1, type: "text", body: "yo" }))).toBe("yo");
  });
});
