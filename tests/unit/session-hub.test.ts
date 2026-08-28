/**
 * The Durable Object that fans session changes out to a user's open tabs.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SessionHub } from '@/durable/session-hub';

class FakeSocket {
  sent: string[] = [];
  closedWith: number | null = null;
  constructor(private failing = false) {}
  send(payload: string) {
    if (this.failing) throw new Error('socket is gone');
    this.sent.push(payload);
  }
  close(code: number) {
    this.closedWith = code;
  }
}

class FakeState {
  accepted: FakeSocket[] = [];
  acceptWebSocket(socket: any) {
    this.accepted.push(socket);
  }
  getWebSockets() {
    return this.accepted as any[];
  }
}

let state: FakeState;
let hub: SessionHub;

const publish = (body: unknown) =>
  hub.fetch(
    new Request('https://session-hub.internal/publish', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  state = new FakeState();
  hub = new SessionHub(state as any);
});

describe('publishing', () => {
  test('delivers an event to every connected tab', async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    state.accepted.push(a, b);

    const event = { type: 'session.changed', reason: 'signed-out', at: 1 };
    const response = await publish(event);

    expect(await response.json()).toEqual({ delivered: 2 });
    expect(JSON.parse(a.sent[0])).toEqual(event);
    expect(JSON.parse(b.sent[0])).toEqual(event);
  });

  test('a dead socket does not stop delivery to the others', async () => {
    const dead = new FakeSocket(true);
    const alive = new FakeSocket();
    state.accepted.push(dead, alive);

    const response = await publish({ type: 'session.changed', reason: 'revoked', at: 1 });

    expect(await response.json()).toEqual({ delivered: 1 });
    expect(alive.sent).toHaveLength(1);
  });

  test('publishing with nobody connected is not an error', async () => {
    const response = await publish({ type: 'session.changed', reason: 'revoked', at: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 0 });
  });
});

describe('subscribing', () => {
  test('a plain GET is refused rather than upgraded', async () => {
    const response = await hub.fetch(new Request('https://session-hub.internal/subscribe'));
    expect(response.status).toBe(426);
  });

  test('an upgrade is accepted into the hibernation pool', async () => {
    const server = new FakeSocket();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeSocket();
        1 = server;
      }
    );

    // Node's fetch forbids constructing a 101 Response, while workerd requires
    // one for an upgrade. The accept happens before the Response is built, so
    // the side effect is still assertable here; the 101 itself is only
    // exercised on workerd.
    await hub.fetch(
      new Request('https://session-hub.internal/subscribe', { headers: { upgrade: 'websocket' } })
    ).catch(() => undefined);

    // Accepted via the hibernation API, so an idle tab costs nothing.
    expect(state.accepted).toContain(server);
    vi.unstubAllGlobals();
  });
});

describe('keepalive', () => {
  test('answers a ping', async () => {
    const socket = new FakeSocket();
    await hub.webSocketMessage(socket as any, 'ping');
    expect(socket.sent).toEqual(['pong']);
  });

  test('ignores anything else a client sends', async () => {
    const socket = new FakeSocket();
    await hub.webSocketMessage(socket as any, 'something else');
    expect(socket.sent).toEqual([]);
  });

  test('an abnormal close is normalised, since 1006 cannot be sent back', async () => {
    const socket = new FakeSocket();
    await hub.webSocketClose(socket as any, 1006, '', false);
    expect(socket.closedWith).toBe(1000);
  });
});
