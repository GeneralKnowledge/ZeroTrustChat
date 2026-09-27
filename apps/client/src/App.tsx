import { useEffect, useEffectEvent, useState, startTransition } from "react";
import { generateIdentity } from "@ztc/crypto";
import { ServerInterface, type SelectedServer } from "@ztc/server-interface";
import type { ManifestServerEntry } from "@ztc/protocol";
import type { SecurityMode, ServerStats } from "@ztc/shared";
import { P2pManager } from "./lib/p2p";
import { MessagingService } from "./lib/messaging";
import { GroupService } from "./lib/groups";
import * as store from "./lib/store";

const DEFAULT_WS = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";
const DEFAULT_BOOTSTRAP =
  import.meta.env.VITE_BOOTSTRAP_URL ?? "http://127.0.0.1:8787";

interface Runtime {
  identity: store.LocalIdentity;
  si: ServerInterface;
  p2p: P2pManager;
  messaging: MessagingService;
  groups: GroupService;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [inviteInput, setInviteInput] = useState("");
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<SecurityMode>("normal");
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);
  const [groupName, setGroupName] = useState("prototype-group");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [decryptUntil, setDecryptUntil] = useState("");
  const [manifestServers, setManifestServers] = useState<ManifestServerEntry[]>([]);
  const [selectedServer, setSelectedServer] = useState<SelectedServer | null>(null);
  const [customWs, setCustomWs] = useState("ws://127.0.0.1:8787");
  const [customKey, setCustomKey] = useState("");
  const [bootstrapNote, setBootstrapNote] = useState<string>("");
  const [switching, setSwitching] = useState(false);

  const refresh = useEffectEvent(() => {
    startTransition(() => setTick((t) => t + 1));
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await store.openLocalStore();
        let identity = store.getIdentity();
        if (!identity) {
          const gen = generateIdentity();
          identity = {
            peerId: gen.peerId,
            publicKey: gen.publicKey,
            privateKey: gen.privateKey,
            displayName: gen.displayName,
          };
          store.saveIdentity(identity);
        }

        const savedNet = store.getNetworkConfig();
        const bootstrapUrl = savedNet?.bootstrapHttpUrl ?? DEFAULT_BOOTSTRAP;
        const initialWs = savedNet?.selectedWsUrl ?? DEFAULT_WS;

        const si = new ServerInterface({ url: initialWs });

        try {
          const manifest = await si.fetchNetworkManifest(bootstrapUrl);
          store.saveNetworkConfig({
            bootstrapHttpUrl: bootstrapUrl,
            selectedKind: savedNet?.selectedKind ?? "official",
            selectedWsUrl: savedNet?.selectedWsUrl ?? initialWs,
            selectedHttpUrl: savedNet?.selectedHttpUrl ?? bootstrapUrl,
            selectedServerId: savedNet?.selectedServerId ?? null,
            selectedDisplayName: savedNet?.selectedDisplayName ?? "Official",
            selectedPublicKey: savedNet?.selectedPublicKey ?? null,
            manifestJson: JSON.stringify(manifest),
            updatedAt: Date.now(),
          });
          setBootstrapNote("Signed network manifest verified.");
        } catch (e) {
          if (savedNet?.manifestJson) {
            try {
              si.verifyAndStoreManifest(JSON.parse(savedNet.manifestJson));
              setBootstrapNote("Using cached signed manifest (bootstrap unreachable).");
            } catch {
              setBootstrapNote(
                `Bootstrap failed (${e instanceof Error ? e.message : "error"}); using direct URL.`,
              );
            }
          } else {
            setBootstrapNote(
              `Bootstrap failed (${e instanceof Error ? e.message : "error"}); using direct URL.`,
            );
          }
        }

        if (!cancelled) setManifestServers(si.listManifestServers());

        if (savedNet?.selectedKind === "custom") {
          si.setCustomServer(savedNet.selectedWsUrl, {
            displayName: savedNet.selectedDisplayName,
            expectedPublicKey: savedNet.selectedPublicKey ?? undefined,
            httpUrl: savedNet.selectedHttpUrl ?? undefined,
          });
        } else if (savedNet?.selectedKind === "community" && savedNet.selectedServerId) {
          try {
            si.selectCommunityServer(savedNet.selectedServerId);
          } catch {
            si.selectOfficialServer();
          }
        } else if (si.listManifestServers().length) {
          si.selectOfficialServer();
        }

        await si.connect();
        await si.registerEphemeralSession(identity.peerId);
        await si.publishPresence("online");

        const sel = si.getSelectedServer();
        if (!cancelled) setSelectedServer(sel);

        persistSelection(si, bootstrapUrl);

        const p2p = new P2pManager(si, identity.peerId);
        p2p.start();
        p2p.onState(() => refresh());
        p2p.onData(() => refresh());

        const messaging = new MessagingService(p2p, identity);
        messaging.start();

        const groups = new GroupService(p2p, identity);
        groups.start();
        groups.onChange(() => refresh());

        if (!cancelled) {
          setRuntime({ identity, si, p2p, messaging, groups });
          setReady(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to start");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return;
    const id = setInterval(async () => {
      store.deleteExpiredMessages();
      try {
        const stats = await runtime.si.fetchServerStats();
        setServerStats(stats);
      } catch {
        // server may be down — P2P can continue
      }
      refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [runtime]);

  async function switchServer(apply: (si: ServerInterface) => void): Promise<void> {
    if (!runtime) return;
    setSwitching(true);
    setError(null);
    try {
      const { identity, si, p2p, messaging } = runtime;
      messaging.stop();
      p2p.stop();
      await si.disconnect();
      apply(si);
      await si.connect();
      await si.registerEphemeralSession(identity.peerId);
      await si.publishPresence("online");
      p2p.start();
      messaging.start();
      setSelectedServer(si.getSelectedServer());
      setManifestServers(si.listManifestServers());
      persistSelection(si, store.getNetworkConfig()?.bootstrapHttpUrl ?? DEFAULT_BOOTSTRAP);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Server switch failed");
    } finally {
      setSwitching(false);
    }
  }

  if (error && !ready) {
    return (
      <div className="app">
        <div className="brand">
          <h1>ZeroTrustChat</h1>
          <p className="pill danger">{error}</p>
          <p>
            Start the signalling server with <span className="mono">pnpm dev</span>.
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !runtime) {
    return (
      <div className="app">
        <div className="brand">
          <h1>ZeroTrustChat</h1>
          <p>Bootstrapping network config and connecting…</p>
        </div>
      </div>
    );
  }

  const { identity, si, p2p, messaging, groups } = runtime;
  const contacts = store.listContacts();
  const invitation = store.encodeInvitation(identity);
  const p2pStats = p2p.getAggregateStats();
  const pending = store.countByStatus("pending");
  const expired = store.countByStatus("expired") + store.countByStatus("key_destroyed");
  const verified = si.getVerifiedServer();
  void tick;

  const conversationId = activePeer
    ? [identity.peerId, activePeer].sort().join(":")
    : activeGroup
      ? `group:${activeGroup}`
      : null;
  const messages = conversationId ? store.listMessages(conversationId) : [];
  const groupList = store.listGroups();
  const official = manifestServers.filter((s) => s.official);
  const community = manifestServers.filter((s) => s.community);

  async function addContact() {
    try {
      const decoded = store.decodeInvitation(inviteInput.trim());
      store.upsertContact({
        ...decoded,
        invitationCode: inviteInput.trim(),
        addedAt: Date.now(),
      });
      setInviteInput("");
      setActivePeer(decoded.peerId);
      await p2p.connectToPeer(decoded.peerId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid invite");
    }
  }

  async function connectPeer(peerId: string) {
    setActivePeer(peerId);
    setActiveGroup(null);
    await p2p.connectToPeer(peerId);
    refresh();
  }

  async function send() {
    if (!draft.trim()) return;
    if (activeGroup) {
      groups.sendGroupMessage(activeGroup, draft.trim());
      setDraft("");
      refresh();
      return;
    }
    if (!activePeer) return;
    const contact = contacts.find((c) => c.peerId === activePeer);
    if (!contact) return;
    const overrides =
      mode === "time_limited" && decryptUntil
        ? { decryptionDeadlineAt: new Date(decryptUntil).getTime() }
        : undefined;
    await messaging.sendDirect(activePeer, contact.publicKey, draft.trim(), mode, overrides);
    setDraft("");
    refresh();
  }

  function createGroup() {
    const members = contacts.map((c) => c.peerId);
    if (members.length === 0) return;
    const id = groups.createGroup(groupName || "group", members);
    // Shared pool — do not dial every member (degree-capped gossip topology).
    void groups.ensureTopology().then(() => refresh());
    setActiveGroup(id);
    setActivePeer(null);
    refresh();
  }

  function removeMemberFromGroup(peerId: string) {
    if (!activeGroup) return;
    const g = store.getGroup(activeGroup);
    if (!g) return;
    const members = (JSON.parse(g.membersJson) as string[]).filter((m) => m !== peerId);
    groups.updateMembership(
      activeGroup,
      members.filter((m) => m !== identity.peerId),
    );
    refresh();
  }

  return (
    <div className="app">
      <header className="brand">
        <h1>ZeroTrustChat</h1>
        <p>
          Privacy-first P2P prototype. The app owns the protocol; infrastructure is interchangeable.
          Messages stay device-to-device.
        </p>
      </header>

      <div className="layout">
        <aside className="stack">
          <section className="panel stack">
            <h2>Infrastructure</h2>
            <p className="mono" style={{ color: "var(--muted)", margin: 0 }}>
              {bootstrapNote}
            </p>
            <div>
              <span className="pill">{selectedServer?.kind ?? "—"}</span>{" "}
              <span className="pill">{selectedServer?.displayName ?? "—"}</span>
            </div>
            {verified && (
              <div className="mono">
                verified {verified.serverId.slice(0, 16)}… · caps: {verified.capabilities.join(", ")}
              </div>
            )}
            <div className="stack">
              <button
                type="button"
                className="secondary"
                disabled={switching || official.length === 0}
                onClick={() => void switchServer((s) => s.selectOfficialServer())}
              >
                Use official server
              </button>
              {community.map((c) => (
                <button
                  key={`c-${c.displayName}`}
                  type="button"
                  className="secondary"
                  disabled={switching}
                  onClick={() => void switchServer((s) => s.selectCommunityServer(c.serverId))}
                >
                  Community: {c.displayName}
                </button>
              ))}
              <label>
                Custom / self-hosted WebSocket URL
                <input value={customWs} onChange={(e) => setCustomWs(e.target.value)} />
              </label>
              <label>
                Optional expected server public key (hex)
                <input
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="leave blank to trust URL only"
                />
              </label>
              <button
                type="button"
                disabled={switching}
                onClick={() =>
                  void switchServer((s) =>
                    s.setCustomServer(customWs.trim(), {
                      expectedPublicKey: customKey.trim() || undefined,
                      displayName: "Custom / self-hosted",
                    }),
                  )
                }
              >
                Connect custom server
              </button>
            </div>
            {error && <p className="pill danger">{error}</p>}
          </section>

          <section className="panel stack">
            <h2>Identity</h2>
            <div>
              <span className="pill">{identity.displayName}</span>
            </div>
            <div className="mono">{identity.peerId.slice(0, 24)}…</div>
            <label>
              Your invitation (copy/paste)
              <textarea readOnly rows={3} value={invitation} />
            </label>
            <button
              className="secondary"
              type="button"
              onClick={() => void navigator.clipboard.writeText(invitation)}
            >
              Copy invite
            </button>
          </section>

          <section className="panel stack">
            <h2>Add contact</h2>
            <label>
              Paste invitation code
              <textarea
                rows={3}
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                placeholder="ztc1:..."
              />
            </label>
            <button type="button" onClick={() => void addContact()}>
              Add & connect
            </button>
            <div>
              {contacts.map((c) => (
                <div className="contact" key={c.peerId}>
                  <button type="button" className="secondary" onClick={() => void connectPeer(c.peerId)}>
                    {c.displayName}
                  </button>
                  <div className="mono">{c.peerId.slice(0, 16)}…</div>
                  <span className={`pill ${p2p.isConnected(c.peerId) ? "" : "warn"}`}>
                    P2P: {p2p.getStats(c.peerId).state}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel stack">
            <h2>Groups</h2>
            <label>
              Name
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            </label>
            <button type="button" onClick={createGroup} disabled={contacts.length === 0}>
              Create group with all contacts
            </button>
            {groupList.map((g) => (
              <div className="contact" key={g.groupId}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setActiveGroup(g.groupId);
                    setActivePeer(null);
                    void groups.ensureTopology().then(() => refresh());
                    refresh();
                  }}
                >
                  {g.name} (epoch {g.epoch})
                </button>
                <div className="mono">{(JSON.parse(g.membersJson) as string[]).length} members</div>
              </div>
            ))}
          </section>
        </aside>

        <main className="stack">
          <section className="panel">
            <h2>Developer dashboard</h2>
            <div className="stat-grid">
              <div className="stat">
                <div className="k">Signalling</div>
                <div className="v">{si.getConnectionState()}</div>
              </div>
              <div className="stat">
                <div className="k">P2P</div>
                <div className="v">{p2pStats.state}</div>
              </div>
              <div className="stat">
                <div className="k">P2P sent / recv</div>
                <div className="v">
                  {p2pStats.messagesSent} / {p2pStats.messagesReceived}
                </div>
              </div>
              <div className="stat">
                <div className="k">P2P pool</div>
                <div className="v">{p2p.listConnectedPeers().length} live</div>
              </div>
              <div className="stat">
                <div className="k">Pending / expired</div>
                <div className="v">
                  {pending} / {expired}
                </div>
              </div>
              <div className="stat">
                <div className="k">Local contacts</div>
                <div className="v">{contacts.length}</div>
              </div>
              <div className="stat">
                <div className="k">Server messages stored</div>
                <div className="v">{serverStats?.messagesStored ?? 0}</div>
              </div>
              <div className="stat">
                <div className="k">Server plaintext recv</div>
                <div className="v">{serverStats?.messagePlaintextReceived ?? 0}</div>
              </div>
              <div className="stat">
                <div className="k">Server sessions / eph keys</div>
                <div className="v">
                  {serverStats?.activeSessions ?? "—"} / {serverStats?.ephemeralKeys ?? "—"}
                </div>
              </div>
              <div className="stat">
                <div className="k">Contacts on server</div>
                <div className="v">{serverStats?.contactListsReceived ?? 0}</div>
              </div>
              <div className="stat">
                <div className="k">Private keys on server</div>
                <div className="v">{serverStats?.privateKeysReceived ?? 0}</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  await si.disconnect();
                  refresh();
                }}
              >
                Disconnect signalling
              </button>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  await si.connect();
                  await si.registerEphemeralSession(identity.peerId);
                  await si.publishPresence("online");
                  refresh();
                }}
              >
                Reconnect signalling
              </button>
            </div>
            <p className="mono" style={{ color: "var(--muted)", marginTop: "0.75rem" }}>
              After P2P is up, disconnect signalling and keep chatting — server never sees plaintext.
            </p>
          </section>

          <section className="panel stack">
            <h2>
              Chat{" "}
              {activePeer && (
                <span className="pill">{contacts.find((c) => c.peerId === activePeer)?.displayName}</span>
              )}
              {activeGroup && <span className="pill">{store.getGroup(activeGroup)?.name}</span>}
            </h2>

            {activeGroup &&
              (() => {
                const sync = groups.getSyncStatus(activeGroup);
                if (!sync.syncing && sync.connectedMembers === 0 && sync.local === 0) {
                  return (
                    <p className="mono" style={{ color: "var(--muted)", marginTop: 0 }}>
                      Group pool: {sync.poolSize} live edges · {sync.connectedMembers} members connected
                    </p>
                  );
                }
                return (
                  <p className="mono" style={{ color: "var(--muted)", marginTop: 0 }}>
                    {sync.syncing
                      ? `Synchronising… ${sync.local}/${sync.estimate}`
                      : `In sync · ${sync.local} messages`}
                    {" · "}
                    {sync.connectedMembers} members connected · pool {sync.poolSize}
                  </p>
                );
              })()}

            {!activePeer && !activeGroup && (
              <p style={{ color: "var(--muted)" }}>Select a contact or group.</p>
            )}

            <div className="messages">
              {messages.map((m) => (
                <div
                  key={m.messageId}
                  className={`bubble ${m.senderId === identity.peerId ? "mine" : ""}`}
                >
                  <div className="meta">
                    {m.senderId.slice(0, 10)}… · {m.status} · {m.securityMode}
                    {m.decryptionDeadline
                      ? ` · decrypt≠after ${new Date(m.decryptionDeadline).toLocaleTimeString()}`
                      : ""}
                  </div>
                  <div>
                    {m.plaintextCache ?? (
                      <span className="pill danger">ciphertext only (key unavailable)</span>
                    )}
                  </div>
                  {!m.plaintextCache && (
                    <button
                      type="button"
                      className="secondary"
                      style={{ marginTop: "0.4rem" }}
                      onClick={() => {
                        messaging.tryDecryptLocal(m.messageId);
                        groups.decryptStoredGroupMessage(m.messageId);
                        refresh();
                      }}
                    >
                      Try decrypt
                    </button>
                  )}
                </div>
              ))}
            </div>

            {(activePeer || activeGroup) && (
              <div className="stack">
                {!activeGroup && (
                  <div className="row">
                    <label style={{ flex: 1 }}>
                      Security mode
                      <select value={mode} onChange={(e) => setMode(e.target.value as SecurityMode)}>
                        <option value="normal">Normal — no expiry</option>
                        <option value="expiring">Expiring — deliver 24h / retain 7d</option>
                        <option value="time_limited">Time-Limited — decrypt until deadline</option>
                        <option value="one_time">One-Time — destroy key after decrypt</option>
                      </select>
                    </label>
                    {mode === "time_limited" && (
                      <label style={{ flex: 1 }}>
                        Decryptable until
                        <input
                          type="datetime-local"
                          value={decryptUntil}
                          onChange={(e) => setDecryptUntil(e.target.value)}
                        />
                      </label>
                    )}
                  </div>
                )}
                {activeGroup && (
                  <div className="row">
                    {(JSON.parse(store.getGroup(activeGroup)!.membersJson) as string[])
                      .filter((m) => m !== identity.peerId)
                      .map((m) => (
                        <button
                          key={m}
                          type="button"
                          className="secondary"
                          onClick={() => removeMemberFromGroup(m)}
                        >
                          Remove {m.slice(0, 8)}… (new epoch)
                        </button>
                      ))}
                  </div>
                )}
                <label>
                  Message
                  <textarea
                    rows={2}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                </label>
                <button type="button" onClick={() => void send()}>
                  Send over P2P
                </button>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function persistSelection(si: ServerInterface, bootstrapHttpUrl: string): void {
  const sel = si.getSelectedServer();
  const verified = si.getVerifiedServer();
  const manifest = si.getManifest();
  if (!sel) return;
  store.saveNetworkConfig({
    bootstrapHttpUrl,
    selectedKind: sel.kind,
    selectedWsUrl: sel.wsUrl,
    selectedHttpUrl: sel.httpUrl ?? null,
    selectedServerId: sel.serverId ?? verified?.serverId ?? null,
    selectedDisplayName: sel.displayName,
    selectedPublicKey: sel.expectedPublicKey ?? verified?.publicKey ?? null,
    manifestJson: manifest
      ? JSON.stringify(manifest)
      : (store.getNetworkConfig()?.manifestJson ?? null),
    updatedAt: Date.now(),
  });
}
