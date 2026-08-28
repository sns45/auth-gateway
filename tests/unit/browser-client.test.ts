/**
 * The client script the gateway serves to every consumer site.
 *
 * It ships as a string inside a TypeScript module, so nothing typechecks it
 * and nothing else would catch a malformed request until a browser did. That
 * is not hypothetical: sign out shipped without a JSON content type and every
 * call came back 415, which only surfaced on a real deployment.
 *
 * These run the real script against a stubbed browser and assert the requests
 * that actually leave it.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { BROWSER_CLIENT_JS } from '@/client/browser-client';

const GATEWAY = 'https://auth.example.com';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[];
let fakeWindow: any;

/** Run the client script against a stubbed browser and hand back its api. */
async function boot(sessionResponse: unknown = null) {
  calls = [];

  const listeners: Record<string, ((e: any) => void)[]> = {};
  fakeWindow = {
    location: { href: `${GATEWAY}/page`, origin: GATEWAY },
    addEventListener: (name: string, fn: any) => {
      (listeners[name] ??= []).push(fn);
    },
  };

  const fetchStub = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(sessionResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const scope = {
    window: fakeWindow,
    document: {
      currentScript: { src: `${GATEWAY}/client.js` },
      addEventListener: () => {},
      visibilityState: 'visible',
    },
    fetch: fetchStub,
    console,
    URL,
    Response,
    BroadcastChannel: undefined,
    WebSocket: class {
      readyState = 0;
      close() {}
    },
    setTimeout,
    Math,
    JSON,
  };

  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(scope), BROWSER_CLIENT_JS);
  run(...Object.values(scope));

  // Let the initial get-session settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return fakeWindow.authGateway;
}

const find = (suffix: string) => calls.find((c) => c.url.endsWith(suffix));

describe('on load', () => {
  test('asks the gateway for the current session', async () => {
    await boot(null);
    const call = find('/get-session');
    expect(call).toBeDefined();
    expect(call!.init.credentials).toBe('include');
  });

  test('derives the gateway origin from its own script tag', async () => {
    await boot(null);
    expect(find('/get-session')!.url).toBe(`${GATEWAY}/api/auth/get-session`);
  });
});

describe('signing out', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('sends a json content type and a body', async () => {
    // Better Auth answers 415 without the content type and 400 without a body.
    const api = await boot(null);
    await api.signOut();

    const call = find('/sign-out')!;
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(call.init.body).toBeTruthy();
    expect(call.init.credentials).toBe('include');
  });

  test('re-reads the session afterwards rather than assuming it worked', async () => {
    const api = await boot(null);
    calls.length = 0;
    await api.signOut();
    expect(find('/get-session')).toBeDefined();
  });
});

describe('signing in', () => {
  test('posts the provider and a return url', async () => {
    const api = await boot(null);
    api.signIn('google', { callbackURL: 'https://app.example.com/work' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = find('/sign-in/social')!;
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({
      provider: 'google',
      callbackURL: 'https://app.example.com/work',
    });
  });
});

describe('subscribers', () => {
  test('are called with the session once it resolves', async () => {
    const api = await boot({ user: { id: 'u1', email: 'a@b.c' }, session: { id: 's1' } });
    const seen: any[] = [];
    api.subscribe((s: any) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(seen[0].user.email).toBe('a@b.c');
  });

  test('can unsubscribe', async () => {
    const api = await boot(null);
    const seen: any[] = [];
    const off = api.subscribe((s: any) => seen.push(s));
    off();
    await api.refresh();
    expect(seen).toHaveLength(1);
  });
});
