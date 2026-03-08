import type { FeatureSpec } from "@darkfactory/contracts";
import { applyDecisionAction } from "./action-handler.js";
import { analyzeSpec, findChangedSpecPaths } from "./analyze-pr.js";
import { applySpecUpdates } from "./apply-pr-updates.js";
import { emitControllerEvent } from "./event-emitter.js";
import { findLatestReasonForSpec } from "./reason-parser.js";
import { STICKY_COMMENT_MARKER, writeControllerReport, renderStickySummary } from "./report-render.js";
import type {
  ControllerEvent,
  DecisionLabel,
  GitHubApi,
  SpecAnalysis,
  SpecControllerManifest,
  SpecFileState
} from "./types.js";

const SUPPORTED_LABELS = new Set<DecisionLabel>(["factory/accept", "factory/veto", "factory/rollback"]);
const ALLOWED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

interface AnalyzeContext {
  owner: string;
  repo: string;
  prNumber: number;
  sameRepo: boolean;
  headSha: string;
  headRef: string;
  changedSpecPaths: string[];
  analyses: SpecAnalysis[];
  states: Map<string, SpecFileState>;
}

interface ControllerOptions {
  api: GitHubApi;
  owner: string;
  repo: string;
  prNumber: number;
  mode: "analyze" | "act";
  event?: ControllerEvent;
  factoryApiBaseUrl?: string;
  deployId: string;
  now?: string;
  reportRootDir?: string;
}

export async function runSpecController(options: ControllerOptions): Promise<{
  manifest: SpecControllerManifest;
  manifestPath: string;
  summaryPath: string;
}> {
  const now = options.now ?? new Date().toISOString();
  const context = await analyzePullRequest(options.api, options.owner, options.repo, options.prNumber, now);

  const manifest: SpecControllerManifest = {
    version: "v1",
    generatedAt: now,
    mode: options.mode,
    repository: `${options.owner}/${options.repo}`,
    prNumber: options.prNumber,
    headSha: context.headSha,
    sameRepo: context.sameRepo,
    changedSpecPaths: context.changedSpecPaths,
    analyses: context.analyses.map((analysis) => ({
      specId: analysis.specId,
      path: analysis.path,
      currentStatus: analysis.currentStatus,
      nextStatus: analysis.nextStatus,
      changed: analysis.changed,
      readiness: analysis.readiness,
      score: analysis.score,
      blockers: analysis.blockers,
      issues: analysis.issues
    })),
    autoUpdate: {
      attempted: false,
      updatedSpecIds: []
    },
    action: {
      result: "not_requested",
      message: "No decision label requested."
    }
  };

  if (options.mode === "analyze") {
    await emitAnalysisEvents(context.analyses, options);
    await upsertStickyComment(options.api, options.owner, options.repo, options.prNumber, renderStickySummary(manifest));
    const report = await writeControllerReport(manifest, options.reportRootDir);
    return { manifest, manifestPath: report.manifestPath, summaryPath: report.summaryPath };
  }

  if (context.sameRepo) {
    const updates = context.analyses
      .filter((analysis) => analysis.changed)
      .map((analysis) => {
        const current = context.states.get(analysis.path);
        if (!current) {
          return null;
        }
        return {
          path: analysis.path,
          sha: current.sha,
          spec: analysis.updatedSpec
        } satisfies SpecFileState;
      })
      .filter((entry): entry is SpecFileState => entry !== null);

    if (updates.length > 0) {
      manifest.autoUpdate.attempted = true;
      const writtenShas = await applySpecUpdates(options.api, {
        owner: options.owner,
        repo: options.repo,
        branch: context.headRef,
        specs: updates,
        message: `chore(factory): auto-update spec analysis for PR #${options.prNumber}`
      });
      for (const updated of updates) {
        const existing = context.states.get(updated.path);
        if (existing) {
          existing.spec = updated.spec;
          existing.sha = writtenShas.get(updated.path) ?? existing.sha;
        }
      }
      manifest.autoUpdate.updatedSpecIds = updates.map((update) => update.spec.specId);
      for (const updated of updates) {
        await emitControllerEvent({
          baseUrl: options.factoryApiBaseUrl,
          action: "spec_controller_refined_auto",
          actor: "spec_controller",
          specId: updated.spec.specId,
          scenarioId: updated.spec.scenarios[0]?.id ?? "SCN-UNKNOWN",
          deployId: options.deployId,
          metadata: { prNumber: options.prNumber, path: updated.path, status: updated.spec.status }
        });
      }
    } else {
      manifest.autoUpdate.attempted = true;
      manifest.autoUpdate.skippedReason = "No status changes were required.";
    }
  } else {
    manifest.autoUpdate.skippedReason = "Fork PR: read-only mode, no branch mutations.";
  }

  const actionLabel = toDecisionLabel(options.event?.label);
  if (actionLabel) {
    manifest.action.label = actionLabel;
    manifest.action.actor = options.event?.actor;
    const result = await handleDecisionAction(options, context, actionLabel);
    manifest.action.result = result.result;
    manifest.action.message = result.message;
    manifest.action.specId = result.specId;
    manifest.action.reason = result.reason;
    await upsertStickyComment(options.api, options.owner, options.repo, options.prNumber, renderStickySummary(manifest));
  } else {
    await upsertStickyComment(options.api, options.owner, options.repo, options.prNumber, renderStickySummary(manifest));
  }

  const report = await writeControllerReport(manifest, options.reportRootDir);
  return { manifest, manifestPath: report.manifestPath, summaryPath: report.summaryPath };
}

