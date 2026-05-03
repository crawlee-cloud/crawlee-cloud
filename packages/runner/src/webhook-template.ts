/**
 * Webhook payload template engine — Apify-compatible.
 *
 * KEEP IN SYNC with packages/api/src/webhooks/apply-template.ts.
 * The api package's "test webhook" endpoint and this runner's
 * production delivery path call into byte-identical logic so an
 * operator who confirms a custom payload_template works in the
 * dashboard's test path can rely on production sending the same
 * thing. Behaviour is locked by mirrored unit tests in both packages.
 *
 * Behaviour summary (full doc: see the api copy):
 *   • `"{{key}}"` (quoted, entire string-cell)   → typed value
 *   • `{{key}}`   (unquoted, JSON value position) → typed value
 *   • `"text {{key}} more"` (interpolated)        → String coercion
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

function stitchTemplate(template: string, tag: string, placeholders: string[]): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (inString && ch === '\\') {
      out += template.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (ch === '{' && template[i + 1] === '{') {
      const end = template.indexOf('}}', i + 2);
      if (end !== -1) {
        const key = template.slice(i + 2, end).trim();
        const idx = placeholders.length;
        placeholders.push(key);
        out += inString ? `${tag}${idx}__` : JSON.stringify(`${tag}${idx}__`);
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function applyWebhookTemplate(
  template: string | null | undefined,
  defaultPayload: Record<string, unknown>
): unknown {
  if (!template) return defaultPayload;

  const tag = `__CW_PH_${Math.random().toString(36).slice(2, 10)}_`;
  const placeholders: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stitchTemplate(template, tag, placeholders));
  } catch {
    return defaultPayload;
  }

  const fullPattern = new RegExp(`^${escapeRegex(tag)}(\\d+)__$`);
  const interpolatePattern = new RegExp(`${escapeRegex(tag)}(\\d+)__`, 'g');

  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      const fullMatch = node.match(fullPattern);
      if (fullMatch) {
        const v = resolveDotted(defaultPayload, placeholders[parseInt(fullMatch[1]!, 10)]!);
        return v === undefined ? null : v;
      }
      return node.replace(interpolatePattern, (_, idxStr: string) => {
        const v = resolveDotted(defaultPayload, placeholders[parseInt(idxStr, 10)]!);
        return v === undefined || v === null ? '' : String(v);
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(node as Record<string, unknown>)) {
        out[k] = walk((node as Record<string, unknown>)[k]);
      }
      return out;
    }
    return node;
  }

  return walk(parsed);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
