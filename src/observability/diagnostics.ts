import type { Next } from 'hono';
import { splitSetCookieHeader } from 'better-auth/cookies';
import type { AppContext } from '@/types/context';
import { describeError, redact, redactText } from '@/observability/redact';

/**
 * Privacy safe diagnostics for sign in and session failures (issue 16).
 *
 * Workers Logs persists whatever the Worker writes to the console. Its own
 * invocation logs are switched off at deploy, because they carry full URLs
 * (the OAuth callback's `code` and `state`), so these lines are the record:
 *
 *   gw.request      one per request: what was asked, what came back, how long
 *                   it took and how the session database behaved meanwhile
 *   gw.d1_error     a session database statement that failed
 *   gw.d1_slow      a statement slower than SLOW_STATEMENT_MS
 *   gw.better_auth  Better Auth's own warnings and errors
 *   gw.oauth_user   whether the Google account passed the email policy
 *
 * Lines carry the Cloudflare ray, which the edge's logs share, never an email,
 * IP address, cookie value, token, OAuth code or query value. A person is named
 * by `who`, a keyed pseudonym of their email (see `pseudonym`), or by their
 * Better Auth user id.
 */

export const SLOW_STATEMENT_MS = 1000;
const SLOW_REQUEST_MS = 3000;

/**
 * Failures Cloudflare documents as transient for D1 (issue 18): the database
 * object was reset or the connection to it dropped, and the statement did not
 * run to completion. Quota, constraint and syntax errors never match, so they
 * fail at once. Retrying a write is safe because Better Auth supplies primary
 * keys: one that did commit fails the retry on its duplicate key instead.
 */
const TRANSIENT_D1 = /object to be reset|reset because its code was updated|network connection lost|transient issue on remote node/i;
const D1_ATTEMPTS = 3;
const D1_RETRY_MS = [50, 200];

export interface Diagnostics {
  ray: string;
  d1: { statements: number; ms: number; failures: number };
  who?: string;
  uid?: string;
  notes: string[];
}

type Level = 'info' | 'warn' | 'error';

export function diagLog(level: Level, evt: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ evt, level, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function newDiagnostics(ray: string): Diagnostics {
  return { ray, d1: { statements: 0, ms: 0, failures: 0 }, notes: [] };
}

/** Operation and table of a statement, never its values. */
export function describeStatement(sql: string): { op: string; table: string } {
  const op = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '?';
  const table = /\b(?:from|into|update|join|table)\s+["`[]?(\w+)/i.exec(sql)?.[1] ?? '?';
  return { op, table };
}

/**
 * Times every statement Better Auth runs on the session database. The Kysely
 * D1 dialect only uses `prepare(sql).bind(...).all()` and `batch`, but every
 * execution method is wrapped so a future dialect cannot slip past.
 */
export function instrumentD1(db: D1Database, diag: Diagnostics): D1Database {
  const time = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await run();
        } catch (error) {
          if (attempt >= D1_ATTEMPTS || !TRANSIENT_D1.test(error instanceof Error ? error.message : String(error))) throw error;
          diagLog('warn', 'gw.d1_retry', { ray: diag.ray, ...describeStatement(sql), attempt, error: describeError(error) });
          await new Promise(resolve => setTimeout(resolve, D1_RETRY_MS[attempt - 1]));
        }
      }
    } catch (error) {
      diag.d1.failures++;
      diagLog('error', 'gw.d1_error', { ray: diag.ray, ...describeStatement(sql), ms: Date.now() - started, error: describeError(error) });
      throw error;
    } finally {
      const ms = Date.now() - started;
      diag.d1.statements++;
      diag.d1.ms += ms;
      if (ms >= SLOW_STATEMENT_MS) diagLog('warn', 'gw.d1_slow', { ray: diag.ray, ...describeStatement(sql), ms });
    }
  };
  const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values), sql);
        if (key === 'all' || key === 'first' || key === 'run' || key === 'raw')
          return (...args: unknown[]) => time(sql, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const sqlOf = new WeakMap<object, string>();
  return new Proxy(db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'prepare')
        return (sql: string) => {
          const wrapped = statement(target.prepare(sql), sql);
          sqlOf.set(wrapped, sql);
          return wrapped;
        };
      if (key === 'batch')
        return (statements: D1PreparedStatement[]) =>
          time(`BATCH ${statements.map(s => describeStatement(sqlOf.get(s) ?? '?').table).join(',')}`, () => target.batch(statements));
      if (key === 'exec') return (sql: string) => time(sql, () => target.exec(sql));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const encoder = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(data));
}