async function analyzePullRequest(
  api: GitHubApi,
  owner: string,
  repo: string,
  prNumber: number,
  now: string
): Promise<AnalyzeContext> {
  const pull = await api.getPullRequest(owner, repo, prNumber);
  const files = await api.listPullRequestFiles(owner, repo, prNumber);
  const changedSpecPaths = findChangedSpecPaths(files);
  const states = new Map<string, SpecFileState>();
  const analyses: SpecAnalysis[] = [];

  const [headOwner, headRepo] = pull.headRepoFullName.split("/");
  for (const path of changedSpecPaths) {
    const content = await api.getFileContent(headOwner, headRepo, path, pull.headSha);
    const spec = JSON.parse(content.content) as FeatureSpec;
    const analysis = analyzeSpec(spec, path, now);
    states.set(path, { path, sha: content.sha, spec });
    analyses.push(analysis);
  }

  return {
    owner,
    repo,
    prNumber,
    sameRepo: pull.baseRepoFullName === pull.headRepoFullName,
    headSha: pull.headSha,
    headRef: pull.headRef,
    changedSpecPaths,
    analyses,
    states
  };
}

async function handleDecisionAction(
  options: ControllerOptions,
  context: AnalyzeContext,
  actionLabel: DecisionLabel
): Promise<{ result: "applied" | "rejected"; message: string; specId?: string; reason?: string }> {
  const actor = options.event?.actor ?? "unknown";

  if (!context.sameRepo) {
    const message = `Rejected ${actionLabel}: fork PRs are read-only for controller actions.`;
    await emitControllerEvent({
      baseUrl: options.factoryApiBaseUrl,
      action: "spec_controller_action_rejected",
      actor,
      specId: "SPEC-UNBOUND",
      scenarioId: "SCN-UNBOUND",
      deployId: options.deployId,
      metadata: { prNumber: options.prNumber, reason: message, label: actionLabel }
    });
    await maybeRemoveActionLabel(options.api, options.owner, options.repo, options.prNumber, actionLabel);
    await options.api.createIssueComment(
      options.owner,
      options.repo,
      options.prNumber,
      `Spec Controller rejected \`${actionLabel}\`: ${message}`
    );
    return { result: "rejected", message };
  }

  const permission = await options.api.getRepositoryPermission(options.owner, options.repo, actor);
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    const message = `Rejected ${actionLabel}: actor ${actor} has permission "${permission}" (requires write|maintain|admin).`;
    await emitControllerEvent({
      baseUrl: options.factoryApiBaseUrl,
      action: "spec_controller_action_rejected",
      actor,
      specId: "SPEC-UNBOUND",
      scenarioId: "SCN-UNBOUND",
      deployId: options.deployId,
      metadata: { prNumber: options.prNumber, reason: message, label: actionLabel }
    });
    await maybeRemoveActionLabel(options.api, options.owner, options.repo, options.prNumber, actionLabel);
    await options.api.createIssueComment(options.owner, options.repo, options.prNumber, `Spec Controller: ${message}`);
    return { result: "rejected", message };
  }

  if (context.changedSpecPaths.length !== 1) {
    const message = `Rejected ${actionLabel}: expected exactly one changed spec in the PR, found ${context.changedSpecPaths.length}.`;
    await emitControllerEvent({
      baseUrl: options.factoryApiBaseUrl,
      action: "spec_controller_action_rejected",
      actor,
      specId: "SPEC-UNBOUND",
      scenarioId: "SCN-UNBOUND",
      deployId: options.deployId,
      metadata: { prNumber: options.prNumber, reason: message, label: actionLabel }
    });
    await maybeRemoveActionLabel(options.api, options.owner, options.repo, options.prNumber, actionLabel);
    await options.api.createIssueComment(options.owner, options.repo, options.prNumber, `Spec Controller: ${message}`);
    return { result: "rejected", message };
  }

  const targetPath = context.changedSpecPaths[0];
  const state = context.states.get(targetPath);
  if (!state) {
    const message = `Rejected ${actionLabel}: unable to load spec for ${targetPath}.`;
    await maybeRemoveActionLabel(options.api, options.owner, options.repo, options.prNumber, actionLabel);
    await options.api.createIssueComment(options.owner, options.repo, options.prNumber, `Spec Controller: ${message}`);
    return { result: "rejected", message };
  }

  const comments = await options.api.listIssueComments(options.owner, options.repo, options.prNumber);
  const reason = actionLabel === "factory/accept"
    ? undefined
    : findLatestReasonForSpec(comments, state.spec.specId, actor) ?? undefined;

  const now = options.now ?? new Date().toISOString();
  const decision = applyDecisionAction(state.spec, actionLabel, now, reason);

  await maybeRemoveActionLabel(options.api, options.owner, options.repo, options.prNumber, actionLabel);

  if (!decision.ok) {
    const message = `Rejected ${actionLabel} for ${state.spec.specId}: ${decision.message}`;
    await emitControllerEvent({
      baseUrl: options.factoryApiBaseUrl,
      action: "spec_controller_action_rejected",
      actor,
      specId: state.spec.specId,
      scenarioId: state.spec.scenarios[0]?.id ?? "SCN-UNKNOWN",
      deployId: options.deployId,
      metadata: { prNumber: options.prNumber, reason: decision.message, label: actionLabel }
    });
    await options.api.createIssueComment(options.owner, options.repo, options.prNumber, `Spec Controller: ${message}`);
    return { result: "rejected", message: decision.message, specId: state.spec.specId };
  }

  const written = await options.api.putFileContent({
    owner: options.owner,
    repo: options.repo,
    path: targetPath,
    branch: context.headRef,
    message: `chore(factory): apply ${actionLabel} for ${state.spec.specId}`,
    content: `${JSON.stringify(decision.updatedSpec, null, 2)}\n`,
    sha: state.sha
  });
  state.sha = written.sha;
  state.spec = decision.updatedSpec;

  const appliedMessage = `Applied ${actionLabel} to ${state.spec.specId} by ${actor} at ${now}.`;
  await options.api.createIssueComment(
    options.owner,
    options.repo,
    options.prNumber,
    `${appliedMessage}${decision.reason ? `\nReason: ${decision.reason}` : ""}`
  );

  await emitControllerEvent({
    baseUrl: options.factoryApiBaseUrl,
    action: "spec_controller_action_applied",
    actor,
    specId: state.spec.specId,
    scenarioId: state.spec.scenarios[0]?.id ?? "SCN-UNKNOWN",
    deployId: options.deployId,
    metadata: {
      prNumber: options.prNumber,
      label: actionLabel,
      reason: decision.reason ?? ""
    }
  });

  return {
    result: "applied",
    message: appliedMessage,
    specId: state.spec.specId,
    reason: decision.reason
  };
}

