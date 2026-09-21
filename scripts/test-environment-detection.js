#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the real application instead of copying hostname heuristics.
const result = spawnSync('bun', ['run', 'test:integration', '--', '-t', 'cookie policy parity|same security stack'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
