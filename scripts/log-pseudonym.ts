/**
 * Prints the log pseudonym (`who`) for one email, so a person's gateway log
 * lines can be found without logs ever holding their address.
 *
 *   BETTER_AUTH_SECRET=... bun scripts/log-pseudonym.ts person@example.com
 *
 * Read the secret from the secret store into the environment; never type it.
 */
import { pseudonym } from '../src/observability/diagnostics';

const email = process.argv[2];
const secret = process.env.BETTER_AUTH_SECRET;
if (!email || !secret) {
  console.error('usage: BETTER_AUTH_SECRET=... bun scripts/log-pseudonym.ts <email>');
  process.exit(2);
}
console.log(await pseudonym(secret, email));
