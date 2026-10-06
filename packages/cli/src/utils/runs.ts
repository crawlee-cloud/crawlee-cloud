/**
 * Starting remote runs (`POST /v2/acts/:actorId/runs`). Every command that
 * starts a run goes through `startRun` so the request shape is decided in
 * one place.
 */

import type { CLIConfig } from './config.js';
import { getRunBodyShape, type RunBodyShape } from './api-capabilities.js';

export interface StartRunOptions {
  input?: unknown;
  /** Seconds. Omitted → the actor's default run options apply. */
  timeout?: number;
  /** MB. Omitted → the actor's default run options apply. */
  memory?: number;
  envVars?: Record<string, string>;
}

export interface StartedRun {
  id: string;
  status: string;
}

/**
 * Builds the run-start request for the given shape.
 *
 * - `apify`: the body is the input itself; `timeout`, `memory` and
 *   `envVars` (base64-encoded JSON) go in the query, each only when set.
 * - `legacy`: the wrapper body `{ input, timeout, memory, envVars }` that
 *   APIs older than #115 expect. `input` is always present so the API's
 *   legacy detection is unambiguous.
 */
export function buildStartRunRequest(
  config: Pick<CLIConfig, 'apiBaseUrl' | 'token'>,
  actor: string,
  shape: RunBodyShape,
  options: StartRunOptions = {}
): { url: string; init: RequestInit } {
  const { input, timeout, memory, envVars } = options;
  const hasEnvVars = envVars !== undefined && Object.keys(envVars).length > 0;
  let url = `${config.apiBaseUrl}/v2/acts/${actor}/runs`;
  let body: string;

  if (shape === 'apify') {
    const qs = new URLSearchParams();
    if (timeout !== undefined) qs.set('timeout', String(timeout));
    if (memory !== undefined) qs.set('memory', String(memory));
    if (hasEnvVars) {
      qs.set('envVars', Buffer.from(JSON.stringify(envVars)).toString('base64'));
    }
    const query = qs.toString();
    if (query) url += `?${query}`;
    body = JSON.stringify(input ?? {});
  } else {
    body = JSON.stringify({
      input: input ?? {},
      timeout,
      memory,
      envVars: hasEnvVars ? envVars : undefined,
    });
  }

  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body,
    },
  };
}

/** Starts a run of `actor`, picking the request shape the API supports. */
export async function startRun(
  config: Pick<CLIConfig, 'apiBaseUrl' | 'token'>,
  actor: string,
  options: StartRunOptions = {}
): Promise<StartedRun> {
  const shape = await getRunBodyShape(config);
  const { url, init } = buildStartRunRequest(config, actor, shape, options);
  const response = await fetch(url, init);

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(errorData.error?.message || `API error: ${response.status}`);
  }

  const result = (await response.json()) as { data: StartedRun };
  return result.data;
}
