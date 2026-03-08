import type { GitHubApi, SpecFileState } from "./types.js";

export async function applySpecUpdates(
  api: GitHubApi,
  options: {
    owner: string;
    repo: string;
    branch: string;
    specs: SpecFileState[];
    message: string;
  }
): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  for (const entry of options.specs) {
    const response = await api.putFileContent({
      owner: options.owner,
      repo: options.repo,
      path: entry.path,
      branch: options.branch,
      message: options.message,
      content: `${JSON.stringify(entry.spec, null, 2)}\n`,
      sha: entry.sha
    });
    shas.set(entry.path, response.sha);
  }

  return shas;
}
