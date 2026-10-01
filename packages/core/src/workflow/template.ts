/**
 * Minimal `{{path.to.value}}` templating for prompt files. Missing values render as
 * an empty string; `{{#if path}}…{{/if}}` includes a block only when the value is non-empty.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const withBlocks = template.replace(
    /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, body: string) => (isPresent(lookup(context, key)) ? body : ""),
  );
  return withBlocks
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
      const value = lookup(context, key);
      return value == null ? "" : String(value);
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lookup(context: Record<string, unknown>, key: string): unknown {
  let value: unknown = context;
  for (const part of key.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function isPresent(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
