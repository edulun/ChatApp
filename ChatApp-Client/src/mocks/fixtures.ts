import type { User } from '../generated/domain/user';
import type { Room } from '../generated/domain/room';
import type { Message } from '../generated/domain/message';

// Fixture data for VITE_USE_MOCKS=true (`npm run dev:mock`) — lets the client run against canned
// REST/WebSocket responses instead of a live ChatApp-Service. Consumed by mockBaseQuery.ts,
// mockSocket.ts, and App.tsx's mock sign-in button.

export const MOCK_USERS: User[] = [
  { id: 'u-1', displayName: 'Ada Lovelace', createdAt: '2026-01-05T09:00:00.000Z' },
  { id: 'u-2', displayName: 'Grace Hopper', createdAt: '2026-01-06T09:00:00.000Z' },
  { id: 'u-3', displayName: 'Alan Turing', createdAt: '2026-01-07T09:00:00.000Z' },
];

// The signed-in user in mock mode — real auth is Google OAuth (App.tsx §3), so mock sign-in just
// picks one fixture user rather than simulating the OAuth round trip.
export const MOCK_CURRENT_USER = MOCK_USERS[0];
export const MOCK_TOKEN = 'mock-session-token';

// Mutated in place by mockBaseQuery's createRoom/addRoomMember handlers, so state (e.g. a room
// created during a session) persists across subsequent mock requests until the page reloads.
export const mockRooms: Room[] = [
  { id: 'r-1', type: 'direct', name: null, createdAt: '2026-01-10T10:00:00.000Z' },
  { id: 'r-2', type: 'group', name: 'Engineering', createdAt: '2026-01-11T10:00:00.000Z' },
];

export const mockRoomMembers: Record<string, string[]> = {
  'r-1': ['u-1', 'u-2'],
  'r-2': ['u-1', 'u-2', 'u-3'],
};

export const mockMessages: Record<string, Message[]> = {
  'r-1': [
    {
      id: 'm-1',
      roomId: 'r-1',
      senderId: 'u-2',
      body: 'Hey Ada, got a minute?',
      createdAt: '2026-08-16T14:00:00.000Z',
    },
    {
      id: 'm-2',
      roomId: 'r-1',
      senderId: 'u-1',
      body: 'Sure, what’s up?',
      createdAt: '2026-08-16T14:01:00.000Z',
    },
  ],
  'r-2': [
    {
      id: 'm-3',
      roomId: 'r-2',
      senderId: 'u-3',
      body: 'Deploy is green.',
      createdAt: '2026-08-16T15:00:00.000Z',
    },
    {
      id: 'm-4',
      roomId: 'r-2',
      senderId: 'u-2',
      body: 'Nice, thanks Alan.',
      createdAt: '2026-08-16T15:02:00.000Z',
    },
  ],
};
