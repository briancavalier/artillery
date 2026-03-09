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

export interface OpenAiTextResponse {
  payload: Record<string, unknown>;
  diagnostics: OpenAiRequestDiagnostics;
}

export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly diagnostics: OpenAiRequestDiagnostics
  ) {
    super(message);
    this.name = "OpenAiRequestError";
  }
}

export async function requestOpenAiText(apiKey: string, body: Record<string, unknown>): Promise<OpenAiTextResponse> {
  const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 45_000);
  const maxAttempts = Number(process.env.OPENAI_REQUEST_MAX_ATTEMPTS ?? 3);
  const backoffMs = Number(process.env.OPENAI_REQUEST_BACKOFF_MS ?? 1_000);
  const diagnostics: OpenAiRequestDiagnostics = { attempts: [] };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(process.env.OPENAI_PROJECT ? { "OpenAI-Project": process.env.OPENAI_PROJECT } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (response.ok) {
        const payload = await response.json() as Record<string, unknown>;
        diagnostics.finalStatusCode = response.status;
        return { payload, diagnostics };
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
          diagnostics
        );
      }
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof OpenAiRequestError) {
        throw error;
      }

      const timeout = error instanceof Error && error.name === "AbortError";
      const failureClass: OpenAiFailureClass = timeout ? "timeout" : "transport_failure";
      diagnostics.attempts.push({
        attempt,
        failureClass,
        timedOut: timeout,
        responseBodyPreview: error instanceof Error ? truncate(error.message, 1000) : truncate(String(error), 1000)
      });
      if (!shouldRetry(failureClass, attempt, maxAttempts)) {
        diagnostics.finalFailureClass = failureClass;
        diagnostics.timedOut = timeout;
        throw new OpenAiRequestError(
          timeout ? `OpenAI Responses API timed out after ${timeoutMs}ms` : `OpenAI request failed: ${String(error)}`,
          diagnostics
        );
      }
    }

    const jitter = Math.floor(Math.random() * 250);
    await sleep(backoffMs * 2 ** (attempt - 1) + jitter);
  }

  diagnostics.finalFailureClass = "transport_failure";
  throw new OpenAiRequestError("OpenAI Responses API request exhausted retries", diagnostics);
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
