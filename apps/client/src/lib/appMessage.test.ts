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
    expect(isHiddenControlMessage({ v: 1, type: "edit", targetId: "a", body: "x" })).toBe(true);
    expect(isHiddenControlMessage({ v: 1, type: "pin", targetId: "a", op: "set" })).toBe(true);
    expect(isHiddenControlMessage({ v: 1, type: "text", body: "x" })).toBe(false);
  });

  it("round-trips edit and pin", () => {
    expect(parseAppMessage(encodeAppMessage({ v: 1, type: "edit", targetId: "m1", body: "new" }))).toEqual({
      v: 1,
      type: "edit",
      targetId: "m1",
      body: "new",
    });
    expect(
      parseAppMessage(encodeAppMessage({ v: 1, type: "pin", targetId: "m1", op: "clear" })),
    ).toEqual({ v: 1, type: "pin", targetId: "m1", op: "clear" });
  });

  it("displayBody unwraps text", () => {
    expect(displayBody(encodeAppMessage({ v: 1, type: "text", body: "yo" }))).toBe("yo");
  });

  it("rejects malformed edit/pin as legacy text (no control injection)", () => {
    expect(parseAppMessage(JSON.stringify({ v: 1, type: "edit", targetId: 123, body: "x" }))).toEqual({
      v: 1,
      type: "text",
      body: JSON.stringify({ v: 1, type: "edit", targetId: 123, body: "x" }),
    });
    expect(parseAppMessage(JSON.stringify({ v: 1, type: "pin", targetId: "m1" /* missing op ok */, op: "set" }))).toEqual({
      v: 1,
      type: "pin",
      targetId: "m1",
      op: "set",
    });
    expect(parseAppMessage(JSON.stringify({ v: 1, type: "pin", op: "set" }))).toEqual({
      v: 1,
      type: "text",
      body: JSON.stringify({ v: 1, type: "pin", op: "set" }),
    });
    expect(parseAppMessage(JSON.stringify({ v: 1, type: "edit", targetId: "m1" }))).toEqual({
      v: 1,
      type: "text",
      body: JSON.stringify({ v: 1, type: "edit", targetId: "m1" }),
    });
  });
});
