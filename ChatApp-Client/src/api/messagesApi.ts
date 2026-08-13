import { api } from './baseApi';
import type { ListMessagesResponse } from '../generated/rest/list-messages.response';

interface ListMessagesArgs {
  roomId: string;
  limit?: number;
  before?: string;
  after?: string;
}

export const messagesApi = api.injectEndpoints({
  endpoints: (build) => ({
    // Covers both backward pagination (?before=) and reconnect catch-up (?after=) — see
    // ChatApp-Service/DESIGN.md §3.2 and the reconnect/catch-up decision in
    // ChatApp-Client/DESIGN.md §5. Callers pass exactly one of before/after.
    listMessages: build.query<ListMessagesResponse, ListMessagesArgs>({
      query: ({ roomId, limit, before, after }) => {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        if (after) params.set('after', after);
        if (limit) params.set('limit', String(limit));
        return `/rooms/${roomId}/messages?${params.toString()}`;
      },
    }),
  }),
});

export const { useListMessagesQuery, useLazyListMessagesQuery } = messagesApi;
