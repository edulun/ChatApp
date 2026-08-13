import { combineReducers, configureStore, type ThunkDispatch, type UnknownAction } from '@reduxjs/toolkit';
import { api } from './api/baseApi';
import authReducer from './features/auth/authSlice';
import presenceReducer from './features/presence/presenceSlice';
import typingReducer from './features/typing/typingSlice';
import messagesReducer from './features/messages/messagesSlice';
import { socketMiddleware } from './ws/socketMiddleware';

// authApi/roomsApi/messagesApi aren't imported here directly — importing them anywhere (e.g. in
// components) is enough to run their injectEndpoints call against `api` (baseApi.ts) exactly
// once per module, since ES modules are cached. They share api's single reducer (`api.reducer`
// below), per the RTK Query convention noted in baseApi.ts.

// RootState/AppDispatch are deliberately derived from rootReducer, not from `store` itself
// (`ReturnType<typeof store.getState>` / `typeof store.dispatch`): socketMiddleware needs a
// typed RootState/AppDispatch, but store's own type depends on its middleware array, which
// includes socketMiddleware — a real circular type if RootState/AppDispatch come from `store`.
// Deriving them from the reducer map instead (which doesn't depend on the middleware config)
// breaks the cycle.
const rootReducer = combineReducers({
  auth: authReducer,
  presence: presenceReducer,
  typing: typingReducer,
  messages: messagesReducer,
  [api.reducerPath]: api.reducer,
});

export type RootState = ReturnType<typeof rootReducer>;
// Matches what getDefaultMiddleware's thunk middleware + api.middleware actually provide at
// runtime — described manually rather than via `typeof store.dispatch` for the reason above.
export type AppDispatch = ThunkDispatch<RootState, undefined, UnknownAction>;

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(api.middleware, socketMiddleware),
});
