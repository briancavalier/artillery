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
  nodeId: string;
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
  node_id: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface PullRequestNodeQuery {
  repository: {
    pullRequest: {
      id: string;
      isDraft: boolean;
    } | null;
  } | null;
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

  async dispatchWorkflow(owner: string, repo: string, workflowId: string, ref: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, { ref });
  }

  async markReadyForReview(owner: string, repo: string, pullNumber: number): Promise<void> {
    try {
      await this.request("POST", `/repos/${owner}/${repo}/pulls/${pullNumber}/ready_for_review`);
      return;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        return;
      }
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
    }

    const pull = await this.requestGraphQl<PullRequestNodeQuery>(
      [
        "query PullRequestNode($owner: String!, $repo: String!, $number: Int!) {",
        "  repository(owner: $owner, name: $repo) {",
        "    pullRequest(number: $number) {",
        "      id",
        "      isDraft",
        "    }",
        "  }",
        "}"
      ].join("\n"),
      { owner, repo, number: pullNumber }
    );
    const node = pull.repository?.pullRequest;
    if (!node || !node.isDraft) {
      return;
    }

    await this.requestGraphQl(
      [
        "mutation MarkReady($pullRequestId: ID!) {",
        "  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {",
        "    pullRequest {",
        "      number",
        "      isDraft",
        "    }",
        "  }",
        "}"
      ].join("\n"),
      { pullRequestId: node.id }
    );
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
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "darkfactory-codex-provider"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (allowStatus.includes(response.status)) {
      return null as T;
    }

    if (!response.ok) {
      throw new GitHubApiError(method, path, response.status, (await response.text()).trim());
    }

    if (response.status === 204) {
      return {} as T;
    }

    return await response.json() as T;
  }

  private async requestGraphQl<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "darkfactory-codex-provider"
      },
      body: JSON.stringify({ query, variables })
    });

    const payload = await response.json() as GraphQlResponse<T>;
    if (!response.ok) {
      throw new GitHubApiError("POST", "/graphql", response.status, JSON.stringify(payload.errors ?? payload));
    }
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${payload.errors.map((error) => error.message ?? "Unknown error").join("; ")}`);
    }
    return payload.data as T;
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseText: string
  ) {
    super(`GitHub API ${method} ${path} failed: ${status} ${responseText}`);
    this.name = "GitHubApiError";
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
    nodeId: pull.node_id,
    state: pull.state,
    draft: pull.draft,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state
  };
}
