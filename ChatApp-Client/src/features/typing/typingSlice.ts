import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TypingUpdateEvent } from '../../generated/websocket/typing-update';

// roomId -> set of userIds currently typing. Ephemeral, fed by typing.update WS events
// (ChatApp-Service/DESIGN.md §6) — never persisted, never backed by REST.
export type TypingState = Record<string, string[]>;

const initialState: TypingState = {};

const typingSlice = createSlice({
  name: 'typing',
  initialState,
  reducers: {
    typingUpdated: (state, action: PayloadAction<TypingUpdateEvent>) => {
      const { roomId, userId, isTyping } = action.payload;
      const current = state[roomId] ?? [];
      state[roomId] = isTyping
        ? current.includes(userId)
          ? current
          : [...current, userId]
        : current.filter((id) => id !== userId);
    },
  },
});

export const { typingUpdated } = typingSlice.actions;
export default typingSlice.reducer;
