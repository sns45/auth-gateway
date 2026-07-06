import { SessionData, UserProfile, CloudflareEnv } from '@/types/auth';
import { generateSessionId, encryptData, decryptData } from '@/utils/crypto';
import { Logger } from '@/middleware/logging';

// Define the expected structure of the session data from Convex
interface ConvexSessionData {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: number | string;
  expiresAt: number | string;
  lastActivity?: number | string;
}

// Define the expected structure of the response from Convex API
interface ConvexGetSessionResponse {
  session?: ConvexSessionData;
}

/**
 * Session Store Service
 * Manages session storage and retrieval using Cloudflare KV
 */
export class SessionService {
  private kv: KVNamespace;
  private secret: string;
  private maxAge: number;
  private env: CloudflareEnv;
  private convexSiteUrl?: string;
  private logger?: Logger;

  constructor(env: CloudflareEnv, logger?: Logger) {
    this.env = env;
    this.kv = env.AUTH_STORE;
    this.secret = env.SESSION_SECRET;
    this.maxAge = 86400; // 24 hours default
    this.convexSiteUrl = env.CONVEX_SITE_URL;
    this.logger = logger;
  }

  /**
   * Headers for Convex sync HTTP actions. The X-Sync-Key proves the request
   * comes from the gateway, so outsiders cannot forge or delete session rows.
   */
  private convexSyncHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.env.CONVEX_SYNC_SECRET) {
      headers['X-Sync-Key'] = this.env.CONVEX_SYNC_SECRET;
    }
    return headers;
  }

  /**
   * Get environment prefix for KV keys
   */
  private getEnvPrefix(): string {
    switch (this.env.NODE_ENV) {
      case 'production':
        return 'prod';
      case 'staging':
        return 'staging';
      default:
        return 'dev';
    }
  }

  /**
   * Create a new session
   */
  async createSession(
    user: UserProfile,
    ipAddress: string,
    userAgent: string,
    permissions: string[] = []
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const sessionId = generateSessionId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.maxAge * 1000).toISOString();

    const sessionData: SessionData = {
      user_id: user.id,
      user_role: user.role,
      permissions,
      ip_address: ipAddress,
      user_agent: userAgent,
      created_at: now,
      expires_at: expiresAt,
      last_activity: now,
    };

    // Encrypt session data before storing
    const encryptedData = await encryptData(JSON.stringify(sessionData), this.secret);
    
    // Store in KV with TTL and environment prefix
    const key = `${this.getEnvPrefix()}:sessions:${sessionId}`;
    try {
      await this.kv.put(key, encryptedData, {
        expirationTtl: this.maxAge,
      });
    } catch (error: any) {
      // If we hit KV limits, log it but continue with Convex-only storage
      if (error.message?.includes('limit exceeded')) {
        this.logger?.error('KV write limit exceeded, falling back to Convex-only storage', { 
          error: error.message,
          sessionId 
        });
        // Continue execution - Convex will be the source of truth
      } else {
        throw error; // Re-throw other errors
      }
    }

    // Sync with Convex for reactive updates
    if (this.convexSiteUrl) {
      try {
        await fetch(`${this.convexSiteUrl}/api/sessions/create`, {
          method: 'POST',
          headers: this.convexSyncHeaders(),
          body: JSON.stringify({
            sessionId,
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            userImage: user.avatar_url,
            expiresAt: Date.parse(expiresAt),
            ipAddress,
            userAgent,
          }),
        });
      } catch (error) {
        this.logger?.warn('Failed to sync session to Convex', { error, sessionId });
      }
    }

    return { sessionId, sessionData };
  }

  /**
   * Retrieve session data
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const key = `${this.getEnvPrefix()}:sessions:${sessionId}`;
      const encryptedData = await this.kv.get(key);
      if (!encryptedData) {
        // If not in KV, try to get from Convex as fallback
        if (this.convexSiteUrl) {
          try {
            const response = await fetch(`${this.convexSiteUrl}/api/sessions/get`, {
              method: 'POST',
              headers: this.convexSyncHeaders(),
              body: JSON.stringify({ sessionId }),
            });
            
            if (response.ok) {
              const convexSession: ConvexGetSessionResponse = await response.json();
              if (convexSession && convexSession.session) {
                // Reconstruct SessionData from Convex data
                const sessionData: SessionData = {
                  user_id: convexSession.session.userId,
                  user_role: 'user', // Default role, could be enhanced
                  permissions: [],
                  ip_address: convexSession.session.ipAddress || 'unknown',
                  user_agent: convexSession.session.userAgent || 'unknown',
                  created_at: new Date(convexSession.session.createdAt).toISOString(),
                  expires_at: new Date(convexSession.session.expiresAt).toISOString(),
                  last_activity: convexSession.session.lastActivity ? 
                    new Date(convexSession.session.lastActivity).toISOString() : 
                    new Date().toISOString(),
                };
                
                // Check if session is expired
                if (new Date(sessionData.expires_at) < new Date()) {
                  await this.deleteSession(sessionId);
                  return null;
                }
                
                return sessionData;
              }
            }
          } catch (error) {
            this.logger?.warn('Failed to get session from Convex fallback', { error, sessionId });
          }
        }
        return null;
      }

      // Decrypt session data
      const decryptedData = await decryptData(encryptedData, this.secret);
      const sessionData: SessionData = JSON.parse(decryptedData);

      // Check if session is expired
      if (new Date(sessionData.expires_at) < new Date()) {
        await this.deleteSession(sessionId);
        return null;
      }

      return sessionData;
    } catch (error) {
      console.error('Error retrieving session:', error);
      return null;
    }
  }

  /**
   * Update session activity timestamp
   * OPTIMIZATION: Only update KV if activity is older than 5 minutes to reduce writes
   */
  async updateSessionActivity(sessionId: string): Promise<boolean> {
    try {
      const sessionData = await this.getSession(sessionId);
      if (!sessionData) {
        return false;
      }

      // Check if last activity was less than 5 minutes ago
      const lastActivityTime = new Date(sessionData.last_activity).getTime();
      const now = Date.now();
      const fiveMinutesMs = 5 * 60 * 1000;
      
      if (now - lastActivityTime < fiveMinutesMs) {
        // Skip KV write if activity was recent
        // Still sync to Convex for real-time updates
        if (this.convexSiteUrl) {
          try {
            await fetch(`${this.convexSiteUrl}/api/sessions/update-activity`, {
              method: 'POST',
              headers: this.convexSyncHeaders(),
              body: JSON.stringify({ sessionId }),
            });
          } catch (error) {
            this.logger?.warn('Failed to sync session activity to Convex', { error, sessionId });
          }
        }
        return true;
      }

      // Update last activity
      sessionData.last_activity = new Date().toISOString();

      // Encrypt and store updated data
      const encryptedData = await encryptData(JSON.stringify(sessionData), this.secret);
      const key = `${this.getEnvPrefix()}:sessions:${sessionId}`;
      await this.kv.put(key, encryptedData, {
        expirationTtl: this.maxAge,
      });

      // Sync with Convex
      if (this.convexSiteUrl) {
        try {
          await fetch(`${this.convexSiteUrl}/api/sessions/update-activity`, {
            method: 'POST',
            headers: this.convexSyncHeaders(),
            body: JSON.stringify({ sessionId }),
          });
        } catch (error) {
          this.logger?.warn('Failed to sync session activity to Convex', { error, sessionId });
        }
      }

      return true;
    } catch (error) {
      console.error('Error updating session activity:', error);
      return false;
    }
  }

  /**
   * Update session permissions
   */
  async updateSessionPermissions(sessionId: string, permissions: string[]): Promise<boolean> {
    try {
      const sessionData = await this.getSession(sessionId);
      if (!sessionData) {
        return false;
      }

      // Update permissions
      sessionData.permissions = permissions;
      sessionData.last_activity = new Date().toISOString();

      // Encrypt and store updated data
      const encryptedData = await encryptData(JSON.stringify(sessionData), this.secret);
      const key = `${this.getEnvPrefix()}:sessions:${sessionId}`;
      await this.kv.put(key, encryptedData, {
        expirationTtl: this.maxAge,
      });

      return true;
    } catch (error) {
      console.error('Error updating session permissions:', error);
      return false;
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const key = `${this.getEnvPrefix()}:sessions:${sessionId}`;
      await this.kv.delete(key);
      
      // Sync with Convex
      if (this.convexSiteUrl) {
        try {
          await fetch(`${this.convexSiteUrl}/api/sessions/delete`, {
            method: 'POST',
            headers: this.convexSyncHeaders(),
            body: JSON.stringify({ sessionId }),
          });
        } catch (error) {
          this.logger?.warn('Failed to sync session deletion to Convex', { error, sessionId });
        }
      }
      
      return true;
    } catch (error) {
      console.error('Error deleting session:', error);
      return false;
    }
  }

  /**
   * Delete all sessions for a user
   */
  async deleteUserSessions(_userId: string): Promise<boolean> {
    try {
      // Note: This is a limitation of KV storage - we can't query by value
      // In a production system, you might want to maintain a separate index
      // For now, we'll need to track user sessions separately if this feature is needed
      console.warn('deleteUserSessions not implemented - KV limitation');
      return true;
    } catch (error) {
      console.error('Error deleting user sessions:', error);
      return false;
    }
  }

  /**
   * Validate session and check expiry
   */
  async validateSession(sessionId: string): Promise<SessionData | null> {
    const sessionData = await this.getSession(sessionId);
    if (!sessionData) {
      return null;
    }

    // Update activity timestamp (now rate-limited to every 5 minutes)
    await this.updateSessionActivity(sessionId);

    return sessionData;
  }

  /**
   * Rotate session ID (create new session with same data)
   */
  async rotateSession(
    oldSessionId: string,
    user: UserProfile,
    permissions: string[]
  ): Promise<{ sessionId: string; sessionData: SessionData } | null> {
    const oldSession = await this.getSession(oldSessionId);
    if (!oldSession) {
      return null;
    }

    // Create new session
    const newSession = await this.createSession(
      user,
      oldSession.ip_address,
      oldSession.user_agent,
      permissions
    );

    // Delete old session
    await this.deleteSession(oldSessionId);

    return newSession;
  }

  /**
   * Get session statistics (for monitoring)
   */
  async getSessionStats(): Promise<{
    activeSessions: number;
    memoryUsage: number;
  }> {
    // Note: KV doesn't provide direct stats, so this is a placeholder
    // In production, you might track this separately
    return {
      activeSessions: 0, // Would need separate tracking
      memoryUsage: 0,    // Would need separate tracking
    };
  }

  /**
   * Cleanup expired sessions (maintenance task)
   */
  async cleanupExpiredSessions(): Promise<number> {
    // Note: KV automatically handles expiration, so this is mainly for logging
    console.info('KV storage automatically handles session expiration');
    return 0;
  }
}