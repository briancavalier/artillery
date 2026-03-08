import type {
  GitHubApi,
  PullRequestComment,
  PullRequestFile,
  PullRequestSummary,
  RepositoryContent
} from "./types.js";

interface GitHubPullApiResponse {
  number: number;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { repo: { full_name: string } };
  labels: Array<{ name: string }>;
}

interface GitHubFileResponse {
  sha: string;
  content: string;
}

interface GitHubPermissionResponse {
  permission: string;
}

interface GitHubCommentResponse {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

export class GitHubRestApi implements GitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com"
  ) {}

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestSummary> {
    const response = await this.request<GitHubPullApiResponse>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
    return {
      number: response.number,
      headRef: response.head.ref,
      headSha: response.head.sha,
      headRepoFullName: response.head.repo.full_name,
      baseRepoFullName: response.base.repo.full_name,
      labels: response.labels.map((label) => label.name)
    };
  }

  async listPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]> {
    const all: PullRequestFile[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const chunk = await this.request<Array<{ filename: string; status: string }>>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`
      );
      all.push(...chunk.map((file) => ({ filename: file.filename, status: file.status })));
      if (chunk.length < 100) {
        break;
      }
    }
    return all;
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<RepositoryContent> {
    const response = await this.request<GitHubFileResponse>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
    );
    return {
      path,
      sha: response.sha,
      content: decodeBase64(response.content)
    };
  }

  async putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha: string;
  }): Promise<{ sha: string }> {
    const response = await this.request<{ content: { sha: string } }>(
      "PUT",
      `/repos/${params.owner}/${params.repo}/contents/${encodePath(params.path)}`,
      {
        message: params.message,
        content: Buffer.from(params.content, "utf8").toString("base64"),
        branch: params.branch,
        sha: params.sha
      }
    );
    return { sha: response.content.sha };
  }

  async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<PullRequestComment[]> {
    const all: PullRequestComment[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const chunk = await this.request<GitHubCommentResponse[]>(
        "GET",
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      );
      all.push(
        ...chunk.map((comment) => ({
          id: comment.id,
          body: comment.body ?? "",
          createdAt: comment.created_at,
          userLogin: comment.user.login
        }))
      );
      if (chunk.length < 100) {
        break;
      }
    }
    return all;
  }

  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  async removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
    await this.request("DELETE", `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
  }

  async getRepositoryPermission(owner: string, repo: string, username: string): Promise<string> {
    const response = await this.request<GitHubPermissionResponse>(
      "GET",
      `/repos/${owner}/${repo}/collaborators/${username}/permission`
    );
    return response.permission;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "darkfactory-spec-controller"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

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

function decodeBase64(value: string): string {
  const sanitized = value.replace(/\n/g, "");
  return Buffer.from(sanitized, "base64").toString("utf8");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
