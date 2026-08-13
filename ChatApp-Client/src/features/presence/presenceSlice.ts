import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { PresenceUpdateEvent } from '../../generated/websocket/presence-update';

// userId -> online/offline. Fed by presence.update WS events (ChatApp-Service/DESIGN.md §6).
export type PresenceState = Record<string, PresenceUpdateEvent['status']>;

const initialState: PresenceState = {};

const presenceSlice = createSlice({
  name: 'presence',
  initialState,
  reducers: {
    presenceUpdated: (state, action: PayloadAction<PresenceUpdateEvent>) => {
      state[action.payload.userId] = action.payload.status;
    },
  },
});

export const { presenceUpdated } = presenceSlice.actions;
export default presenceSlice.reducer;
