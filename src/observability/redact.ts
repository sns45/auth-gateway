/**
 * Scrubbing for everything the gateway logs.
 *
 * Logs are persisted by Cloudflare and read while debugging, so they must not
 * carry anything that identifies a person or grants access: email addresses,
 * IP addresses, cookies, session tokens, OAuth codes or state. Free text from
 * libraries and errors goes through `redactText`; structured values go through
 * `redact`, which also drops whole fields whose names mark them as sensitive.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
// Session tokens, OAuth codes and state, JWTs and signed cookie values are all
// long runs of URL safe characters. Ordinary words, SQL and stack frames are not.
const JWT = /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g;
const TOKEN = /[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{8,}){0,2}/g;

const SENSITIVE_KEY = /cookie|authori[sz]ation|token|secret|password|passwd|^code$|^state$|code_?verifier|nonce|^ip$|ip_?address|email|headers?$|^url$/i;

export function redactText(value: string, max = 500): string {
  const text = value
    .replace(JWT, '<redacted>')
    .replace(EMAIL, '<email>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, '<ip>')
    .replace(TOKEN, '<redacted>');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return describeError(value, depth);
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

/** An error's name, message, cause chain and top frames, scrubbed. */
export function describeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return redact(error, depth + 1);
  return {
    name: error.name,
    message: redactText(error.message),
    ...(error.cause !== undefined && depth < 3 ? { cause: describeError(error.cause, depth + 1) } : {}),
    ...(error.stack ? { stack: redactText(error.stack.split('\n').slice(1, 5).map(line => line.trim()).join(' | '), 600) } : {}),
  };
}
