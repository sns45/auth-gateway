/** Every verified account on an explicitly allowed domain is an administrator.
 * Missing or malformed policy denies everyone. Subdomains need their own entry. */
export function authorizeAdministratorEmail(
  user: unknown,
  allowedDomains: string | undefined,
): string | null {
  if (!allowedDomains || !user || typeof user !== 'object') return null;
  const { email, emailVerified } = user as Record<string, unknown>;
  if (emailVerified !== true || typeof email !== 'string' || email.length > 254)
    return null;
  const domainPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const domains = allowedDomains
    .split(',')
    .map((value) => value.trim().toLowerCase());
  if (domains.some((value) => !domainPattern.test(value))) return null;
  const match = /^([^\s@]+)@([^\s@]+)$/.exec(email);
  if (!match) return null;
  const domain = match[2].toLowerCase();
  if (!domains.includes(domain)) return null;
  return `${match[1]}@${domain}`;
}
