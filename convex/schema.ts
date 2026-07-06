import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Backing store for the auth gateway. Sessions are mirrored here from the
// gateway's KV primary so browser tabs can subscribe reactively (multi-tab
// logout sync); users persist OAuth identities across sessions.
export default defineSchema({
  users: defineTable({
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
    provider: v.string(),
    oauthUserId: v.string(),
    role: v.string(),
    createdAt: v.number(),
    lastLoginAt: v.number(),
  })
    .index("by_oauth", ["provider", "oauthUserId"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    sessionId: v.string(),
    userId: v.string(),
    userEmail: v.optional(v.string()),
    userName: v.optional(v.string()),
    userImage: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastActivity: v.number(),
  }).index("by_sessionId", ["sessionId"]),
});
