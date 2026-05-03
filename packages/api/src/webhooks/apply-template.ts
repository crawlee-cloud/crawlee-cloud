/**
 * Webhook payload template engine — Apify-compatible.
 *
 * Apify's template syntax has two ways to reference a variable, both of
 * which produce the typed value spliced in:
 *
 *   • `"{{key}}"` (quoted, entire string-cell is the variable)
 *   • `{{key}}`   (unquoted, sits as a JSON value)
 *
 * Apify's documented default template uses the unquoted form
 * (`"eventData": {{eventData}}`); operators authoring custom templates
 * with their JSON editor's auto-quote behaviour will produce the
 * quoted form (`"eventData": "{{eventData}}"`). Both must work.
 *
 * Mid-string interpolation (`"text {{userId}} more"`) string-coerces
 * the value, regardless of type.
 *
 * Implementation: a small character-by-character scan stitches each
 * `{{...}}` into a placeholder sentinel — bare sentinel when we're
 * inside a JSON string (so the surrounding `"..."` keeps its shape),
 * a JSON-encoded sentinel string when we're in JSON value position.
 * Then JSON.parse the result and walk the tree: strings whose entire
 * content is a sentinel are replaced with the typed value, strings
 * with embedded sentinels get each sentinel string-coerced. JSON.parse
 * decides what's a value and what's an interpolated string for us.
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
 * Walk the raw template, emitting the same characters except every
 * `{{...}}` is replaced with a sentinel. Records the captured keys in
 * `placeholders` (parallel array — sentinel index maps to keys index).
 *
 * Inside a JSON string, the sentinel is bare so the surrounding string
 * stays one JSON string. Outside any string (value position), the
 * sentinel is JSON-encoded so the placeholder sits as a JSON string
 * value — making both quoted (`"{{x}}"`) and unquoted (`{{x}}`) forms
 * legal JSON post-stitch.
 */
function stitchTemplate(template: string, tag: string, placeholders: string[]): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (inString && ch === '\\') {
      // Pass through escape + next char untouched.
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

/**
 * Apply a user-supplied payload_template to the default Apify-shape
 * payload. Returns the parsed substituted JSON. If the template is
 * `null`/empty, returns `defaultPayload` unchanged. If the template is
 * unparseable JSON even after sentinel substitution, returns
 * `defaultPayload` so receivers get the safe default rather than a
 * broken body.
 */
export function applyWebhookTemplate(
  template: string | null | undefined,
  defaultPayload: Record<string, unknown>
): unknown {
  if (!template) return defaultPayload;

  // Per-call random tag avoids any collision with a literal string a
  // user might happen to have in their data.
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
        // Lone-variable cell — return the typed value (or null if the
        // key resolved to undefined, since `undefined` isn't valid JSON
        // and the receiver should see an explicit "missing" signal).
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

/** Escape regex metacharacters so a runtime-built tag turns into a literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