async function maybeRemoveActionLabel(
  api: GitHubApi,
  owner: string,
  repo: string,
  prNumber: number,
  actionLabel: DecisionLabel
): Promise<void> {
  try {
    await api.removeIssueLabel(owner, repo, prNumber, actionLabel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[spec-controller] unable to remove label ${actionLabel}: ${message}`);
  }
}

function toDecisionLabel(value?: string): DecisionLabel | undefined {
  if (!value || !SUPPORTED_LABELS.has(value as DecisionLabel)) {
    return undefined;
  }
  return value as DecisionLabel;
}

async function emitAnalysisEvents(analyses: SpecAnalysis[], options: ControllerOptions): Promise<void> {
  for (const analysis of analyses) {
    await emitControllerEvent({
      baseUrl: options.factoryApiBaseUrl,
      action: "spec_controller_analyzed",
      actor: "spec_controller",
      specId: analysis.specId,
      scenarioId: analysis.scenarioId,
      deployId: options.deployId,
      metadata: {
        prNumber: options.prNumber,
        path: analysis.path,
        score: analysis.score,
        readiness: analysis.readiness,
        blockers: analysis.blockers
      }
    });
  }
}

async function upsertStickyComment(
  api: GitHubApi,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const comments = await api.listIssueComments(owner, repo, prNumber);
  const existing = comments.find(
    (comment) => comment.userLogin === "github-actions[bot]" && comment.body.includes(STICKY_COMMENT_MARKER)
  );
  if (!existing) {
    await api.createIssueComment(owner, repo, prNumber, body);
    return;
  }

  await api.updateIssueComment(owner, repo, existing.id, body);
}
