import type { Middleware } from '@reduxjs/toolkit';
import { signedIn, signedOut } from '../features/auth/authSlice';
import { messageSendStarted, messageReceived } from '../features/messages/messagesSlice';
import { presenceUpdated } from '../features/presence/presenceSlice';
import { typingUpdated } from '../features/typing/typingSlice';
import { typingStartRequested, typingStopRequested } from './actions';
import { roomsApi } from '../api/roomsApi';
import type { RootState, AppDispatch } from '../store';
import type { AuthEvent } from '../generated/websocket/auth';
import type { MessageSendEvent } from '../generated/websocket/message-send';
import type { MessageReceiveEvent } from '../generated/websocket/message-receive';
import type { PresenceUpdateEvent } from '../generated/websocket/presence-update';
import type { TypingEvent } from '../generated/websocket/typing';
import type { TypingUpdateEvent } from '../generated/websocket/typing-update';
import type { RoomJoinedEvent } from '../generated/websocket/room-joined';
import type { RoomLeftEvent } from '../generated/websocket/room-left';

type OutboundFrame = AuthEvent | MessageSendEvent | TypingEvent;
type InboundEvent =
  | MessageReceiveEvent
  | PresenceUpdateEvent
  | TypingUpdateEvent
  | RoomJoinedEvent
  | RoomLeftEvent;

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws';
const MAX_BACKOFF_MS = 30_000;

// Owns the single WebSocket connection's lifecycle, per ChatApp-Client/DESIGN.md §5:
// connects on sign-in, sends the auth frame first, maps inbound events to actions, reconnects
// with backoff on drop, closes on sign-out.
//
// Not yet implemented: the reconnect/catch-up flow DESIGN.md §5 describes (fetch
// GET /rooms/{id}/messages?after={lastSeenId} per room before resuming live delivery). This
// middleware reconnects the socket itself, but doesn't yet orchestrate that REST catch-up —
// that needs coordinating with messagesApi per open room and is real feature work, not
// infrastructure wiring. Flagged here rather than silently left out.
export const socketMiddleware: Middleware<Record<string, never>, RootState, AppDispatch> = (
  store,
) => {
  let socket: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldConnect = false;

  function send(frame: OutboundFrame) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_BACKOFF_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldConnect) connect();
    }, delay);
  }

  function connect() {
    if (socket) return;
    socket = new WebSocket(WS_URL);

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      const token = store.getState().auth.token;
      if (token) {
        // Must be the first frame after connect (ChatApp-Service/DESIGN.md §3.1) — the browser
        // WebSocket API can't set custom headers on the upgrade request, so the token rides as
        // the first message frame instead of a header (ChatApp-Client/DESIGN.md §3).
        send({ type: 'auth', token });
      }
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const data: InboundEvent = JSON.parse(event.data);
      switch (data.type) {
        case 'message.receive':
          // Also how the sender's own send gets acked — see ChatApp-Service/DESIGN.md §3.1/§5
          // and the optimistic-send decision in ChatApp-Client/DESIGN.md §7.
          store.dispatch(messageReceived({ roomId: data.message.roomId, message: data.message }));
          break;
        case 'presence.update':
          store.dispatch(presenceUpdated(data));
          break;
        case 'typing.update':
          store.dispatch(typingUpdated(data));
          break;
        case 'room.joined':
          // Manually patch the RTK Query cache rather than relying on invalidation — the push
          // event already carries the data invalidation would have to re-fetch. See
          // ChatApp-Client/DESIGN.md §7.
          store.dispatch(
            roomsApi.util.updateQueryData('listRooms', undefined, (draft) => {
              if (!draft.rooms.some((room) => room.id === data.room.id)) {
                draft.rooms.push(data.room);
              }
            }),
          );
          break;
        case 'room.left':
          store.dispatch(
            roomsApi.util.updateQueryData('listRooms', undefined, (draft) => {
              draft.rooms = draft.rooms.filter((room) => room.id !== data.roomId);
            }),
          );
          break;
      }
    });

    socket.addEventListener('close', () => {
      socket = null;
      if (shouldConnect) scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket?.close();
    });
  }

  function disconnect() {
    shouldConnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  }

  return (next) => (action) => {
    if (signedIn.match(action)) {
      shouldConnect = true;
      connect();
    } else if (signedOut.match(action)) {
      disconnect();
    } else if (messageSendStarted.match(action)) {
      const { message } = action.payload;
      send({ type: 'message.send', id: message.id, roomId: message.roomId, body: message.body });
    } else if (typingStartRequested.match(action)) {
      send({ type: 'typing.start', roomId: action.payload.roomId });
    } else if (typingStopRequested.match(action)) {
      send({ type: 'typing.stop', roomId: action.payload.roomId });
    }

    return next(action);
  };
};
