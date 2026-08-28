/**
 * Emit the Better Auth D1 schema from the *installed* better-auth version.
 *
 * `@better-auth/cli generate` is bundled with its own copy of the schema and
 * drifted behind the runtime (it omitted account.issuer, added in 1.7), which
 * fails at insert time rather than at migrate time. This calls the installed
 * library's own migration builder, so the DDL can never disagree with the
 * library actually running in the worker.
 *
 *   node scripts/generate-auth-schema.mjs > migrations/0001_better_auth.sql
 *
 * Options below are a deliberate superset of src/auth.ts: the schema carries
 * every column an enabled feature could need, so turning one on later is a
 * config change and not a migration.
 */
import { getMigrations } from '../node_modules/better-auth/dist/db/get-migration.mjs';
import { DatabaseSync } from 'node:sqlite';

const options = {
  database: new DatabaseSync(':memory:'),
  baseURL: 'https://auth.example.com',
  secret: 'schema-generation-only-not-a-real-secret',
  emailAndPassword: { enabled: true },
  socialProviders: { google: { clientId: 'x', clientSecret: 'y' } },
};

const { compileMigrations } = await getMigrations(options);
process.stdout.write(await compileMigrations());
