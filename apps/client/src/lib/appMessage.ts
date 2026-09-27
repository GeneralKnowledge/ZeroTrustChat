/**
 * Tiny in-band chat features encoded as encrypted plaintext JSON.
 * No media — text, reply, reaction, delete, edit, and pin only.
 */

export type AppMessage =
  | { v: 1; type: "text"; body: string; replyTo?: string }
  | { v: 1; type: "reaction"; targetId: string; emoji: string; op: "set" | "clear" }
  | { v: 1; type: "delete"; targetId: string }
  | { v: 1; type: "edit"; targetId: string; body: string }
  | { v: 1; type: "pin"; targetId: string; op: "set" | "clear" };

export function encodeAppMessage(msg: AppMessage): string {
  return JSON.stringify(msg);
}

/** Parse structured app message; plain strings become text bodies (legacy). */
export function parseAppMessage(plaintext: string): AppMessage {
  const trimmed = plaintext.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<AppMessage> & { v?: number; type?: string };
      if (parsed.v === 1 && parsed.type === "text" && typeof (parsed as { body?: unknown }).body === "string") {
        const body = (parsed as { body: string; replyTo?: string }).body;
        const replyTo = (parsed as { replyTo?: string }).replyTo;
        return replyTo
          ? { v: 1, type: "text", body, replyTo }
          : { v: 1, type: "text", body };
      }
      if (
        parsed.v === 1 &&
        parsed.type === "reaction" &&
        typeof (parsed as { targetId?: unknown }).targetId === "string" &&
        typeof (parsed as { emoji?: unknown }).emoji === "string"
      ) {
        const op = (parsed as { op?: string }).op === "clear" ? "clear" : "set";
        return {
          v: 1,
          type: "reaction",
          targetId: (parsed as { targetId: string }).targetId,
          emoji: (parsed as { emoji: string }).emoji,
          op,
        };
      }
      if (
        parsed.v === 1 &&
        parsed.type === "delete" &&
        typeof (parsed as { targetId?: unknown }).targetId === "string"
      ) {
        return { v: 1, type: "delete", targetId: (parsed as { targetId: string }).targetId };
      }
      if (
        parsed.v === 1 &&
        parsed.type === "edit" &&
        typeof (parsed as { targetId?: unknown }).targetId === "string" &&
        typeof (parsed as { body?: unknown }).body === "string"
      ) {
        return {
          v: 1,
          type: "edit",
          targetId: (parsed as { targetId: string }).targetId,
          body: (parsed as { body: string }).body,
        };
      }
      if (
        parsed.v === 1 &&
        parsed.type === "pin" &&
        typeof (parsed as { targetId?: unknown }).targetId === "string"
      ) {
        const op = (parsed as { op?: string }).op === "clear" ? "clear" : "set";
        return {
          v: 1,
          type: "pin",
          targetId: (parsed as { targetId: string }).targetId,
          op,
        };
      }
    } catch {
      // fall through
    }
  }
  return { v: 1, type: "text", body: plaintext };
}

export function isHiddenControlMessage(msg: AppMessage): boolean {
  return (
    msg.type === "reaction" ||
    msg.type === "delete" ||
    msg.type === "edit" ||
    msg.type === "pin"
  );
}

export function displayBody(plaintext: string | null): string {
  if (!plaintext) return "";
  const msg = parseAppMessage(plaintext);
  if (msg.type === "text") return msg.body;
  if (msg.type === "reaction") return `${msg.emoji}`;
  if (msg.type === "delete" || msg.type === "edit" || msg.type === "pin") return "";
  return plaintext;
}
