import { Hono } from 'hono';
import { CloudflareEnv } from '@/types/auth';
import { Variables } from '@/types/context';
import { createAuth } from '@/auth';

/**
 * Better Auth owns every route under this mount.
 *
 * Deliberately a passthrough rather than a set of bespoke wrappers: a client
 * site can point any Better Auth client at this origin and work with no
 * gateway specific code, which is the whole point of the gateway existing.
 * See /api/auth/reference for the generated spec.
 *
 * Nothing is layered on top any more. This used to resolve the signed in user
 * before the handler ran and push an invalidation to that user's other tabs
 * through a Durable Object, which is the one feature that required a paid
 * Workers plan. Clients re-read get-session on a timer instead, so a sign out
 * writes to D1 and nothing else, and the extra session lookup this handler did
 * on every revocation is gone with it.
 */
export const authRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

authRoutes.all('*', (c) => createAuth(c.env, c.get('authConfig')).handler(c.req.raw));
