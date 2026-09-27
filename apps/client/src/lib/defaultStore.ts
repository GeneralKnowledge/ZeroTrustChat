/**
 * Adapter: singleton sql.js store → ChatStore interface.
 * Production path uses this; simulations inject MemoryStore.
 */

import type { ChatStore } from "./memoryStore";
import * as store from "./store";

export const defaultChatStore: ChatStore = {
  saveMessage: (m) => store.saveMessage(m),
  listMessages: (conversationId) => store.listMessages(conversationId),
  listAllMessages: () => store.listAllMessages(),
  updateMessageStatus: (messageId, status, plaintextCache) =>
    store.updateMessageStatus(messageId, status, plaintextCache),
  getMessage: (messageId) => store.getMessage(messageId),
  saveMessageKey: (k) => store.saveMessageKey(k),
  getMessageKey: (messageKeyId) => store.getMessageKey(messageKeyId),
  destroyStoredMessageKey: (messageKeyId) => store.destroyStoredMessageKey(messageKeyId),
  deleteExpiredMessages: (now) => store.deleteExpiredMessages(now),
  enqueueOutbox: (
    messageId,
    recipientPeerId,
    payloadJson,
    createdAt,
    deliveryDeadline,
    retentionDeadline,
  ) =>
    store.enqueueOutbox(
      messageId,
      recipientPeerId,
      payloadJson,
      createdAt,
      deliveryDeadline,
      retentionDeadline,
    ),
  listOutbox: (now) => store.listOutbox(now),
  removeOutbox: (messageId) => store.removeOutbox(messageId),
  applyReaction: (messageId, reactorId, emoji, op) =>
    store.applyReaction(messageId, reactorId, emoji, op),
  listReactions: (messageId) => store.listReactions(messageId),
  markMessageDeleted: (messageId) => store.markMessageDeleted(messageId),
  applyMessageEdit: (messageId, editorId, body) =>
    store.applyMessageEdit(messageId, editorId, body),
  applyPin: (conversationId, messageId, pinnedBy, op) =>
    store.applyPin(conversationId, messageId, pinnedBy, op),
  isPinned: (conversationId, messageId) => store.isPinned(conversationId, messageId),
  listPins: (conversationId) => store.listPins(conversationId),
  saveGroup: (g) => store.saveGroup(g),
  listGroups: () => store.listGroups(),
  getGroup: (groupId) => store.getGroup(groupId),
  listContacts: () => store.listContacts(),
  upsertContact: (c) => store.upsertContact(c),
  getIdentity: () => store.getIdentity(),
  saveIdentity: (id) => store.saveIdentity(id),
};
