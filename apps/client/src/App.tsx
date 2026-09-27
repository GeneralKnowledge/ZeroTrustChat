import { useEffect, useEffectEvent, useState, startTransition } from "react";
import { generateIdentity } from "@ztc/crypto";
import { ServerInterface } from "@ztc/server-interface";
import type { SecurityMode, ServerStats } from "@ztc/shared";
import { P2pManager } from "./lib/p2p";
import { MessagingService } from "./lib/messaging";
import { GroupService } from "./lib/groups";
import * as store from "./lib/store";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

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

        const si = new ServerInterface({ url: WS_URL });
        await si.connect();
        await si.registerEphemeralSession(identity.peerId);
        await si.publishPresence("online");

        const p2p = new P2pManager(si, identity.peerId);
        p2p.start();
        p2p.onState(() => refresh());
        p2p.onData(() => refresh());

        const messaging = new MessagingService(p2p, identity);
        messaging.start();

        const groups = new GroupService(p2p, identity);
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

  if (error) {
    return (
      <div className="app">
        <div className="brand">
          <h1>ZeroTrustChat</h1>
          <p className="pill danger">{error}</p>
          <p>Start the signalling server with <span className="mono">pnpm dev</span>.</p>
        </div>
      </div>
    );
  }

  if (!ready || !runtime) {
    return (
      <div className="app">
        <div className="brand">
          <h1>ZeroTrustChat</h1>
          <p>Generating local identity and connecting…</p>
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
  void tick;

  const conversationId = activePeer
    ? [identity.peerId, activePeer].sort().join(":")
    : activeGroup
      ? `group:${activeGroup}`
      : null;
  const messages = conversationId ? store.listMessages(conversationId) : [];
  const groupList = store.listGroups();

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
    for (const m of members) void p2p.connectToPeer(m);
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
          Privacy-first P2P prototype. Messages travel device-to-device. The server is signalling
          only — never a mailbox.
        </p>
      </header>

      <div className="layout">
        <aside className="stack">
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
              {activeGroup && (
                <span className="pill">{store.getGroup(activeGroup)?.name}</span>
              )}
            </h2>

            {!activePeer && !activeGroup && <p style={{ color: "var(--muted)" }}>Select a contact or group.</p>}

            <div className="messages">
              {messages.map((m) => (
                <div
                  key={m.messageId}
                  className={`bubble ${m.senderId === identity.peerId ? "mine" : ""}`}
                >
                  <div className="meta">
                    {m.senderId.slice(0, 10)}… · {m.status} · {m.securityMode}
                    {m.decryptionDeadline ? ` · decrypt≠after ${new Date(m.decryptionDeadline).toLocaleTimeString()}` : ""}
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
