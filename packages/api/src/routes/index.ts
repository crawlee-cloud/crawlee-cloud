/**
 * Shared /v2 route registration.
 *
 * Production (`src/index.ts`) and the integration test app
 * (`test/integration/setup.ts`) both call this, so tests exercise exactly the
 * route set that ships. Registration order matches the historical order in
 * `src/index.ts`; keep it stable.
 */
import type { FastifyInstance } from 'fastify';
import { actorsRoutes } from './actors.js';
import { runsRoutes } from './runs.js';
import { datasetsRoutes } from './datasets.js';
import { keyValueStoresRoutes } from './key-value-stores.js';
import { requestQueuesRoutes } from './request-queues.js';
import { logsRoutes } from './logs.js';
import { registryRoutes, actorBuildsRoutes } from './registry.js';
import { usersRoutes } from './users.js';
import { webhooksRoutes } from './webhooks.js';
import { schedulesRoutes } from './schedules.js';
import { scalerRoutes } from './scaler.js';
import { systemRoutes } from './system.js';
import { storeRoutes } from './store.js';
import { setPlatformNotFoundHandler } from './not-found.js';

export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  // apify-client >= 2.23.4 uses /v2/actors; older clients and our own CLI and
  // dashboard use /v2/acts. Same handlers, registered once per segment.
  await app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'acts' });
  await app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'actors' });
  await app.register(runsRoutes, { prefix: '/v2' });
  await app.register(datasetsRoutes, { prefix: '/v2' });
  await app.register(keyValueStoresRoutes, { prefix: '/v2' });
  await app.register(requestQueuesRoutes, { prefix: '/v2' });
  await app.register(logsRoutes, { prefix: '/v2' });
  await app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'acts' });
  await app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'actors' });
  // /actor-builds/:buildId has no actor segment, so it's registered once.
  await app.register(actorBuildsRoutes, { prefix: '/v2' });
  await app.register(usersRoutes, { prefix: '/v2' });
  await app.register(webhooksRoutes, { prefix: '/v2' });
  await app.register(schedulesRoutes, { prefix: '/v2' });
  await app.register(scalerRoutes, { prefix: '/v2' });
  await app.register(systemRoutes, { prefix: '/v2' });
  await app.register(storeRoutes, { prefix: '/v2' });

  setPlatformNotFoundHandler(app);
}
