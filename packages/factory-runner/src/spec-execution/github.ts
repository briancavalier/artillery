import type { ExecutionPullRequest, SpecExecutionGitHubApi } from "./types.js";

interface BranchRefResponse {
  object: { sha: string };
}

interface PullRequestResponse {
  number: number;
  html_url: string;
}

interface ContentResponse {
  sha: string;
}

export class GitHubExecutionApi implements SpecExecutionGitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com"
  ) {}

  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const response = await this.request<BranchRefResponse>("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`);
    return response.object.sha;
  }

  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha
    }, { allowStatus: [422] });
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<{ sha: string } | null> {
    const response = await this.request<ContentResponse | null>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      { allowStatus: [404] }
    );
    if (!response) {
      return null;
    }
    return { sha: response.sha };
  }

  async putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<void> {
    await this.request(
      "PUT",
      `/repos/${params.owner}/${params.repo}/contents/${encodePath(params.path)}`,
      {
        message: params.message,
        content: Buffer.from(params.content, "utf8").toString("base64"),
        branch: params.branch,
        sha: params.sha
      }
    );
  }

  async findPullRequestByHead(owner: string, repo: string, head: string): Promise<ExecutionPullRequest | null> {
    const response = await this.request<PullRequestResponse[] | null>(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=1`,
      undefined,
      { allowStatus: [404] }
    );
    const pull = response?.[0];
    return pull ? { number: pull.number, htmlUrl: pull.html_url } : null;
  }

  async createPullRequest(params: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<ExecutionPullRequest> {
    const response = await this.request<PullRequestResponse>("POST", `/repos/${params.owner}/${params.repo}/pulls`, {
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body,
      draft: params.draft
    });

    return {
      number: response.number,
      htmlUrl: response.html_url
    };
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { allowStatus?: number[] } = {}
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "darkfactory-spec-execution"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (options.allowStatus?.includes(response.status)) {
      if (response.status === 404) {
        return null as T;
      }
      return {} as T;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return await response.json() as T;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
