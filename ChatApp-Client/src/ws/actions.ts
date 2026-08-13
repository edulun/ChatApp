import { createAction } from '@reduxjs/toolkit';

// Outbound intents the socket middleware listens for and translates into WS frames.
// message.send itself piggybacks on messagesSlice's messageSendStarted (see socketMiddleware.ts)
// rather than a dedicated action here, so the UI only has to dispatch once for both the
// optimistic local append and the wire send.
export const typingStartRequested = createAction<{ roomId: string }>('ws/typingStartRequested');
export const typingStopRequested = createAction<{ roomId: string }>('ws/typingStopRequested');