/**
 * A stable, non reversible name for an email in logs. Keyed by a key derived
 * from BETTER_AUTH_SECRET, so whoever reads the logs cannot test guesses
 * without the secret. `scripts/log-pseudonym.ts` computes it for one address.
 */
export async function pseudonym(secret: string, email: string): Promise<string> {
  const key = await hmac(encoder.encode(secret), 'prcpnt-gateway-log-pseudonym-v1');
  const digest = new Uint8Array(await hmac(key, email.trim().toLowerCase()));
  return Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

/** Browser and operating system families only, never the full user agent. */
export function clientFamily(userAgent: string | undefined): string {
  if (!userAgent) return 'none';
  const browser =
    /Edg\//.test(userAgent) ? 'Edge' :
    /OPR\//.test(userAgent) ? 'Opera' :
    /Firefox\//.test(userAgent) ? 'Firefox' :
    /Chrome\//.test(userAgent) ? 'Chrome' :
    /Safari\//.test(userAgent) ? 'Safari' :
    /agent-login/.test(userAgent) ? 'agent' : 'other';
  const os =
    /iPhone|iPad/.test(userAgent) ? 'iOS' :
    /Android/.test(userAgent) ? 'Android' :
    /Windows/.test(userAgent) ? 'Windows' :
    /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' :
    /Linux/.test(userAgent) ? 'Linux' : 'other';
  const version = /(?:Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(userAgent)?.[1];
  return `${browser}${version ? ` ${version}` : ''} / ${os}`;
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
function errorCode(params: URLSearchParams): string | undefined {
  const value = params.get('error');
  return value && ERROR_CODE.test(value) ? value : value ? 'unreadable' : undefined;
}

function cookieNames(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(';').map(part => part.split('=')[0]!.trim()).filter(name => /auth/i.test(name)).sort();
}

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return 'unreadable';
  }
}

/** Registered first, so its timing and line cover every other middleware. */
export function createDiagnosticsMiddleware() {
  return async (c: AppContext, next: Next) => {
    const started = Date.now();
    const ray = c.req.header('cf-ray') ?? crypto.randomUUID();
    const diag = newDiagnostics(ray);
    c.set('diag', diag);
    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const url = new URL(c.req.url);
      const status = thrown ? 500 : c.res.status;
      const location = c.res.headers.get('location') ?? undefined;
      let redirect: Record<string, unknown> | undefined;
      if (location) {
        try {
          const target = new URL(location, url);
          redirect = { host: target.host, path: target.pathname, error: errorCode(target.searchParams) };
        } catch {
          redirect = { path: 'unreadable' };
        }
      }
      const setCookies = splitSetCookieHeader(c.res.headers.get('set-cookie') ?? '').map(cookie => {
        const name = cookie.split('=')[0]!.trim();
        return /max-age=0|expires=thu, 01 jan 1970/i.test(cookie) ? `${name} (cleared)` : name;
      });
      const ms = Date.now() - started;
      const failed = status >= 500 || diag.d1.failures > 0 || redirect?.error !== undefined || errorCode(url.searchParams) !== undefined;
      const cf = (c.req.raw as { cf?: { colo?: string; country?: string } }).cf;
      diagLog(failed ? 'error' : ms >= SLOW_REQUEST_MS ? 'warn' : 'info', 'gw.request', {
        ray,
        method: c.req.method,
        path: url.pathname,
        status,
        ms,
        colo: cf?.colo,
        country: cf?.country,
        client: clientFamily(c.req.header('user-agent')),
        origin: hostOf(c.req.header('origin')),
        referrer: hostOf(c.req.header('referer')),
        query: [...new Set(url.searchParams.keys())].sort(),
        error: errorCode(url.searchParams),
        cookies: cookieNames(c.req.header('cookie')),
        setCookies,
        redirect,
        d1: diag.d1,
        who: diag.who,
        uid: diag.uid,
        notes: diag.notes.length ? diag.notes : undefined,
        thrown: thrown === undefined ? undefined : describeError(thrown),
      });
    }
  };
}

/** Better Auth's logger, routed through the scrubber with the request's ray. */
export function betterAuthLogger(diag: Diagnostics | undefined) {
  return {
    level: 'warn' as const,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => {
      diagLog(level === 'error' ? 'error' : 'warn', 'gw.better_auth', {
        ray: diag?.ray,
        betterAuthLevel: level,
        message: redactText(message),
        details: args.length ? args.map(arg => (arg instanceof Error ? describeError(arg) : redact(arg))) : undefined,
      });
    },
  };
}
