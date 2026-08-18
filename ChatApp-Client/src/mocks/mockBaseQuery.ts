import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import { MOCK_CURRENT_USER, MOCK_TOKEN, mockRooms, mockRoomMembers, mockMessages } from './fixtures';
import type { Room } from '../generated/domain/room';
import type { CreateRoomRequest } from '../generated/rest/create-room.request';
import type { AddRoomMemberRequest } from '../generated/rest/add-room-member.request';

const MOCK_LATENCY_MS = 200;

function delay<T>(data: T): Promise<{ data: T }> {
  return new Promise((resolve) => setTimeout(() => resolve({ data }), MOCK_LATENCY_MS));
}

function notFound(url: string): { error: FetchBaseQueryError } {
  return { error: { status: 404, data: { message: `mock: no handler for ${url}` } } };
}

let nextRoomId = mockRooms.length + 1;

// Stands in for fetchBaseQuery when VITE_USE_MOCKS=true (see baseApi.ts) — serves the same REST
// surface roomsApi/messagesApi/authApi hit, from the fixtures in fixtures.ts, so the client can
// run end-to-end without ChatApp-Service. Not a general-purpose mock server: only the
// url/method combinations the existing api/*.ts endpoints actually issue are handled.
export const mockBaseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
) => {
  const url = typeof args === 'string' ? args : args.url;
  const method = (typeof args === 'string' ? 'GET' : (args.method ?? 'GET')).toUpperCase();
  const body = typeof args === 'string' ? undefined : args.body;
  const { pathname } = new URL(url, 'http://mock.local');

  if (pathname === '/auth/google' && method === 'POST') {
    return delay({ user: MOCK_CURRENT_USER, token: MOCK_TOKEN });
  }

  if (pathname === '/rooms' && method === 'GET') {
    return delay({ rooms: mockRooms });
  }

  if (pathname === '/rooms' && method === 'POST') {
    const { type, name, memberIds } = body as CreateRoomRequest;
    const room: Room = {
      id: `r-${nextRoomId++}`,
      type,
      name: type === 'group' ? (name ?? null) : null,
      createdAt: new Date().toISOString(),
    };
    mockRooms.push(room);
    mockRoomMembers[room.id] = [MOCK_CURRENT_USER.id, ...memberIds];
    mockMessages[room.id] = [];
    return delay({ room });
  }

  const membersMatch = pathname.match(/^\/rooms\/([^/]+)\/members$/);
  if (membersMatch && method === 'POST') {
    const [, roomId] = membersMatch;
    const room = mockRooms.find((r) => r.id === roomId);
    if (!room) return notFound(url);
    const { userId } = body as AddRoomMemberRequest;
    const members = mockRoomMembers[roomId] ?? [];
    if (!members.includes(userId)) members.push(userId);
    mockRoomMembers[roomId] = members;
    return delay({ room });
  }

  const messagesMatch = pathname.match(/^\/rooms\/([^/]+)\/messages$/);
  if (messagesMatch && method === 'GET') {
    // before/after/limit (ChatApp-Service/DESIGN.md §3.2) are ignored — each mock room's fixture
    // history is small enough to return in full as a single page.
    const [, roomId] = messagesMatch;
    return delay({ messages: mockMessages[roomId] ?? [], hasMore: false });
  }

  return notFound(url);
};
