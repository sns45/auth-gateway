import { SignJWT, jwtVerify } from 'jose';
import { JWTPayload } from '@/types/auth';

const algorithm = 'HS256';

/**
 * Create and sign a JWT token
 */
export async function createJWT(
  payload: Omit<JWTPayload, 'iat' | 'exp' | 'iss' | 'aud'>,
  secret: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  
  const jwt = await new SignJWT({
    sub: payload.sub,
    role: payload.role,
    permissions: payload.permissions,
    session_id: payload.session_id,
  })
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .setIssuer('hono-auth-gateway')
    .setAudience('convex-api')
    .sign(secretKey);

  return jwt;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWT(
  token: string,
  secret: string
): Promise<JWTPayload> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: 'hono-auth-gateway',
      audience: 'convex-api',
    });

    // Type assertion with validation
    const jwtPayload: JWTPayload = {
      sub: payload.sub as string,
      role: payload.role as string,
      permissions: payload.permissions as string[],
      session_id: payload.session_id as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
      iss: payload.iss as string,
      aud: payload.aud as string,
    };

    // Validate required fields
    if (!jwtPayload.sub || !jwtPayload.role || !jwtPayload.session_id) {
      throw new Error('Invalid JWT payload: missing required fields');
    }

    return jwtPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`JWT verification failed: ${error.message}`);
    }
    throw new Error('JWT verification failed');
  }
}

/**
 * Extract JWT from Authorization header
 */
export function extractJWTFromHeader(authHeader?: string): string | null {
  if (!authHeader) return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
}

/**
 * Check if JWT is expired
 */
export function isJWTExpired(payload: JWTPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  return payload.exp < now;
}

/**
 * Get JWT expiration time in seconds from now
 */
export function getJWTTimeToExpiry(payload: JWTPayload): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, payload.exp - now);
}

/**
 * Create a refresh token (longer-lived JWT with minimal claims)
 */
export async function createRefreshToken(
  userId: string,
  sessionId: string,
  secret: string,
  expiresIn: number = 7 * 24 * 3600 // 7 days default
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  
  const jwt = await new SignJWT({
    sub: userId,
    session_id: sessionId,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .setIssuer('hono-auth-gateway')
    .setAudience('refresh-token')
    .sign(secretKey);

  return jwt;
}

/**
 * Verify refresh token
 */
export async function verifyRefreshToken(
  token: string,
  secret: string
): Promise<{ userId: string; sessionId: string }> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: 'hono-auth-gateway',
      audience: 'refresh-token',
    });

    if (payload.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    return {
      userId: payload.sub as string,
      sessionId: payload.session_id as string,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Refresh token verification failed: ${error.message}`);
    }
    throw new Error('Refresh token verification failed');
  }
}