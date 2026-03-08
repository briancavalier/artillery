import { randomUUID } from "node:crypto";
import type { CloudEventEnvelope } from "@darkfactory/contracts";

interface EmitOptions {
  baseUrl?: string;
  action: string;
  actor: string;
  specId: string;
  scenarioId: string;
  deployId: string;
  metadata?: Record<string, unknown>;
}

export async function emitControllerEvent(options: EmitOptions): Promise<void> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    return;
  }

  const envelope: CloudEventEnvelope<Record<string, unknown>> = {
    specversion: "1.0",
    id: randomUUID(),
    source: "darkfactory.spec_controller",
    type: "pipeline_event",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action: options.action,
      actor: options.actor,
      specId: options.specId,
      scenarioId: options.scenarioId || "SCN-UNKNOWN",
      deployId: options.deployId,
      matchId: "match-unbound",
      metadata: options.metadata ?? {}
    }
  };

  try {
    await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[spec-controller] failed to emit event: ${message}`);
  }
}

function normalizeBaseUrl(value?: string): string {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
