function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OpenAiFailureClass =
  | "transport_failure"
  | "rate_limited"
  | "upstream_5xx"
  | "client_error"
  | "timeout";

export interface OpenAiRequestAttempt {
  attempt: number;
  statusCode?: number;
  failureClass?: OpenAiFailureClass;
  timedOut?: boolean;
  responseBodyPreview?: string;
}

export interface OpenAiRequestDiagnostics {
  attempts: OpenAiRequestAttempt[];
  finalStatusCode?: number;
  finalFailureClass?: OpenAiFailureClass;
  timedOut?: boolean;
}

export interface OpenAiTextRequestOptions {
  apiKey: string;
  body?: Record<string, unknown>;
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  metadata?: Record<string, unknown>;
}

export interface OpenAiTextResponse {
  payload: Record<string, unknown>;
  diagnostics: OpenAiRequestDiagnostics;
  responseId?: string;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly diagnostics: OpenAiRequestDiagnostics,
    readonly statusCode?: number,
    readonly failureClass?: OpenAiFailureClass,
    readonly timedOut?: boolean
  ) {
    super(message);
    this.name = "OpenAiRequestError";
  }
}

export async function requestOpenAiText(
  apiKeyOrOptions: string | OpenAiTextRequestOptions,
  body?: Record<string, unknown>
): Promise<OpenAiTextResponse> {
  const options = normalizeOptions(apiKeyOrOptions, body);
  const timeoutMs = options.timeoutMs ?? Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 45_000);
  const maxAttempts = options.maxAttempts ?? Number(process.env.OPENAI_REQUEST_MAX_ATTEMPTS ?? 3);
  const backoffMs = options.backoffMs ?? Number(process.env.OPENAI_REQUEST_BACKOFF_MS ?? 1_000);
  const diagnostics: OpenAiRequestDiagnostics = { attempts: [] };
  const requestBody = options.body ?? buildRequestBody(options);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          ...(process.env.OPENAI_PROJECT ? { "OpenAI-Project": process.env.OPENAI_PROJECT } : {})
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (response.ok) {
        const payload = await response.json() as Record<string, unknown>;
        diagnostics.finalStatusCode = response.status;
        return {
          payload,
          diagnostics,
          responseId: typeof payload.id === "string" ? payload.id : undefined,
          rawText: extractOutputText(payload),
          inputTokens: Number((payload.usage as Record<string, unknown> | undefined)?.input_tokens ?? 0),
          outputTokens: Number((payload.usage as Record<string, unknown> | undefined)?.output_tokens ?? 0),
          estimatedCostUsd: estimateCost(
            Number((payload.usage as Record<string, unknown> | undefined)?.input_tokens ?? 0),
            Number((payload.usage as Record<string, unknown> | undefined)?.output_tokens ?? 0)
          )
        };
      }

      const responseBodyPreview = truncate(await safeReadText(response), 1000);
      const failureClass = classifyStatus(response.status);
      diagnostics.attempts.push({
        attempt,
        statusCode: response.status,
        failureClass,
        responseBodyPreview
      });

      if (!shouldRetry(failureClass, attempt, maxAttempts)) {
        diagnostics.finalStatusCode = response.status;
        diagnostics.finalFailureClass = failureClass;
        throw new OpenAiRequestError(
          `OpenAI Responses API failed: ${response.status}${responseBodyPreview ? ` ${responseBodyPreview}` : ""}`,
          diagnostics,
          response.status,
          failureClass,
          false
        );
      }
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof OpenAiRequestError) {
        throw error;
      }

      const timedOut = error instanceof Error && error.name === "AbortError";
      const failureClass: OpenAiFailureClass = timedOut ? "timeout" : "transport_failure";
      diagnostics.attempts.push({
        attempt,
        failureClass,
        timedOut,
        responseBodyPreview: error instanceof Error ? truncate(error.message, 1000) : truncate(String(error), 1000)
      });
      if (!shouldRetry(failureClass, attempt, maxAttempts)) {
        diagnostics.finalFailureClass = failureClass;
        diagnostics.timedOut = timedOut;
        throw new OpenAiRequestError(
          timedOut ? `OpenAI Responses API timed out after ${timeoutMs}ms` : `OpenAI request failed: ${String(error)}`,
          diagnostics,
          undefined,
          failureClass,
          timedOut
        );
      }
    }

    const jitter = Math.floor(Math.random() * 250);
    await sleep(backoffMs * 2 ** (attempt - 1) + jitter);
  }

  diagnostics.finalFailureClass = "transport_failure";
  throw new OpenAiRequestError("OpenAI Responses API request exhausted retries", diagnostics, undefined, "transport_failure", false);
}

function normalizeOptions(
  apiKeyOrOptions: string | OpenAiTextRequestOptions,
  body?: Record<string, unknown>
): OpenAiTextRequestOptions {
  if (typeof apiKeyOrOptions === "string") {
    return {
      apiKey: apiKeyOrOptions,
      body
    };
  }
  return apiKeyOrOptions;
}

function buildRequestBody(options: OpenAiTextRequestOptions): Record<string, unknown> {
  return {
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5-codex",
    input: [
      ...(options.systemPrompt ? [{
        role: "system",
        content: [{ type: "input_text", text: options.systemPrompt }]
      }] : []),
      {
        role: "user",
        content: [{ type: "input_text", text: options.prompt ?? "" }]
      }
    ],
    text: { format: { type: "text" } },
    metadata: options.metadata ?? {}
  };
}

function shouldRetry(failureClass: OpenAiFailureClass, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) {
    return false;
  }
  return failureClass === "transport_failure"
    || failureClass === "timeout"
    || failureClass === "rate_limited"
    || failureClass === "upstream_5xx";
}

function classifyStatus(status: number): OpenAiFailureClass {
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "upstream_5xx";
  }
  return "client_error";
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function extractOutputText(payload: Record<string, unknown>): string {
  const direct = payload.output_text;
  if (typeof direct === "string") {
    return direct;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return Number((((inputTokens / 1_000_000) * 1.25) + ((outputTokens / 1_000_000) * 10)).toFixed(6));
}
