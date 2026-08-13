import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Message } from '../../generated/domain/message';

// Client-local delivery status. Deliberately not part of the wire contract — see
// domain/message.schema.json's description and ChatApp-Contracts/DESIGN.md §2. "sent" means
// accepted and fanned out by the service, not durably persisted — there's currently no event for
// a later Cassandra write failure, so a message can't transition to a "failed" state yet. See the
// optimistic-send decision in ChatApp-Client/DESIGN.md §7.
export type MessageStatus = 'pending' | 'sent';

export interface LocalMessage extends Message {
  status: MessageStatus;
}

// roomId -> messages, oldest first.
export type MessagesState = Record<string, LocalMessage[]>;

const initialState: MessagesState = {};

function upsert(list: LocalMessage[], message: LocalMessage): LocalMessage[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index === -1) {
    return [...list, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const next = list.slice();
  next[index] = { ...next[index], ...message };
  return next;
}

const messagesSlice = createSlice({
  name: 'messages',
  initialState,
  reducers: {
    // Optimistic append on send — before any server round trip. `message` already carries the
    // client-generated id (ChatApp-Service/DESIGN.md §5) used for dedup below.
    messageSendStarted: (state, action: PayloadAction<{ roomId: string; message: Message }>) => {
      const { roomId, message } = action.payload;
      state[roomId] = upsert(state[roomId] ?? [], { ...message, status: 'pending' });
    },
    // Fed by message.receive WS events. Transitions a matching pending entry to 'sent' (the
    // sender's own ack, per ChatApp-Service/DESIGN.md §3.1/§5) or appends a message from another
    // participant.
    messageReceived: (state, action: PayloadAction<{ roomId: string; message: Message }>) => {
      const { roomId, message } = action.payload;
      state[roomId] = upsert(state[roomId] ?? [], { ...message, status: 'sent' });
    },
    // Merges a page of REST-fetched history (already 'sent' by definition) in, deduped by id.
    historyLoaded: (state, action: PayloadAction<{ roomId: string; messages: Message[] }>) => {
      const { roomId, messages } = action.payload;
      let list = state[roomId] ?? [];
      for (const message of messages) {
        list = upsert(list, { ...message, status: 'sent' });
      }
      state[roomId] = list;
    },
  },
});

export const { messageSendStarted, messageReceived, historyLoaded } = messagesSlice.actions;
export default messagesSlice.reducer;
