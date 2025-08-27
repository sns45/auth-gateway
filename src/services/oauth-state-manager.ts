import { CloudflareEnv } from "@/types/auth";
import { Logger } from "@/middleware/logging";

/**
 * OAuth State Manager
 * 
 * This class handles OAuth state and PKCE verifier storage for Better Auth.
 * It provides a workaround for state management issues in Cloudflare Workers.
 */
export class OAuthStateManager {
  private kv: KVNamespace;
  private logger: Logger;

  constructor(env: CloudflareEnv, logger: Logger) {
    this.kv = env.AUTH_STORE;
    this.logger = logger;
  }

  /**
   * Store OAuth state data
   */
  async storeState(state: string, data: any): Promise<void> {
    const key = `oauth_state:${state}`;
    const value = JSON.stringify({
      ...data,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    });

    this.logger.info("Storing OAuth state", { key, data });
    
    await this.kv.put(key, value, {
      expirationTtl: 600, // 10 minutes in seconds
    });
  }

  /**
   * Retrieve OAuth state data
   */
  async getState(state: string): Promise<any | null> {
    const key = `oauth_state:${state}`;
    
    this.logger.info("Retrieving OAuth state", { key });
    
    const value = await this.kv.get(key);
    if (!value) {
      this.logger.warn("OAuth state not found", { key });
      return null;
    }

    try {
      const data = JSON.parse(value);
      
      // Check if state has expired
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        this.logger.warn("OAuth state expired", { key, expiresAt: data.expiresAt });
        await this.deleteState(state);
        return null;
      }

      this.logger.info("OAuth state retrieved", { key, data });
      return data;
    } catch (error) {
      this.logger.error("Failed to parse OAuth state", { key, error });
      return null;
    }
  }

  /**
   * Delete OAuth state data
   */
  async deleteState(state: string): Promise<void> {
    const key = `oauth_state:${state}`;
    this.logger.info("Deleting OAuth state", { key });
    await this.kv.delete(key);
  }

  /**
   * Clean up expired states (maintenance function)
   */
  async cleanupExpiredStates(): Promise<void> {
    try {
      const { keys } = await this.kv.list({ prefix: "oauth_state:" });
      
      for (const { name } of keys) {
        const value = await this.kv.get(name);
        if (value) {
          try {
            const data = JSON.parse(value);
            if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
              await this.kv.delete(name);
              this.logger.info("Cleaned up expired OAuth state", { key: name });
            }
          } catch (error) {
            // Ignore parse errors and delete invalid entries
            await this.kv.delete(name);
          }
        }
      }
    } catch (error) {
      this.logger.error("Failed to cleanup expired OAuth states", { error });
    }
  }
}