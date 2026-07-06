import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Public reactive query powering multi-tab session sync.
 *
 * Browser tabs subscribe with the JS-readable session id; the moment the
 * gateway deletes the session row (logout in any tab, or revocation), Convex
 * pushes the update and every subscribed tab flips to logged-out without a
 * refresh. The session id itself is the capability: it is a 128-bit random
 * bearer token, so holding it is proof of ownership.
 */
export const isActive = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    if (!sessionId) return { active: false as const };
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (!session || session.expiresAt < Date.now()) {
      return { active: false as const };
    }
    return {
      active: true as const,
      name: session.userName ?? null,
      email: session.userEmail ?? null,
      image: session.userImage ?? null,
    };
  },
});

/** Upsert a session row (called from the gateway via HTTP action). */
export const create = internalMutation({
  args: {
    sessionId: v.string(),
    userId: v.string(),
    userEmail: v.optional(v.string()),
    userName: v.optional(v.string()),
    userImage: v.optional(v.string()),
    expiresAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, lastActivity: now });
      return existing._id;
    }
    return await ctx.db.insert("sessions", {
      ...args,
      createdAt: now,
      lastActivity: now,
    });
  },
});

export const get = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .unique();
  },
});

export const touch = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (session) {
      await ctx.db.patch(session._id, { lastActivity: Date.now() });
    }
    return session !== null;
  },
});

export const remove = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (session) {
      await ctx.db.delete(session._id);
    }
    return session !== null;
  },
});

/** Housekeeping: purge sessions expired for more than a day. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const expired = await ctx.db
      .query("sessions")
      .filter((q) => q.lt(q.field("expiresAt"), cutoff))
      .take(500);
    for (const s of expired) {
      await ctx.db.delete(s._id);
    }
    return expired.length;
  },
});
