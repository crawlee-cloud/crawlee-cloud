/**
 * Webhook payload template engine — Apify-compatible.
 *
 * Apify's template syntax has a documented behavior we now match:
 *
 *   • `"{{key}}"` (entire string cell is the variable) → typed value
 *     spliced in via JSON.stringify. For object/array/number/boolean/
 *     null values the surrounding quotes drop, so the placeholder
 *     becomes a JSON value of the matching type. For string values
 *     the quotes stay.
 *   • `"text {{key}} more"` (interpolated mid-string) → String coercion.
 *     Numbers/strings interpolate naturally; objects render as
 *     `[object Object]` (operator should fix their template).
 *   • `{{key.path.to.field}}` — dot notation, drills into nested
 *     properties. Returns `undefined` (→ JSON null in Pass 1, empty
 *     string in Pass 2) if any path segment is missing.
 *
 * Two-pass implementation: a JSON-aware engine would be more correct
 * but ~10× larger. The two-pass regex covers the cases Apify's docs
 * actually call out, and we lock the behavior with a contract test.
 *
 * KEEP IN SYNC with packages/runner/src/webhook-template.ts —
 * the runner ships production deliveries through the same engine, so
 * "test webhook" in the dashboard exercises identical bytes to what
 * receivers see in production.
 */

/**
 * Resolve a dot-separated key path against the lookup root. Each segment
 * walks one property; non-objects, missing keys, and prototype-only
 * lookups all return `undefined`.
 */
function resolveDotted(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && Object.prototype.hasOwnProperty.call(acc, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

/**
 * Apply a user-supplied payload_template to the default Apify-shape
 * payload. Returns the parsed substituted JSON. If the template is
 * `null` or empty, returns `defaultPayload` unchanged. If substitution
 * produces invalid JSON, returns `defaultPayload` and (caller-visible)
 * the receiver gets the safe default rather than a broken body.
 */
export function applyWebhookTemplate(
  template: string | null | undefined,
  defaultPayload: Record<string, unknown>
): unknown {
  if (!template) return defaultPayload;

  // Pass 1: replace any `"{{key}}"` whose ENTIRE string-cell content is
  // a single variable. JSON.stringify both the key resolution and the
  // surrounding quotes so the result is valid JSON regardless of value
  // type — strings keep their quotes, objects/arrays/bools/null drop them.
  const afterPass1 = template.replace(
    /"\{\{\s*([^}]+?)\s*\}\}"/g,
    (_match: string, key: string): string => {
      const v = resolveDotted(defaultPayload, key);
      return v === undefined ? 'null' : JSON.stringify(v);
    }
  );

  // Pass 2: any remaining `{{key}}` is mid-string interpolation. String-
  // coerce so `"hello {{userId}}"` works without breaking the JSON.
  const afterPass2 = afterPass1.replace(
    /\{\{\s*([^}]+?)\s*\}\}/g,
    (_match: string, key: string): string => {
      const v = resolveDotted(defaultPayload, key);
      if (v === undefined || v === null) return '';
      return String(v);
    }
  );

  try {
    return JSON.parse(afterPass2);
  } catch {
    return defaultPayload;
  }
}
