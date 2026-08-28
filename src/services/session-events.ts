import type { CloudflareEnv } from '@/types/auth';
import type { SessionEvent } from '@/durable/session-hub';

/**
 * Publish a session change to every tab the user has open.
 *
 * Addressed by user id rather than session id on purpose: "you were signed
 * out" has to reach the user's other sessions, which is the whole point.
 *
 * Never throws. A tab that misses a push still corrects itself on its next
 * focus refetch, so a hub failure degrades sync latency rather than breaking
 * the sign out that triggered it.
 */
export async function publishSessionEvent(
  env: CloudflareEnv,
  userId: string,
  event: SessionEvent
): Promise<void> {
  try {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName(userId));
    await stub.fetch('https://session-hub.internal/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Deliberately swallowed, see above.
  }
}
