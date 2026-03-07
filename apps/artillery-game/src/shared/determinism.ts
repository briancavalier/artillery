import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortValue(nested)]);

    return Object.fromEntries(entries);
  }

  return value;
}

export function hashState(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
