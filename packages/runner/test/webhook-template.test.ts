/**
 * Webhook payload template engine — runner-side contract tests.
 *
 * KEEP IN SYNC with packages/api/test/webhooks-apply-template.test.ts.
 * Both engines must produce byte-identical output for the same template
 * and payload — drift between them would mean "test webhook" in the
 * dashboard sends different bytes than production deliveries do.
 */

import { describe, it, expect } from 'vitest';
import { applyWebhookTemplate } from '../src/webhook-template.js';

const PAYLOAD = {
  userId: 'u-123',
  createdAt: '2026-05-03T12:00:00Z',
  eventType: 'ACTOR.RUN.SUCCEEDED',
  eventData: { actorId: 'act-1', actorRunId: 'run-1' },
  resource: {
    id: 'run-1',
    status: 'SUCCEEDED',
    stats: { runTimeSecs: 42, computeUnits: 0.001 },
  },
};

describe('applyWebhookTemplate (runner)', () => {
  it('returns the default payload when template is null', () => {
    expect(applyWebhookTemplate(null, PAYLOAD)).toEqual(PAYLOAD);
  });

  it('splices a typed object for lone-variable cells: "{{eventData}}" → object', () => {
    const out = applyWebhookTemplate('{ "data": "{{eventData}}" }', PAYLOAD);
    expect(out).toEqual({ data: { actorId: 'act-1', actorRunId: 'run-1' } });
  });

  it('keeps quotes on lone-variable string values: "{{userId}}" → "u-123"', () => {
    const out = applyWebhookTemplate('{ "id": "{{userId}}" }', PAYLOAD);
    expect(out).toEqual({ id: 'u-123' });
  });

  it('string-interpolates mid-string placeholders', () => {
    const out = applyWebhookTemplate(
      '{ "msg": "User {{userId}} finished {{eventType}}" }',
      PAYLOAD
    );
    expect(out).toEqual({ msg: 'User u-123 finished ACTOR.RUN.SUCCEEDED' });
  });

  it('drills into nested properties via dot notation', () => {
    const out = applyWebhookTemplate(
      '{ "runId": "{{eventData.actorRunId}}", "secs": "{{resource.stats.runTimeSecs}}" }',
      PAYLOAD
    );
    expect(out).toEqual({ runId: 'run-1', secs: 42 });
  });

  it('writes JSON null for missing keys in lone-variable cells', () => {
    const out = applyWebhookTemplate('{ "missing": "{{nope}}" }', PAYLOAD);
    expect(out).toEqual({ missing: null });
  });

  it('falls back to default payload when substitution produces invalid JSON', () => {
    const out = applyWebhookTemplate('{ "broken": {{userId}, "other": 1 }', PAYLOAD);
    expect(out).toEqual(PAYLOAD);
  });

  it('renders the quoted Apify default-shape template into the same payload', () => {
    const apifyDefault = `{
      "userId": "{{userId}}",
      "createdAt": "{{createdAt}}",
      "eventType": "{{eventType}}",
      "eventData": "{{eventData}}",
      "resource": "{{resource}}"
    }`;
    const out = applyWebhookTemplate(apifyDefault, PAYLOAD);
    expect(out).toEqual(PAYLOAD);
  });

  it('renders the UNQUOTED Apify default template (literal docs example) too', () => {
    const apifyUnquoted = `{
      "userId": {{userId}},
      "createdAt": {{createdAt}},
      "eventType": {{eventType}},
      "eventData": {{eventData}},
      "resource": {{resource}}
    }`;
    const out = applyWebhookTemplate(apifyUnquoted, PAYLOAD);
    expect(out).toEqual(PAYLOAD);
  });

  it('mixes quoted and unquoted forms in the same template', () => {
    const mixed = `{
      "id": "{{userId}}",
      "data": {{eventData}},
      "logged": "User {{userId}} fired {{eventType}}"
    }`;
    const out = applyWebhookTemplate(mixed, PAYLOAD);
    expect(out).toEqual({
      id: 'u-123',
      data: { actorId: 'act-1', actorRunId: 'run-1' },
      logged: 'User u-123 fired ACTOR.RUN.SUCCEEDED',
    });
  });
});
