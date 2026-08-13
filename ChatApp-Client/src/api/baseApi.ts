import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { RootState } from '../store';

// Single base API per RTK Query convention — feature files (roomsApi.ts, messagesApi.ts,
// authApi.ts) inject their endpoints into this rather than creating their own createApi
// instances, so everything shares one cache/reducer. ChatApp-Client/DESIGN.md §4 names them as
// separate "slices" at the file/naming level; this is that split, not separate RTK Query stores.
export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080',
    // Auth is a bearer token the client attaches itself, not a cookie — see DESIGN.md §3. This
    // doesn't happen automatically the way cookie attachment would.
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.token;
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return headers;
    },
  }),
  tagTypes: ['Room'],
  endpoints: () => ({}),
});
