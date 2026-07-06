import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { toProfile } from "./users";

/**
 * HTTP actions implementing the auth gateway's Convex contract:
 *
 *   POST /api/auth/oauth-user          upsert user on OAuth login
 *   POST /api/users/get-by-id          fetch user profile
 *   POST /api/users/update-last-login  bump last login
 *   POST /api/users/get-permissions    role-based permissions
 *   POST /api/sessions/create          mirror a new session
 *   POST /api/sessions/get             read a session (KV fallback path)
 *   POST /api/sessions/update-activity bump last activity
 *   POST /api/sessions/delete          remove a session (logout)
 *
 * Every endpoint requires the X-Sync-Key header to match the CONVEX_SYNC_SECRET
 * environment variable. Without it, an outsider could forge session rows and
 * the gateway's Convex fallback would trust them; with it, only the gateway
 * can write here. The public reactive read is convex/sessions.ts:isActive.
 */

const http = httpRouter();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function unauthorized(request: Request): Response | null {
  const secret = process.env.CONVEX_SYNC_SECRET;
  if (!secret) {
    // Fail closed: refuse everything until the secret is configured.
    return json({ success: false, error: "sync secret not configured" }, 503);
  }
  if (request.headers.get("x-sync-key") !== secret) {
    return json({ success: false, error: "unauthorized" }, 401);
  }
  return null;
}

http.route({
  path: "/api/auth/oauth-user",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    try {
      const body = (await request.json()) as {
        provider: string;
        oauthUserId: string;
        email: string;
        name: string;
        avatarUrl?: string;
      };
      if (!body.provider || !body.oauthUserId || !body.email) {
        return json({ success: false, error: "missing required fields" }, 400);
      }
      const user = await ctx.runMutation(internal.users.upsertOAuthUser, {
        provider: body.provider,
        oauthUserId: body.oauthUserId,
        email: body.email,
        name: body.name || body.email,
        avatarUrl: body.avatarUrl,
      });
      return json({ success: true, user: toProfile(user) });
    } catch (error) {
      return json({ success: false, error: String(error) }, 500);
    }
  }),
});

http.route({
  path: "/api/users/get-by-id",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { userId } = (await request.json()) as { userId: string };
    const user = await ctx.runQuery(internal.users.getById, { userId });
    if (!user) return json({ success: false, error: "user not found" }, 404);
    return json({ success: true, user: toProfile(user) });
  }),
});

http.route({
  path: "/api/users/update-last-login",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { userId } = (await request.json()) as { userId: string };
    const ok = await ctx.runMutation(internal.users.updateLastLogin, { userId });
    return json({ success: ok });
  }),
});

http.route({
  path: "/api/users/get-permissions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { userId } = (await request.json()) as { userId: string };
    const user = await ctx.runQuery(internal.users.getById, { userId });
    const role = user?.role ?? "user";
    const permissions =
      role === "admin" ? ["read", "write", "delete", "admin"] : ["read", "write"];
    return json({ success: true, permissions });
  }),
});

http.route({
  path: "/api/sessions/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    try {
      const body = (await request.json()) as {
        sessionId: string;
        userId: string;
        userEmail?: string;
        userName?: string;
        userImage?: string;
        expiresAt: number;
        ipAddress?: string;
        userAgent?: string;
      };
      if (!body.sessionId || !body.userId || !body.expiresAt) {
        return json({ success: false, error: "missing required fields" }, 400);
      }
      await ctx.runMutation(internal.sessions.create, body);
      return json({ success: true });
    } catch (error) {
      return json({ success: false, error: String(error) }, 500);
    }
  }),
});

http.route({
  path: "/api/sessions/get",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { sessionId } = (await request.json()) as { sessionId: string };
    const session = await ctx.runQuery(internal.sessions.get, { sessionId });
    if (!session) return json({ session: null }, 404);
    return json({
      session: {
        userId: session.userId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastActivity: session.lastActivity,
      },
    });
  }),
});

http.route({
  path: "/api/sessions/update-activity",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { sessionId } = (await request.json()) as { sessionId: string };
    const ok = await ctx.runMutation(internal.sessions.touch, { sessionId });
    return json({ success: ok });
  }),
});

http.route({
  path: "/api/sessions/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;
    const { sessionId } = (await request.json()) as { sessionId: string };
    await ctx.runMutation(internal.sessions.remove, { sessionId });
    return json({ success: true });
  }),
});

export default http;
