import type { SpecStatus } from "@darkfactory/contracts";

export interface ArchitectureQueueItem {
  specId: string;
  taskId: string;
  branchName: string;
  status: string;
  created: boolean;
}

export interface ArchitectureAdvanceItem {
  specId: string;
  previousStatus: SpecStatus;
  finalStatus: SpecStatus;
  taskStatus: string;
  runId?: string;
  runStatus?: string;
  runResult?: string;
  provider?: string;
  model?: string;
  traceId?: string;
  blockedReason?: string;
  failureReason?: string;
  runSummary?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}

export interface ArchitectureManifest {
  version: "v1";
  generatedAt: string;
  repository?: string;
  branch?: string;
  commitSha?: string;
  queued: ArchitectureQueueItem[];
  advanced: ArchitectureAdvanceItem[];
}
