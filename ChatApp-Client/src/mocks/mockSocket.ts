import { MOCK_CURRENT_USER } from './fixtures';

const OPEN_DELAY_MS = 50;
const ACK_DELAY_MS = 150;

// Stands in for the real WebSocket when VITE_USE_MOCKS=true (see socketMiddleware.ts) — without
// it, the middleware would just retry a connection to a socket that doesn't exist forever.
// Implements only the subset of the WebSocket API socketMiddleware actually uses; not a general
// mock WebSocket server.
export class MockWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;

  constructor(_url: string) {
    super();
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    }, OPEN_DELAY_MS);
  }

  // Narrows EventTarget's generic addEventListener to the overloads socketMiddleware's SocketLike
  // expects, so MockWebSocket structurally satisfies it without a cast at the call site.
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
  addEventListener(type: string, listener: (event: any) => void): void {
    super.addEventListener(type, listener as EventListener);
  }

  send(data: string) {
    const frame = JSON.parse(data) as { type: string; id?: string; roomId?: string; body?: string };
    if (frame.type === 'message.send') {
      // Fanned out back to the sender as the send ack — see the optimistic-send decision in
      // ChatApp-Client/DESIGN.md §7 and ChatApp-Service/DESIGN.md §3.1/§5.
      setTimeout(() => {
        this.emit({
          type: 'message.receive',
          message: {
            id: frame.id,
            roomId: frame.roomId,
            senderId: MOCK_CURRENT_USER.id,
            body: frame.body,
            createdAt: new Date().toISOString(),
          },
        });
      }, ACK_DELAY_MS);
    }
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  private emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}
