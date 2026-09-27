/**
 * Shared P2P connection pool for group gossip.
 *
 * Device-wide degree budget — not per-group — so many groups amortize
 * signalling over the same DataChannels. Direct 1:1 contacts that are
 * already connected count toward the budget and are preferred as gossip edges.
 */

export const DEFAULT_MAX_DEGREE = 8;
export const DEFAULT_FANOUT = 3;
/** How many ranked peers we try to keep for group coverage when under budget. */
export const DEFAULT_POOL_TARGET = 6;

export interface PeerRankInput {
  localPeerId: string;
  /** Candidate peer IDs (typically union of all group members except self). */
  candidates: string[];
  /** peerId → groupIds shared with local user */
  groupsByPeer: Map<string, string[]>;
  /** Currently open DataChannels */
  connected: ReadonlySet<string>;
  /** Optional time bucket (e.g. floor(now / 10min)) for mild rotation */
  timeBucket?: number;
}

/**
 * Rank peers for the shared pool. Higher score = more valuable edge.
 * Prefers: already connected, covers more groups, stable hash mix for spread.
 */
export function rankPeersForPool(input: PeerRankInput): string[] {
  const bucket = input.timeBucket ?? 0;
  const scored = input.candidates
    .filter((p) => p !== input.localPeerId)
    .map((peerId) => {
      const groups = input.groupsByPeer.get(peerId) ?? [];
      const connectedBonus = input.connected.has(peerId) ? 1000 : 0;
      const coverage = groups.length * 10;
      const rotate = hashMix(`${input.localPeerId}|${peerId}|${bucket}`) % 7;
      return { peerId, score: connectedBonus + coverage + rotate };
    });
  scored.sort((a, b) => b.score - a.score || a.peerId.localeCompare(b.peerId));
  return scored.map((s) => s.peerId);
}

/**
 * Choose which peers to dial next without exceeding maxDegree.
 * Does not disconnect anyone — only fills free slots.
 */
export function pickPeersToDial(
  ranked: string[],
  connected: ReadonlySet<string>,
  connecting: ReadonlySet<string>,
  maxDegree: number = DEFAULT_MAX_DEGREE,
  targetCount: number = DEFAULT_POOL_TARGET,
): string[] {
  const used = connected.size + connecting.size;
  const slots = Math.max(0, maxDegree - used);
  if (slots === 0) return [];
  const want = Math.min(slots, Math.max(0, targetCount - connected.size));
  const out: string[] = [];
  for (const peerId of ranked) {
    if (connected.has(peerId) || connecting.has(peerId)) continue;
    out.push(peerId);
    if (out.length >= want) break;
  }
  return out;
}

/**
 * Fanout targets among currently connected group members.
 * Excludes `except` (e.g. the peer we just received from).
 */
export function pickFanoutTargets(
  connectedMembers: string[],
  except: ReadonlySet<string> = new Set(),
  fanout: number = DEFAULT_FANOUT,
): string[] {
  const eligible = connectedMembers.filter((p) => !except.has(p));
  if (eligible.length <= fanout) return eligible;
  // Stable shuffle by sorting on hash so different senders spread differently
  const salted = eligible
    .map((p) => ({ p, h: hashMix(p) }))
    .sort((a, b) => a.h - b.h || a.p.localeCompare(b.p));
  return salted.slice(0, fanout).map((x) => x.p);
}

/** Build peer → shared groupIds map from local group membership lists. */
export function buildGroupsByPeer(
  localPeerId: string,
  groups: Array<{ groupId: string; members: string[] }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const g of groups) {
    if (!g.members.includes(localPeerId)) continue;
    for (const m of g.members) {
      if (m === localPeerId) continue;
      const list = map.get(m) ?? [];
      if (!list.includes(g.groupId)) list.push(g.groupId);
      map.set(m, list);
    }
  }
  return map;
}

function hashMix(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
