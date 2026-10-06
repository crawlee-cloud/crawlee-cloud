/**
 * Platform 404 envelope for unknown routes.
 *
 * Replaces Fastify's default `{ message, error, statusCode }` body so
 * apify-client can read `error.type`. Deliberately NOT `record-not-found`:
 * apify-client's catchNotFoundOrThrow turns that into `undefined`, which would
 * make every unimplemented endpoint look like a missing resource. 404s sent
 * from inside route handlers are unaffected.
 */
import type { FastifyInstance } from 'fastify';

export function setPlatformNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    return reply.status(404).send({
      error: {
        type: 'page-not-found',
        message: `Route ${request.method} ${path} not found`,
      },
    });
  });
}
