import client from 'prom-client';

// Collect default Node.js metrics (GC, memory, event loop)
client.collectDefaultMetrics();

export const registry = client.register;

// --- HTTP metrics ---
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
});

/**
 * `route` label for the HTTP metrics. `/v2/actors` is an alias of `/v2/acts`
 * (same handlers, registered twice), so its routes are folded onto the
 * `/v2/acts` label: series cardinality stays the same and dashboards that
 * aggregate on `/v2/acts...` keep counting apify-client >= 2.23.4 traffic.
 * Anchored on a segment boundary so `/v2/actor-runs` is untouched.
 */
export function metricsRouteLabel(route: string): string {
  return route.replace(/^\/v2\/actors(?=\/|$)/, '/v2/acts');
}

// --- Application metrics ---
export const actorRunsTotal = new client.Counter({
  name: 'actor_runs_total',
  help: 'Total actor runs by final status',
  labelNames: ['status'] as const,
});

export const actorRunsActive = new client.Gauge({
  name: 'actor_runs_active',
  help: 'Currently active actor runs',
});

export const webhookDeliveriesTotal = new client.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook deliveries by status',
  labelNames: ['status'] as const,
});

export const schedulerActiveJobs = new client.Gauge({
  name: 'scheduler_active_jobs',
  help: 'Number of active cron scheduler jobs',
});

export const dbPoolActive = new client.Gauge({
  name: 'db_pool_active_connections',
  help: 'Active database pool connections',
});

export const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle_connections',
  help: 'Idle database pool connections',
});
