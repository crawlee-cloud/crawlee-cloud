import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { redactUrl, serializeRequestForLog } from '../src/lib/log-redact.js';

describe('redactUrl', () => {
  it('leaves URLs without secret params untouched', () => {
    expect(redactUrl('/v2/acts/a/runs')).toBe('/v2/acts/a/runs');
    expect(redactUrl('/v2/acts/a/runs?timeout=60&memory=512')).toBe(
      '/v2/acts/a/runs?timeout=60&memory=512'
    );
  });

  it('redacts envVars, webhooks and token values but keeps other params', () => {
    const out = redactUrl(
      '/v2/acts/a/runs?timeout=60&envVars=eyJGT08iOiJiYXIifQ%3D%3D&webhooks=W10%3D&token=cp_x'
    );
    const params = new URLSearchParams(out.split('?')[1]);
    expect(params.get('timeout')).toBe('60');
    expect(params.get('envVars')).toBe('[REDACTED]');
    expect(params.get('webhooks')).toBe('[REDACTED]');
    expect(params.get('token')).toBe('[REDACTED]');
    expect(out).not.toContain('eyJGT08');
  });
});

describe('serializeRequestForLog', () => {
  it('keeps secrets out of Fastify request logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = Fastify({
      logger: { level: 'info', stream, serializers: { req: serializeRequestForLog } },
    });
    app.post('/v2/acts/:id/runs', async () => ({ ok: true }));
    await app.inject({
      method: 'POST',
      url: '/v2/acts/a/runs?envVars=c2VjcmV0&memory=512',
      payload: {},
    });
    await app.close();

    const incoming = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'incoming request');
    expect(incoming.req.method).toBe('POST');
    expect(incoming.req.url).toBe('/v2/acts/a/runs?envVars=%5BREDACTED%5D&memory=512');
    expect(lines.join('')).not.toContain('c2VjcmV0');
  });
});
