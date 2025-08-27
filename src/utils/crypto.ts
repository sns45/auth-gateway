import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a cryptographically secure random string
 */
export function generateSecureId(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  
  // Use crypto.getRandomValues for cryptographically secure random numbers
  const randomArray = new Uint8Array(length);
  crypto.getRandomValues(randomArray);
  
  for (let i = 0; i < length; i++) {
    result += chars[randomArray[i] % chars.length];
  }
  
  return result;
}

/**
 * Generate a session ID
 */
export function generateSessionId(): string {
  return `sess_${generateSecureId(32)}`;
}

/**
 * Generate a request ID for tracing
 */
export function generateRequestId(): string {
  return `req_${uuidv4().replace(/-/g, '')}`;
}

/**
 * Generate a CSRF token
 */
export function generateCSRFToken(): string {
  return `csrf_${generateSecureId(24)}`;
}

/**
 * Hash a password using subtle crypto
 */
export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  if (!salt) {
    salt = generateSecureId(16);
  }
  
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return { hash, salt };
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const { hash: newHash } = await hashPassword(password, salt);
  return newHash === hash;
}

/**
 * Generate OAuth state parameter
 */
export function generateOAuthState(): string {
  return `state_${generateSecureId(24)}`;
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Encrypt data using AES-GCM
 */
export async function encryptData(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    keyMaterial,
    encoder.encode(data)
  );
  
  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  
  // Convert to base64
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt data using AES-GCM
 */
export async function decryptData(encryptedData: string, secret: string): Promise<string> {
  try {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    // Convert from base64
    const combined = new Uint8Array(
      atob(encryptedData)
        .split('')
        .map(char => char.charCodeAt(0))
    );
    
    // Extract IV and encrypted data
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret.padEnd(32, '0').slice(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      keyMaterial,
      encrypted
    );
    
    return decoder.decode(decrypted);
  } catch (_error) {
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Create a secure hash of any string
 */
export async function createHash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}