import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubAutomationApi } from "../packages/implementation-provider-codex/src/github.js";

test("markReadyForReview falls back to GraphQL when REST endpoint returns 404", async () => {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers });

    if (url.endsWith("/pulls/3/ready_for_review")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (url.endsWith("/graphql") && typeof body === "object" && body && "query" in body && String(body.query).includes("query PullRequestNode")) {
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_node_123",
              isDraft: true
            }
          }
        }
      }), { status: 200 });
    }
    if (url.endsWith("/graphql") && typeof body === "object" && body && "query" in body && String(body.query).includes("mutation MarkReady")) {
      return new Response(JSON.stringify({
        data: {
          markPullRequestReadyForReview: {
            pullRequest: {
              number: 3,
              isDraft: false
            }
          }
        }
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const api = new GitHubAutomationApi("token", fetchImpl, "https://api.github.test");
  await api.markReadyForReview("owner", "repo", 3);

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, "https://api.github.test/repos/owner/repo/pulls/3/ready_for_review");
  assert.equal(calls[0]?.headers.get("X-GitHub-Api-Version"), "2022-11-28");
  assert.equal(calls[1]?.url, "https://api.github.test/graphql");
  assert.equal(calls[2]?.url, "https://api.github.test/graphql");
});

test("markReadyForReview tolerates 422 from REST endpoint", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    callCount += 1;
    assert.equal(String(input), "https://api.github.test/repos/owner/repo/pulls/7/ready_for_review");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
  };

  const api = new GitHubAutomationApi("token", fetchImpl, "https://api.github.test");
  await api.markReadyForReview("owner", "repo", 7);
  assert.equal(callCount, 1);
});
