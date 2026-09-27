/**
 * Compressed group digests for anti-entropy.
 *
 * Instead of shipping full messageId lists, each peer advertises per-sender
 * (maxSeq + gaps in a trailing window). Peers request missing (senderId, seq)
 * tuples and receive ciphertext envelopes.
 */

/** Trailing window inspected for gaps (keeps digests small). */
export const DIGEST_GAP_WINDOW = 64;
/** Max gap entries advertised per sender. */
export const DIGEST_MAX_GAPS = 24;
/** Max messages returned in one have batch. */
export const HAVE_BATCH_LIMIT = 32;

export interface IndexedGroupMessage {
  messageId: string;
  senderId: string;
  senderSeq: number;
  epoch: number;
}

export interface SenderDigest {
  senderId: string;
  /** Highest senderSeq observed from this sender in the retention set. */
  maxSeq: number;
  /** Missing seqs in (maxSeq - DIGEST_GAP_WINDOW, maxSeq]. */
  gaps: number[];
}

export interface GroupDigest {
  groupId: string;
  epoch: number;
  /** Distinct messages known locally (UI estimate). */
  messageCount: number;
  senders: SenderDigest[];
}

export interface SeqNeed {
  senderId: string;
  seq: number;
}

/** Build a compressed digest from locally indexed group messages. */
export function buildGroupDigest(
  groupId: string,
  epoch: number,
  messages: IndexedGroupMessage[],
): GroupDigest {
  const bySender = new Map<string, Set<number>>();
  for (const m of messages) {
    if (!m.senderId || m.senderSeq <= 0) continue;
    let set = bySender.get(m.senderId);
    if (!set) {
      set = new Set();
      bySender.set(m.senderId, set);
    }
    set.add(m.senderSeq);
  }

  const senders: SenderDigest[] = [];
  for (const [senderId, seqs] of bySender) {
    let maxSeq = 0;
    for (const s of seqs) if (s > maxSeq) maxSeq = s;
    const gaps: number[] = [];
    const start = Math.max(1, maxSeq - DIGEST_GAP_WINDOW + 1);
    for (let seq = start; seq <= maxSeq; seq++) {
      if (!seqs.has(seq)) {
        gaps.push(seq);
        if (gaps.length >= DIGEST_MAX_GAPS) break;
      }
    }
    senders.push({ senderId, maxSeq, gaps });
  }
  senders.sort((a, b) => a.senderId.localeCompare(b.senderId));

  return {
    groupId,
    epoch,
    messageCount: messages.length,
    senders,
  };
}

/**
 * Diff remote digest against local index → sequences we should request.
 */
export function computeWants(
  local: IndexedGroupMessage[],
  remote: GroupDigest,
): SeqNeed[] {
  const have = new Map<string, Set<number>>();
  for (const m of local) {
    if (m.senderSeq <= 0) continue;
    let set = have.get(m.senderId);
    if (!set) {
      set = new Set();
      have.set(m.senderId, set);
    }
    set.add(m.senderSeq);
  }

  const wants: SeqNeed[] = [];
  const seen = new Set<string>();

  const addWant = (senderId: string, seq: number) => {
    if (seq <= 0) return;
    const key = `${senderId}:${seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    wants.push({ senderId, seq });
  };

  for (const s of remote.senders) {
    const localSet = have.get(s.senderId) ?? new Set<number>();
    const remoteGapSet = new Set(s.gaps);
    // Remote claims to hold seq if seq ∈ [1, maxSeq] \ gaps (within advertised window).
    const remoteHas = (seq: number): boolean =>
      seq >= 1 && seq <= s.maxSeq && !remoteGapSet.has(seq);

    const localMax = maxOf(localSet);
    for (let seq = localMax + 1; seq <= s.maxSeq; seq++) {
      if (!localSet.has(seq) && remoteHas(seq)) addWant(s.senderId, seq);
    }

    const start = Math.max(1, s.maxSeq - DIGEST_GAP_WINDOW + 1);
    for (let seq = start; seq <= s.maxSeq; seq++) {
      if (!localSet.has(seq) && remoteHas(seq)) addWant(s.senderId, seq);
    }
  }

  return wants.slice(0, HAVE_BATCH_LIMIT);
}

/** What the remote peer is missing relative to our local index (for opportunistic push). */
export function computeOffers(
  local: IndexedGroupMessage[],
  remote: GroupDigest,
): SeqNeed[] {
  const bySender = new Map<string, number[]>();
  for (const m of local) {
    if (m.senderSeq <= 0) continue;
    const list = bySender.get(m.senderId) ?? [];
    list.push(m.senderSeq);
    bySender.set(m.senderId, list);
  }

  const remoteGaps = new Map<string, { maxSeq: number; gaps: Set<number> }>();
  for (const s of remote.senders) {
    remoteGaps.set(s.senderId, { maxSeq: s.maxSeq, gaps: new Set(s.gaps) });
  }

  const offers: SeqNeed[] = [];
  for (const [senderId, seqs] of bySender) {
    const remote = remoteGaps.get(senderId);
    const remoteMax = remote?.maxSeq ?? 0;
    const gaps = remote?.gaps ?? new Set<number>();
    for (const seq of seqs) {
      if (seq <= remoteMax && !gaps.has(seq)) continue; // they likely have it
      if (seq > remoteMax || gaps.has(seq)) {
        offers.push({ senderId, seq });
      }
    }
  }
  return offers.slice(0, HAVE_BATCH_LIMIT);
}

export function indexKey(senderId: string, seq: number): string {
  return `${senderId}:${seq}`;
}

function maxOf(set: Set<number>): number {
  let m = 0;
  for (const v of set) if (v > m) m = v;
  return m;
}
