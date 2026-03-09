import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiRequestError, requestOpenAiText } from "../packages/implementation-provider-codex/src/openai.js";

test("requestOpenAiText retries 429 and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({ id: "resp-1", usage: { input_tokens: 1, output_tokens: 2 }, output_text: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  process.env.OPENAI_REQUEST_MAX_ATTEMPTS = "2";
  process.env.OPENAI_REQUEST_BACKOFF_MS = "1";

  try {
    const result = await requestOpenAiText("token", { model: "gpt-5-codex", input: [] });
    assert.equal(calls, 2);
    assert.equal(result.payload.id, "resp-1");
    assert.equal(result.diagnostics.attempts[0]?.failureClass, "rate_limited");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_REQUEST_MAX_ATTEMPTS;
    delete process.env.OPENAI_REQUEST_BACKOFF_MS;
  }
});

test("requestOpenAiText classifies 400 as client error without retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  process.env.OPENAI_REQUEST_MAX_ATTEMPTS = "3";

  try {
    await assert.rejects(
      requestOpenAiText("token", { model: "gpt-5-codex", input: [] }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAiRequestError);
        assert.equal(error.diagnostics.finalFailureClass, "client_error");
        return true;
      }
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_REQUEST_MAX_ATTEMPTS;
  }
});
