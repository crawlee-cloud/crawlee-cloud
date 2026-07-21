/**
 * Tests for webhook-payload secret redaction (queue.ts). These are pure
 * functions: secret-named keys get their string values masked down to a
 * "••• last4" form before payloads are persisted for debugging.
 */
import { describe, it, expect } from 'vitest';
import { redactSecretsForStorage, walkAndRedact } from '../src/queue.js';

describe('walkAndRedact', () => {
  it('masks long string values under secret-named keys, keeping the last 4 chars', () => {
    const out = walkAndRedact({
      token: 'super-secret-token-1234',
      password: 'hunter2hunter2',
      note: 'plain text stays',
    }) as Record<string, unknown>;
    expect(out.token).toBe('••• 1234');
    expect(out.password).toBe('••• ter2');
    expect(out.note).toBe('plain text stays');
  });

  it('matches credential-style key suffixes but not resource-id fields', () => {
    const out = walkAndRedact({
      apiKey: 'abcdefgh12345678',
      secretKey: 'abcdefgh12345678',
      defaultKeyValueStoreId: 'kvstore-id-123456',
      keyName: 'not-a-secret-name',
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('••• 5678');
    expect(out.secretKey).toBe('••• 5678');
    // `key$` is suffix-anchored: id fields that merely contain "key" pass through.
    expect(out.defaultKeyValueStoreId).toBe('kvstore-id-123456');
    expect(out.keyName).toBe('not-a-secret-name');
  });

  it('leaves short strings and non-string values untouched', () => {
    const out = walkAndRedact({
      token: 'short', // <= 8 chars: not worth masking
      apiKey: true,
      secret: 12345,
    }) as Record<string, unknown>;
    expect(out.token).toBe('short');
    expect(out.apiKey).toBe(true);
    expect(out.secret).toBe(12345);
  });

  it('recurses through arrays and nested objects', () => {
    const out = walkAndRedact({
      items: [{ auth: 'bearer-abcdef-xyz9' }, 'plain'],
      nested: { deep: { signature: 'sig-abcdef-0042' } },
    }) as { items: [Record<string, unknown>, string]; nested: { deep: Record<string, unknown> } };
    expect(out.items[0].auth).toBe('••• xyz9');
    expect(out.items[1]).toBe('plain');
    expect(out.nested.deep.signature).toBe('••• 0042');
  });

  it('passes through primitives and null unchanged', () => {
    expect(walkAndRedact(null)).toBeNull();
    expect(walkAndRedact('a string')).toBe('a string');
    expect(walkAndRedact(42)).toBe(42);
  });
});

describe('redactSecretsForStorage', () => {
  it('redacts within a JSON string and returns JSON', () => {
    const input = JSON.stringify({ token: 'tok-abcdefgh-9999', ok: 1 });
    const out = JSON.parse(redactSecretsForStorage(input)) as Record<string, unknown>;
    expect(out.token).toBe('••• 9999');
    expect(out.ok).toBe(1);
  });

  it('caps non-JSON input at the storage limit instead of throwing', () => {
    const raw = 'x'.repeat(10_000);
    const out = redactSecretsForStorage(raw);
    expect(out).toHaveLength(4096);
    expect(out).toBe(raw.slice(0, 4096));
  });

  it('caps redacted JSON output at the storage limit', () => {
    const input = JSON.stringify({ note: 'y'.repeat(10_000) });
    expect(redactSecretsForStorage(input).length).toBeLessThanOrEqual(4096);
  });
});
