import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { User } from '../../generated/domain/user';

export interface AuthState {
  user: User | null;
  // In-memory only — never persisted to localStorage/sessionStorage. See the token-based-auth
  // decision in ChatApp-Client/DESIGN.md §3.
  token: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    signedIn: (state, action: PayloadAction<{ user: User; token: string }>) => {
      state.user = action.payload.user;
      state.token = action.payload.token;
    },
    signedOut: (state) => {
      state.user = null;
      state.token = null;
    },
  },
});

export const { signedIn, signedOut } = authSlice.actions;
export default authSlice.reducer;
