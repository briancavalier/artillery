export interface GitHubCheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubPullRequestDetails {
  number: number;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
}

interface BranchRefResponse {
  object: { sha: string };
}

interface PullRequestResponse {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
}

export class GitHubAutomationApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com"
  ) {}

  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const response = await this.request<BranchRefResponse>("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`);
    return response.object.sha;
  }

  async createOrResetBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    const existing = await this.request<{ ref: string } | null>("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`, undefined, [404]);
    if (existing) {
      await this.request("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${encodeRef(branch)}`, { sha, force: true });
      return;
    }
    await this.request("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  async findPullRequestByHead(owner: string, repo: string, head: string): Promise<GitHubPullRequestDetails | null> {
    const response = await this.request<PullRequestResponse[]>("GET", `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=1`);
    const pull = response[0];
    return pull ? toPullRequestDetails(pull) : null;
  }

  async createPullRequest(params: { owner: string; repo: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<GitHubPullRequestDetails> {
    const response = await this.request<PullRequestResponse>("POST", `/repos/${params.owner}/${params.repo}/pulls`, params);
    return toPullRequestDetails(response);
  }

  async markReadyForReview(owner: string, repo: string, pullNumber: number): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/pulls/${pullNumber}/ready_for_review`);
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestDetails> {
    const response = await this.request<PullRequestResponse>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
    return toPullRequestDetails(response);
  }

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<GitHubCheckRunSummary[]> {
    const response = await this.request<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      "GET",
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`
    );
    return response.check_runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion }));
  }

  async mergePullRequest(owner: string, repo: string, pullNumber: number, commitTitle: string): Promise<void> {
    await this.request("PUT", `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      commit_title: commitTitle,
      merge_method: "squash"
    });
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, allowStatus: number[] = []): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "darkfactory-codex-provider"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (allowStatus.includes(response.status)) {
      return null as T;
    }

    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${(await response.text()).trim()}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return await response.json() as T;
  }
}

function encodeRef(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function toPullRequestDetails(pull: PullRequestResponse): GitHubPullRequestDetails {
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    state: pull.state,
    draft: pull.draft,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state
  };
}
