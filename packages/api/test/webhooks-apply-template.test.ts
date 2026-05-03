/**
 * Webhook payload template engine — contract tests.
 *
 * Locks the four cases from Apify's docs (lone-variable splice,
 * mid-string interpolation, dot notation, missing key) plus
 * graceful fallback on invalid JSON. The runner ships an identical
 * engine and is expected to produce the same bytes.
 */

import { describe, it, expect } from 'vitest';
import { applyWebhookTemplate } from '../src/webhooks/apply-template.js';

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

describe('applyWebhookTemplate', () => {
  it('returns the default payload when template is null', () => {
    expect(applyWebhookTemplate(null, PAYLOAD)).toEqual(PAYLOAD);
  });

  it('returns the default payload when template is empty string', () => {
    expect(applyWebhookTemplate('', PAYLOAD)).toEqual(PAYLOAD);
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

  it('preserves number type via lone-variable splice', () => {
    const out = applyWebhookTemplate('{ "secs": "{{resource.stats.runTimeSecs}}" }', PAYLOAD);
    expect(out).toEqual({ secs: 42 });
  });

  it('writes JSON null for missing keys in lone-variable cells', () => {
    const out = applyWebhookTemplate('{ "missing": "{{nope}}" }', PAYLOAD);
    expect(out).toEqual({ missing: null });
  });

  it('writes empty string for missing keys in interpolation', () => {
    const out = applyWebhookTemplate('{ "msg": "before {{nope}} after" }', PAYLOAD);
    expect(out).toEqual({ msg: 'before  after' });
  });

  it('escapes special chars correctly in spliced strings', () => {
    const payloadWithQuote = { ...PAYLOAD, weird: 'has "quote" in it' };
    const out = applyWebhookTemplate('{ "x": "{{weird}}" }', payloadWithQuote);
    expect(out).toEqual({ x: 'has "quote" in it' });
  });

  it('handles whitespace inside braces: {{ key }} works the same as {{key}}', () => {
    const out = applyWebhookTemplate('{ "id": "{{ userId }}" }', PAYLOAD);
    expect(out).toEqual({ id: 'u-123' });
  });

  it('falls back to default payload when substitution produces invalid JSON', () => {
    // Template authoring error — placeholder lands inside an unbalanced struct.
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
    // Apify's docs show this exact form. The previous regex two-pass
    // engine string-coerced the unquoted placeholders ("[object Object]")
    // and silently fell back to the default payload — fixed here.
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

  it('handles unquoted scalar placeholders as typed values', () => {
    const t = `{ "ms": {{resource.stats.runTimeSecs}}, "id": {{userId}} }`;
    const out = applyWebhookTemplate(t, PAYLOAD);
    expect(out).toEqual({ ms: 42, id: 'u-123' });
  });
});
