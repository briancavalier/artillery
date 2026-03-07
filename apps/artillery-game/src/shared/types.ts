export type MatchStatus = "waiting" | "active" | "ended";

export type CommandType = "aim" | "power" | "fire" | "ready";

export interface AimCommand {
  type: "aim";
  angle: number;
}

export interface PowerCommand {
  type: "power";
  power: number;
}

export interface FireCommand {
  type: "fire";
}

export interface ReadyCommand {
  type: "ready";
}

export type ClientCommand = AimCommand | PowerCommand | FireCommand | ReadyCommand;

export interface CommandEnvelope {
  commandId: string;
  playerId: string;
  issuedAt: string;
  body: ClientCommand;
}

export interface PlayerState {
  id: string;
  name: string;
  x: number;
  health: number;
  angle: number;
  power: number;
  ready: boolean;
}

export interface MatchState {
  matchId: string;
  seed: number;
  rngState: number;
  createdAt: string;
  updatedAt: string;
  status: MatchStatus;
  turnIndex: number;
  wind: number;
  terrain: number[];
  players: PlayerState[];
  commandLog: CommandEnvelope[];
  processedCommandIds: string[];
  winnerId?: string;
}

export type ServerEventType =
  | "MatchCreated"
  | "PlayerJoined"
  | "TurnStarted"
  | "CommandAccepted"
  | "CommandRejected"
  | "ProjectileResolved"
  | "StateSync"
  | "MatchEnded"
  | "PlayerDisconnected"
  | "FeedbackReceived"
  | "IncidentRaised";

export interface ServerEvent {
  eventId: number;
  matchId: string;
  at: string;
  type: ServerEventType;
  payload: Record<string, unknown>;
}

export type LedgerEventType =
  | "game_event"
  | "pipeline_event"
  | "agent_event"
  | "user_feedback"
  | "incident";

export interface LedgerEvent {
  id: string;
  at: string;
  type: LedgerEventType;
  action: string;
  actor: string;
  specId?: string;
  scenarioId?: string;
  matchId?: string;
  metadata: Record<string, unknown>;
}

export type SpecSource = "human" | "agent";
export type SpecStatus =
  | "Draft"
  | "Critiqued"
  | "Refined"
  | "Approved"
  | "Implemented"
  | "Verified"
  | "Deployed";

export type SpecDecision = "pending" | "accept" | "veto" | "rollback";

export interface ScenarioSpec {
  id: string;
  description: string;
  required: boolean;
}

export interface VerificationRule {
  scenarioId: string;
  checks: string[];
}

export interface FeatureSpec {
  specId: string;
  title: string;
  source: SpecSource;
  owner: string;
  status: SpecStatus;
  decision: SpecDecision;
  intent: string;
  scenarios: ScenarioSpec[];
  verification: VerificationRule[];
  riskNotes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CriticResult {
  specId: string;
  passed: boolean;
  issues: string[];
}

export interface EvaluationResult {
  specId: string;
  score: number;
  blockers: string[];
}

export interface VerificationEvidence {
  scenarioId: string;
  passed: boolean;
  artifact: string;
  at: string;
}
