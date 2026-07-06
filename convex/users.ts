import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

/** Shape the gateway expects back for a user (its UserProfile type). */
export function toProfile(user: Doc<"users">) {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatarUrl,
    role: user.role,
    created_at: new Date(user.createdAt).toISOString(),
    last_login: new Date(user.lastLoginAt).toISOString(),
  };
}

/** Upsert an OAuth user on login (called from the gateway's OAuth callback). */
export const upsertOAuthUser = internalMutation({
  args: {
    provider: v.string(),
    oauthUserId: v.string(),
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_oauth", (q) =>
        q.eq("provider", args.provider).eq("oauthUserId", args.oauthUserId)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        name: args.name,
        avatarUrl: args.avatarUrl,
        lastLoginAt: now,
      });
      return (await ctx.db.get(existing._id))!;
    }
    const id = await ctx.db.insert("users", {
      email: args.email,
      name: args.name,
      avatarUrl: args.avatarUrl,
      provider: args.provider,
      oauthUserId: args.oauthUserId,
      role: "user",
      createdAt: now,
      lastLoginAt: now,
    });
    return (await ctx.db.get(id))!;
  },
});

export const getById = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const id = ctx.db.normalizeId("users", userId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

export const updateLastLogin = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const id = ctx.db.normalizeId("users", userId);
    if (!id) return false;
    const user = await ctx.db.get(id);
    if (!user) return false;
    await ctx.db.patch(id, { lastLoginAt: Date.now() });
    return true;
  },
});
