import type { PullRequestComment } from "./types.js";

const REASON_REGEX = /^\/factory-reason\s+(SPEC-[A-Za-z0-9-]+)\s*:\s*(.+)$/m;

export function parseReasonDirective(body: string): { specId: string; reason: string } | null {
  const match = body.match(REASON_REGEX);
  if (!match) {
    return null;
  }

  const specId = match[1]?.trim();
  const reason = match[2]?.trim();
  if (!specId || !reason) {
    return null;
  }

  return { specId, reason };
}

export function findLatestReasonForSpec(
  comments: PullRequestComment[],
  specId: string,
  actor?: string
): string | null {
  const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const comment = ordered[index];
    if (actor && comment.userLogin !== actor) {
      continue;
    }

    const parsed = parseReasonDirective(comment.body);
    if (parsed && parsed.specId === specId) {
      return parsed.reason;
    }
  }

  return null;
}
