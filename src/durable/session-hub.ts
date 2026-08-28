/**
 * SessionHub: one Durable Object per user, fanning session changes out to
 * every tab that user has open, on every device.
 *
 * Why a Durable Object at all. The request that revokes a session and the
 * request holding a tab's open connection run in different isolates, usually
 * in different colos. Neither can reach the other. A DO is the single
 * addressable point both can find, via `idFromName(userId)`.
 *
 * Why WebSockets with the hibernation API rather than SSE. A hibernating
 * connection costs nothing while idle, and these connections are idle almost
 * all of the time: a tab open for an hour might see one event. Holding the
 * same connections on an SSE stream would bill duration for the whole hour and
 * burn the free tier's 13,000 GB-s/day within a few dozen tab hours.
 */

/**
 * An invalidation signal, deliberately not a state update.
 *
 * The hub is addressed per user, so a push reaches that user's tabs on every
 * device, but signing out only ends the session on the device that did it.
 * Broadcasting "you are signed out" would wrongly log out the other devices.
 * So the event says only that something changed, and each tab re-verifies with
 * get-session and reaches its own conclusion. It also means no session
 * identifier is ever put on the wire.
 */
export type SessionEvent = {
  type: 'session.changed';
  reason: 'signed-in' | 'signed-out' | 'revoked';
  at: number;
};

export class SessionHub implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe') {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernation: the runtime holds the socket and only wakes this object
      // when a message actually arrives, so idle tabs are free.
      this.state.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      const event = (await request.json()) as SessionEvent;
      const payload = JSON.stringify(event);
      let delivered = 0;

      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(payload);
          delivered++;
        } catch {
          // A socket the client dropped without a clean close. Nothing to do
          // but discard it; the runtime will surface the close separately.
        }
      }

      return Response.json({ delivered });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Clients send nothing but keepalive pings. Answering here rather than
   * relying on the runtime's automatic pong keeps a single code path for
   * proxies that only consider application traffic to be liveness.
   */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong');
  }

  async webSocketClose(socket: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    // 1006 means the peer vanished; closing with it is not allowed.
    socket.close(code === 1006 ? 1000 : code);
  }
}
