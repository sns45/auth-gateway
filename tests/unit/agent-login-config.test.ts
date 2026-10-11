import { describe, expect, test } from 'vitest';
import { agentLoginConfig } from '@/agent-login';
import { EnvironmentSchema } from '@/utils/validation';

const env = {
  AGENT_LOGIN_ENABLED: 'true',
  AGENT_LOGIN_EMAIL: 'agent@prcpnt.com',
  AGENT_LOGIN_TOKEN: 'test-token-that-is-at-least-32-characters',
  AUTH_ALLOWED_DOMAINS: 'prcpnt.com',
};

describe('agent login names configuration', () => {
  test.each([
    ['build.1,agent2', ['build.1', 'agent2']],
    ['  build.1 , agent2  ', ['build.1', 'agent2']],
    ['a'.repeat(32), ['a'.repeat(32)]],
    [undefined, []],
    ['', []],
    ['build,UPPER', []],
    ['build,two words', []],
    ['build,' + 'a'.repeat(33), []],
    ['build,../path', []],
    ['build,agent_name', []],
    ['build,agent-name', []],
    ['build,.leading', []],
    ['build,trailing.', []],
    ['build,two..dots', []],
    ['build,', []],
    [',build', []],
    ['build, ,agent2', []],
  ])('parses %s without disabling the base account', (names, expected) => {
    expect(agentLoginConfig({ ...env, AGENT_LOGIN_NAMES: names as string | undefined })).toEqual({
      email: 'agent@prcpnt.com',
      token: env.AGENT_LOGIN_TOKEN,
      names: expected,
      allowedDomains: 'prcpnt.com',
    });
  });

  test('preserves the names setting through environment validation', () => {
    const validated = EnvironmentSchema.parse({
      ...env,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
      ALLOWED_ORIGINS: 'https://platform.example.com',
      OAUTH_BASE_URL: 'https://platform.example.com',
      AGENT_LOGIN_NAMES: 'build.1,agent2',
    });
    expect(validated.AGENT_LOGIN_NAMES).toBe('build.1,agent2');
  });
});
