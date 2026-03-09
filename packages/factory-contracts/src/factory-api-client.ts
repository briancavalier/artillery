import type {
  AgentQualityStatus,
  ArchitectureRunResponse,
  ArchitectureTask,
  ArchitectureTaskListResponse,
  ArchitectureTaskRequest,
  CloudEventEnvelope,
  FactoryAdminStatus,
  FactoryEventsQuery,
  FactoryEventsResponse,
  ImplementationRunResponse,
  ImplementationTask,
  ImplementationTaskListResponse,
  ImplementationTaskRequest,
  ProjectCanaryResponse,
  ProjectHealthResponse,
  ScenarioVerificationResponse
} from "./index.js";

export interface FactoryApiClientOptions {
  baseUrl?: string;
  requireBaseUrl?: boolean;
}

export interface IngestEventOptions {
  failOpen?: boolean;
}

export class FactoryApiClientError extends Error {}

export function isFactoryEventLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FACTORY_EVENT_MODE === "local";
}

export function resolveFactoryApiBaseUrl(value = process.env.FACTORY_API_BASE_URL): string {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function requireFactoryApiBaseUrl(value = process.env.FACTORY_API_BASE_URL): string {
  const baseUrl = resolveFactoryApiBaseUrl(value);
  if (!baseUrl) {
    throw new FactoryApiClientError("FACTORY_API_BASE_URL is required unless FACTORY_EVENT_MODE=local");
  }
  return baseUrl;
}

export function createFactoryApiClient(options: FactoryApiClientOptions = {}) {
  const requireBaseUrl = options.requireBaseUrl ?? !isFactoryEventLocalMode();
  const baseUrl = options.baseUrl
    ? resolveFactoryApiBaseUrl(options.baseUrl)
    : requireBaseUrl
      ? requireFactoryApiBaseUrl()
      : resolveFactoryApiBaseUrl();

  return {
    baseUrl,

    async ingestEvent(event: CloudEventEnvelope<Record<string, unknown>>, ingestOptions: IngestEventOptions = {}): Promise<boolean> {
      if (!baseUrl) {
        if (ingestOptions.failOpen) {
          return false;
        }
        throw new FactoryApiClientError("Cannot ingest event without FACTORY_API_BASE_URL");
      }

      try {
        await request<void>(baseUrl, "/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event)
        });
        return true;
      } catch (error) {
        if (ingestOptions.failOpen) {
          return false;
        }
        throw error;
      }
    },

    async listEvents(query: FactoryEventsQuery = {}): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") {
          continue;
        }
        params.set(key, String(value));
      }

      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const response = await request<FactoryEventsResponse>(baseUrl, `/v1/admin/events${suffix}`);
      return response.events;
    },

    getFactoryStatus(): Promise<FactoryAdminStatus> {
      return request<FactoryAdminStatus>(baseUrl, "/v1/admin/factory");
    },

    getAgentStatus(): Promise<AgentQualityStatus> {
      return request<AgentQualityStatus>(baseUrl, "/v1/admin/agents");
    },

    getDeployments(limit = 20): Promise<{ deployments: Array<Record<string, unknown>> }> {
      return request<{ deployments: Array<Record<string, unknown>> }>(baseUrl, `/v1/admin/deployments?limit=${limit}`);
    },

    getProjectHealth(): Promise<ProjectHealthResponse> {
      return request<ProjectHealthResponse>(baseUrl, "/v1/admin/project-health");
    },

    getProjectCanary(): Promise<ProjectCanaryResponse> {
      return request<ProjectCanaryResponse>(baseUrl, "/v1/admin/project/canary", { method: "POST" });
    },

    verifyScenario(scenarioId: string): Promise<ScenarioVerificationResponse> {
      return request<ScenarioVerificationResponse>(baseUrl, `/v1/admin/project/scenarios/${encodeURIComponent(scenarioId)}/verify`, {
        method: "POST"
      });
    },

    enqueueArchitectureTask(payload: ArchitectureTaskRequest): Promise<ArchitectureTask> {
      return request<ArchitectureTask>(baseUrl, "/v1/admin/architecture/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    },

    listArchitectureTasks(): Promise<ArchitectureTaskListResponse> {
      return request<ArchitectureTaskListResponse>(baseUrl, "/v1/admin/architecture/tasks");
    },

    getArchitectureTask(taskId: string): Promise<ArchitectureTask> {
      return request<ArchitectureTask>(baseUrl, `/v1/admin/architecture/tasks/${encodeURIComponent(taskId)}`);
    },

    cancelArchitectureTask(taskId: string): Promise<ArchitectureTask> {
      return request<ArchitectureTask>(baseUrl, `/v1/admin/architecture/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    },

    retryArchitectureTask(taskId: string): Promise<ArchitectureTask> {
      return request<ArchitectureTask>(baseUrl, `/v1/admin/architecture/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
    },

    getArchitectureRun(runId: string): Promise<ArchitectureRunResponse> {
      return request<ArchitectureRunResponse>(baseUrl, `/v1/admin/architecture/runs/${encodeURIComponent(runId)}`);
    },

    enqueueImplementationTask(payload: ImplementationTaskRequest): Promise<ImplementationTask> {
      return request<ImplementationTask>(baseUrl, "/v1/admin/implementation/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    },

    listImplementationTasks(): Promise<ImplementationTaskListResponse> {
      return request<ImplementationTaskListResponse>(baseUrl, "/v1/admin/implementation/tasks");
    },

    getImplementationTask(taskId: string): Promise<ImplementationTask> {
      return request<ImplementationTask>(baseUrl, `/v1/admin/implementation/tasks/${encodeURIComponent(taskId)}`);
    },

    cancelImplementationTask(taskId: string): Promise<ImplementationTask> {
      return request<ImplementationTask>(baseUrl, `/v1/admin/implementation/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    },

    retryImplementationTask(taskId: string): Promise<ImplementationTask> {
      return request<ImplementationTask>(baseUrl, `/v1/admin/implementation/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
    },

    getImplementationRun(runId: string): Promise<ImplementationRunResponse> {
      return request<ImplementationRunResponse>(baseUrl, `/v1/admin/implementation/runs/${encodeURIComponent(runId)}`);
    }
  };
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) {
    throw new FactoryApiClientError("FACTORY_API_BASE_URL is required");
  }

  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new FactoryApiClientError(`factory-api request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  if (response.status === 202 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return await response.json() as T;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
