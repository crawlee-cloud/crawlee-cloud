/**
 * Leader-elected wrapper around setupAdminUser for multi-replica
 * deployments. One replica acquires the setup advisory lock and runs
 * the full bootstrap; others observe { acquired: false } and skip.
 *
 * See docs/superpowers/specs/2026-06-03-api-multi-replica-design.md
 * §Section 4 for the rationale.
 */
import { withAdvisoryLock, LOCK_IDS } from './db/index.js';
import { setupAdminUser } from './setup.js';

export async function setupAdminUserGated(): Promise<void> {
  const r = await withAdvisoryLock(LOCK_IDS.setup, async () => {
    await setupAdminUser();
    return true;
  });
  if (!r.acquired) {
    console.log('[Setup] Another replica is bootstrapping; skipping');
  }
}
