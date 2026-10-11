/**
 * Stored as every agent session's userAgent. It marks agent sessions
 * independently of the configured email, so a session outlives neither the
 * flag nor a change of address. Reserved for the agent endpoint; ordinary
 * session creation and updates neutralize client supplied variants.
 * Exported on its own so a platform can pin it without Better Auth.
 */
export const AGENT_SESSION_MARKER = 'auth-gateway agent-login';
