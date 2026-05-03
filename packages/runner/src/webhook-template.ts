/**
 * Webhook payload template engine — Apify-compatible.
 *
 * KEEP IN SYNC with packages/api/src/webhooks/apply-template.ts.
 * The api package's "test webhook" endpoint and this runner's
 * production delivery path call into byte-identical logic so an
 * operator who confirms a custom payload_template works in the
 * dashboard's test path can rely on production sending the same
 * thing. Behavior is locked by mirrored unit tests in both packages.
 *
 * Behavior summary (full doc: see the api copy):
 *   • `"{{key}}"` (entire string cell) → typed value via JSON.stringify
 *   • `"text {{key}} more"` → String coercion
 *   • `{{key.path.to.field}}` → dot-notation lookup
 *   • Invalid JSON after substitution → fall back to default payload
 */

function resolveDotted(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && Object.prototype.hasOwnProperty.call(acc, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

export function applyWebhookTemplate(
  template: string | null | undefined,
  defaultPayload: Record<string, unknown>
): unknown {
  if (!template) return defaultPayload;

  const afterPass1 = template.replace(
    /"\{\{\s*([^}]+?)\s*\}\}"/g,
    (_match: string, key: string): string => {
      const v = resolveDotted(defaultPayload, key);
      return v === undefined ? 'null' : JSON.stringify(v);
    }
  );

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
