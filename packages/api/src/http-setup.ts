/**
 * Shared HTTP plumbing: CORS, compression, content-type parsers, and the
 * global error handler.
 *
 * Production (`src/index.ts`) and the integration test app
 * (`test/integration/setup.ts`) both call this, so tests accept and reject
 * exactly the payloads production does (gzip bodies, large batch pushes,
 * form/binary uploads, ZodError → 400). Create the Fastify instance with
 * `bodyLimit: API_BODY_LIMIT` for the same reason.
 */
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import { ZodError } from 'zod';
import { config } from './config.js';

// Increase body limit for batch requests (10MB)
export const API_BODY_LIMIT = 10 * 1024 * 1024;

export async function configureHttp(app: FastifyInstance): Promise<void> {
  // CORS restricted to configured origins
  const allowedOrigins = config.corsOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (same-origin, curl, etc.)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Enable compression/decompression (handles gzip request bodies from SDK)
  await app.register(compress, { global: true });

  // Add content type parsers for Apify SDK compatibility
  // The SDK sends form-urlencoded for some endpoints
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      // For form-urlencoded, we just pass through - query params are used instead
      done(null, body || {});
    }
  );

  // Also handle text/plain for some SDK calls
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Handle octet-stream for binary data
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // Global Error Handler
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          type: 'validation_error',
          message: 'Validation failed',
          details: error.errors,
        },
      });
    }

    // Default error handler fallback
    // If status code is 4xx, just send it, otherwise log it
    if (!error.statusCode || error.statusCode >= 500) {
      request.log.error(error);
    }

    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      error: {
        type: error.name,
        message: error.message,
      },
    });
  });
}
