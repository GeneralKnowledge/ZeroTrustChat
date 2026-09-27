/**
 * Minimal P2P transport surface used by messaging/groups.
 * Real WebRTC implementation: P2pManager. Simulation: FakeP2pEndpoint.
 */

import type { P2pEnvelope, P2pState } from "./p2p";

export type P2pDataHandler = (fromPeerId: string, envelope: P2pEnvelope) => void;
export type P2pStateHandler = (peerId: string, state: P2pState) => void;

export interface P2pTransport {
  send(remotePeerId: string, envelope: P2pEnvelope): boolean;
  isConnected(remotePeerId: string): boolean;
  listConnectedPeers(): string[];
  listConnectingPeers(): string[];
  ensureConnections(peerIds: string[], maxDegree: number): Promise<string[]>;
  connectToPeer(remotePeerId: string): Promise<void>;
  onData(handler: P2pDataHandler): () => void;
  onState(handler: P2pStateHandler): () => void;
}
