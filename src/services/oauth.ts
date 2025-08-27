import { OAuthProvider, OAuthConfig, CloudflareEnv } from '@/types/auth';
import { generateOAuthState } from '@/utils/crypto';

/**
 * OAuth Service
 * Handles OAuth flows for different providers
 */
export class OAuthService {
  private configs: Map<OAuthProvider, OAuthConfig>;

  constructor(env: CloudflareEnv) {
    this.configs = new Map();
    this.initializeConfigs(env);
  }

  /**
   * Initialize OAuth provider configurations
   */
  private initializeConfigs(env: CloudflareEnv) {
    // Google OAuth
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      this.configs.set('google', {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.googleapis.com/token',
        user_info_url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        scopes: ['openid', 'email', 'profile'],
      });
    }

    // Additional OAuth providers can be added here when needed
  }

  /**
   * Get authorization URL for OAuth provider
   */
  getAuthorizationUrl(
    provider: OAuthProvider,
    redirectUri: string,
    state?: string
  ): string | null {
    const config = this.configs.get(provider);
    if (!config) {
      return null;
    }

    const authState = state || generateOAuthState();
    const params = new URLSearchParams({
      client_id: config.client_id,
      redirect_uri: redirectUri,
      scope: config.scopes.join(' '),
      state: authState,
      response_type: 'code',
    });

    // Provider-specific parameters
    if (provider === 'google') {
      params.set('access_type', 'offline');
      params.set('prompt', 'consent');
    }

    return `${config.authorize_url}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    provider: OAuthProvider,
    code: string,
    redirectUri: string
  ): Promise<string | null> {
    const config = this.configs.get(provider);
    if (!config) {
      throw new Error(`OAuth provider ${provider} not configured`);
    }

    try {
      const tokenData = new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const response = await fetch(config.token_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: tokenData.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }

      const data = await response.json() as { access_token: string };
      return data.access_token;
    } catch (error) {
      console.error(`OAuth token exchange error for ${provider}:`, error);
      throw new Error('OAuth token exchange failed');
    }
  }

  /**
   * Get user info from OAuth provider
   */
  async getUserInfo(
    provider: OAuthProvider,
    accessToken: string
  ): Promise<{
    id: string;
    email: string;
    name: string;
    avatar_url?: string;
  } | null> {
    const config = this.configs.get(provider);
    if (!config) {
      throw new Error(`OAuth provider ${provider} not configured`);
    }

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      };


      const response = await fetch(config.user_info_url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(`User info request failed: ${response.statusText}`);
      }

      const userData = await response.json();
      return this.normalizeUserData(provider, userData);
    } catch (error) {
      console.error(`OAuth user info error for ${provider}:`, error);
      throw new Error('OAuth user info request failed');
    }
  }


  /**
   * Check if provider is supported
   */
  isProviderSupported(provider: string): provider is OAuthProvider {
    return this.configs.has(provider as OAuthProvider);
  }

  /**
   * Get list of available providers
   */
  getAvailableProviders(): OAuthProvider[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Normalize user data from different providers
   */
  private normalizeUserData(
    provider: OAuthProvider,
    userData: any
  ): {
    id: string;
    email: string;
    name: string;
    avatar_url?: string;
  } {
    switch (provider) {
      case 'google':
        return {
          id: userData.id,
          email: userData.email,
          name: userData.name || `${userData.given_name} ${userData.family_name}`.trim(),
          avatar_url: userData.picture,
        };


      default:
        throw new Error(`Unsupported OAuth provider: ${provider}`);
    }
  }

  /**
   * Validate OAuth state parameter
   */
  validateState(receivedState: string, expectedState: string): boolean {
    return receivedState === expectedState;
  }

  /**
   * Generate OAuth redirect URI
   * Uses the configured OAuth base URL to ensure callbacks go through the gateway
   */
  generateRedirectUri(baseUrl: string, provider: OAuthProvider): string {
    return `${baseUrl}/auth/oauth/${provider}/callback`;
  }

  /**
   * Get configured OAuth base URL from environment
   * Falls back to request-based URL if not configured
   */
  getOAuthBaseUrl(env: any, fallbackUrl: string): string {
    return env.OAUTH_BASE_URL || fallbackUrl;
  }
}