/**
 * lib/run-body.ts unit tests — legacy-body detection truth table, option
 * parsing for both contracts, and the content-type gate (#115).
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  isLegacyRunBody,
  isUnsupportedRunContentType,
  parseRunStartRequest,
} from '../src/lib/run-body.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

describe('isLegacyRunBody', () => {
  it.each<[string, unknown, boolean]>([
    ['{} (empty object)', {}, false],
    ['{input:{}}', { input: {} }, true],
    ['{input:{}, timeout:60}', { input: {}, timeout: 60 }, true],
    ['{input:{}, foo:1} (unknown key)', { input: {}, foo: 1 }, false],
    ['{timeout:3600, memory:1024} (dashboard, empty input)', { timeout: 3600, memory: 1024 }, true],
    ['{timeout:"x"} (wrong type, no input)', { timeout: 'x' }, false],
    ['{query:"x"} (Apify input)', { query: 'x' }, false],
    ['[] (array)', [], false],
    ['"str" (string)', 'str', false],
    ['null', null, false],
  ])('%s → %s', (_label, body, expected) => {
    expect(isLegacyRunBody(body)).toBe(expected);
  });

  it('accepts option-only bodies only when every value has the legacy type', () => {
    expect(isLegacyRunBody({ envVars: { A: '1' }, webhooks: [] })).toBe(true);
    expect(isLegacyRunBody({ envVars: { A: 1 } })).toBe(false);
    expect(isLegacyRunBody({ timeout: 1.5 })).toBe(false);
    expect(isLegacyRunBody({ webhooks: {} })).toBe(false);
    expect(isLegacyRunBody(undefined)).toBe(false);
  });

  it('with an input key, option types are left to ActorRunSchema', () => {
    expect(isLegacyRunBody({ input: 1, timeout: 'x' })).toBe(true);
  });
});

describe('parseRunStartRequest', () => {
  it('legacy: reads options from the body and ignores query options', () => {
    const parsed = parseRunStartRequest(
      { input: { a: 1 }, timeout: 60, memory: 512, envVars: { K: 'v' } },
      { timeout: '999', waitForFinish: '5' }
    );
    expect(parsed).toEqual({
      legacy: true,
      input: { a: 1 },
      timeout: 60,
      memory: 512,
      envVars: { K: 'v' },
      webhooks: undefined,
      waitForFinish: 5,
    });
  });

  it('legacy: dashboard body without input starts with {}', () => {
    const parsed = parseRunStartRequest({ timeout: 3600, memory: 1024 }, {});
    expect(parsed.legacy).toBe(true);
    expect(parsed.input).toEqual({});
    expect(parsed.timeout).toBe(3600);
    expect(parsed.memory).toBe(1024);
  });

  it('legacy: invalid option values are still a validation error', () => {
    expect(() => parseRunStartRequest({ input: {}, timeout: 'x' }, {})).toThrow(ZodError);
  });

  it('Apify: the whole body is the input and options come from the query', () => {
    const webhooks = [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: 'https://e.com/h' }];
    const parsed = parseRunStartRequest(
      { query: 'x', envVars: { NOT: 'applied' }, timeout: 'not-an-option' },
      {
        timeout: '60',
        memory: '512',
        waitForFinish: '999999',
        webhooks: b64(webhooks),
        envVars: b64({ K: 'v' }),
        build: 'latest',
        maxItems: '10',
        maxTotalChargeUsd: '1.5',
        restartOnError: '1',
        forcePermissionLevel: 'LIMITED_PERMISSIONS',
        somethingElse: 'ignored',
      }
    );
    expect(parsed).toEqual({
      legacy: false,
      input: { query: 'x', envVars: { NOT: 'applied' }, timeout: 'not-an-option' },
      timeout: 60,
      memory: 512,
      envVars: { K: 'v' },
      webhooks,
      waitForFinish: 60, // clamped
    });
  });

  it('Apify: no body becomes {}, non-object JSON is kept as given', () => {
    expect(parseRunStartRequest(undefined, {}).input).toEqual({});
    expect(parseRunStartRequest({}, {}).input).toEqual({});
    expect(parseRunStartRequest([1, 2], {}).input).toEqual([1, 2]);
    expect(parseRunStartRequest('str', {}).input).toBe('str');
    expect(parseRunStartRequest(null, {}).input).toBeNull();
  });

  it.each([
    ['timeout', '0'],
    ['timeout', '86401'],
    ['memory', 'abc'],
    ['memory', '16385'],
    ['webhooks', 'not base64 json'],
    ['webhooks', b64([{ eventTypes: ['ACTOR.RUN.RESURRECTED'], requestUrl: 'https://e.com' }])],
    ['envVars', b64({ K: 1 })],
    ['waitForFinish', '-1'],
  ])('Apify: rejects invalid query %s=%s', (key, value) => {
    expect(() => parseRunStartRequest({ q: 1 }, { [key]: value })).toThrow(ZodError);
  });
});

describe('isUnsupportedRunContentType', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ['application/json', false],
    ['application/json; charset=utf-8', false],
    ['Application/JSON', false],
    ['text/plain', true],
    ['text/plain; charset=utf-8', true],
    ['application/octet-stream', true],
    ['Text/Plain', true],
    ['application/x-www-form-urlencoded', false],
  ])('%s → %s', (contentType, expected) => {
    expect(isUnsupportedRunContentType(contentType)).toBe(expected);
  });
});
