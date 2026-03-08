import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpecControllerManifest } from "./types.js";

export const STICKY_COMMENT_MARKER = "<!-- darkfactory:spec-controller -->";

export function renderStickySummary(manifest: SpecControllerManifest): string {
  const lines: string[] = [];
  lines.push(STICKY_COMMENT_MARKER);
  lines.push("## Spec Controller");
  lines.push("");
  lines.push(`- PR: #${manifest.prNumber}`);
  lines.push(`- Mode: \`${manifest.mode}\``);
  lines.push(`- Head SHA: \`${manifest.headSha.slice(0, 12)}\``);
  lines.push(`- Same repo: \`${manifest.sameRepo}\``);
  lines.push("");

  if (manifest.analyses.length === 0) {
    lines.push("No changed spec files were detected.");
  } else {
    lines.push("| SpecID | Status | Score | Readiness | Blockers |");
    lines.push("| --- | --- | ---: | --- | ---: |");
    for (const analysis of manifest.analyses) {
      lines.push(
        `| ${analysis.specId} | ${analysis.currentStatus} -> ${analysis.nextStatus} | ${analysis.score} | ${analysis.readiness} | ${analysis.blockers.length} |`
      );
    }
  }

  lines.push("");
  lines.push(`Action result: \`${manifest.action.result}\` - ${manifest.action.message}`);
  if (manifest.action.reason) {
    lines.push(`Reason: ${manifest.action.reason}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function writeControllerReport(manifest: SpecControllerManifest, rootDir = process.cwd()):
Promise<{ manifestPath: string; summaryPath: string }> {
  const baseDir = join(rootDir, "reports", "spec-controller", `pr-${manifest.prNumber}`);
  const manifestPath = join(baseDir, "manifest.json");
  const summaryPath = join(baseDir, "summary.md");
  const summary = renderStickySummary(manifest);

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, summary, "utf8");
  return { manifestPath, summaryPath };
}
