import { describe, expect, test } from 'vitest';
import { authorizeAdministratorEmail } from 'hono-auth-gateway/administrator-policy';

const domains = 'prcpnt.com,lattiq.com';
const verified = (email: string) => ({ email, emailVerified: true });

describe('administrator email policy', () => {
  test.each(['prcpnt.com', 'lattiq.com'])('permits a verified account at %s', domain => {
    expect(authorizeAdministratorEmail(verified(`Person@${domain.toUpperCase()}`), domains)).toBe(`Person@${domain}`);
  });

  test('normalizes configured domains and preserves the email local part', () => {
    expect(authorizeAdministratorEmail(verified('Person@LATTIQ.COM'), ' PRCPNT.COM, LATTIQ.COM ')).toBe('Person@lattiq.com');
  });

  test.each([undefined, '', 'prcpnt.com,', '*.prcpnt.com', 'https://prcpnt.com', 'prcpnt.com,lattiq_com'])('denies missing or malformed policy %s', policy => {
    expect(authorizeAdministratorEmail(verified('person@prcpnt.com'), policy)).toBeNull();
  });

  test.each([
    null, undefined, {}, 'person@prcpnt.com',
    { email: 'person@prcpnt.com', emailVerified: false },
    { email: 'person@lattiq.com', emailVerified: 'true' },
    verified('person@sub.prcpnt.com'), verified('person@evilprcpnt.com'),
    verified('person@elsewhere.com'), verified('person@@prcpnt.com'),
    verified(' person@prcpnt.com'), verified('person@prcpnt.com '),
    verified(`${'a'.repeat(245)}@prcpnt.com`),
  ])('denies an invalid or unauthorized identity', user => {
    expect(authorizeAdministratorEmail(user, domains)).toBeNull();
  });
});
