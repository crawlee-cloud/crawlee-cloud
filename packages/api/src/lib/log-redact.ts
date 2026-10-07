/**
 * Request-log redaction for query parameters that can carry secrets.
 *
 * The Apify run-start contract (#115) puts run options in the query string,
 * including our `envVars` extension (base64 JSON, used by `crc call -e`) and
 * `webhooks` (base64 JSON, may embed auth headers in payload templates).
 * Fastify's default request serializer logs the full URL, so without this
 * those values would land in API logs. Values are replaced, keys are kept, so
 * the log still shows which options a request used.
 */
import type { FastifyRequest } from 'fastify';

export const REDACTED_QUERY_PARAMS: readonly string[] = ['envVars', 'webhooks', 'token'];

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of REDACTED_QUERY_PARAMS) {
    if (params.has(key)) {
      params.set(key, '[REDACTED]');
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** Drop-in for Fastify's default `req` log serializer, with the URL redacted. */
export function serializeRequestForLog(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
