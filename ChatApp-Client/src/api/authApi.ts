import { api } from './baseApi';
import type { AuthGoogleRequest } from '../generated/rest/auth-google.request';
import type { AuthGoogleResponse } from '../generated/rest/auth-google.response';

export const authApi = api.injectEndpoints({
  endpoints: (build) => ({
    authGoogle: build.mutation<AuthGoogleResponse, AuthGoogleRequest>({
      query: (body) => ({ url: '/auth/google', method: 'POST', body }),
    }),
  }),
});

export const { useAuthGoogleMutation } = authApi;
