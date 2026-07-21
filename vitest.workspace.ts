import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/cli',
  'packages/api',
  'packages/runner',
  'packages/dashboard',
]);
