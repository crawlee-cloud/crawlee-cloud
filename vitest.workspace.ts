import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/actor",
  "packages/cli",
  "packages/api",
  "packages/runner",
]);
