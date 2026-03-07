import type { CommandEnvelope, MatchState, PlayerState, ServerEvent } from "./types.js";

export function createInitialState(matchId: string, seed: number, createdAt = new Date().toISOString()): MatchState {
  const terrainData = buildTerrain(seed);
  const windData = nextRng(seed ^ 0x9e3779b9);

  return {
    matchId,
    seed,
    rngState: windData.state,
    createdAt,
    updatedAt: createdAt,
    status: "waiting",
    turnIndex: 0,
    wind: mapWind(windData.value),
    terrain: terrainData.terrain,
    players: [],
    commandLog: [],
    processedCommandIds: []
  };
}

export function addPlayer(state: MatchState, playerId: string, name: string, at = new Date().toISOString()): MatchState {
  if (state.players.some((player) => player.id === playerId)) {
    return state;
  }

  if (state.players.length >= 2) {
    return state;
  }

  const index = state.players.length;
  const x = index === 0 ? 80 : 560;
  const angle = index === 0 ? 45 : 135;

  const nextPlayer: PlayerState = {
    id: playerId,
    name,
    x,
    health: 100,
    angle,
    power: 20,
    ready: false
  };

  const nextPlayers = [...state.players, nextPlayer];
  const nextStatus = nextPlayers.length === 2 ? "active" : "waiting";

  return {
    ...state,
    updatedAt: at,
    status: nextStatus,
    players: nextPlayers
  };
}

export function applyCommand(state: MatchState, command: CommandEnvelope, at = new Date().toISOString()): {
  state: MatchState;
  events: ServerEvent[];
  rejected?: string;
} {
  if (state.processedCommandIds.includes(command.commandId)) {
    return {
      state,
      events: [
        createEvent(state, "CommandAccepted", {
          commandId: command.commandId,
          duplicate: true,
          note: "Command already processed"
        },
        at)
      ]
    };
  }

  if (state.status !== "active") {
    return {
      state,
      rejected: "Match is not active",
      events: [createEvent(state, "CommandRejected", { reason: "Match is not active" }, at)]
    };
  }

  const nextState = cloneState(state);
  const nextEvents: ServerEvent[] = [];
  nextState.updatedAt = at;
  nextState.processedCommandIds.push(command.commandId);
  nextState.commandLog.push(command);

  const playerIndex = nextState.players.findIndex((player) => player.id === command.playerId);
  const player = nextState.players[playerIndex];

  if (!player) {
    return {
      state,
      rejected: "Player not found",
      events: [createEvent(state, "CommandRejected", { reason: "Player not found" }, at)]
    };
  }

  const currentPlayer = state.players[state.turnIndex % state.players.length];
  const requiresTurnOwnership = command.body.type === "aim" || command.body.type === "power" || command.body.type === "fire";
  if (requiresTurnOwnership && (!currentPlayer || currentPlayer.id !== command.playerId)) {
    return {
      state,
      rejected: "Not your turn",
      events: [createEvent(state, "CommandRejected", { reason: "Not your turn" }, at)]
    };
  }

  switch (command.body.type) {
    case "aim": {
      player.angle = clamp(command.body.angle, 1, 179);
      nextEvents.push(createEvent(nextState, "CommandAccepted", { command }, at));
      nextEvents.push(createEvent(nextState, "StateSync", { state: publicState(nextState) }, at));
      return { state: nextState, events: nextEvents };
    }
    case "power": {
      player.power = clamp(command.body.power, 1, 100);
      nextEvents.push(createEvent(nextState, "CommandAccepted", { command }, at));
      nextEvents.push(createEvent(nextState, "StateSync", { state: publicState(nextState) }, at));
      return { state: nextState, events: nextEvents };
    }
    case "ready": {
      player.ready = true;
      nextEvents.push(createEvent(nextState, "CommandAccepted", { command }, at));
      nextEvents.push(createEvent(nextState, "StateSync", { state: publicState(nextState) }, at));
      return { state: nextState, events: nextEvents };
    }
    case "fire": {
      const allPlayersReady = nextState.players.every((entry) => entry.ready || entry.id === player.id);
      if (!allPlayersReady) {
        return {
          state,
          rejected: "All players must be ready before firing",
          events: [
            createEvent(state, "CommandRejected", { reason: "All players must be ready before firing" }, at)
          ]
        };
      }

      const outcome = resolveProjectile(nextState, playerIndex);

      nextState.players.forEach((entry) => {
        entry.ready = false;
      });

      if (outcome.targetHealth <= 0) {
        nextState.status = "ended";
        nextState.winnerId = player.id;
      } else {
        nextState.turnIndex = (nextState.turnIndex + 1) % nextState.players.length;
      }

      const windData = nextRng(nextState.rngState);
      nextState.rngState = windData.state;
      nextState.wind = mapWind(windData.value);

      nextEvents.push(createEvent(nextState, "CommandAccepted", { command }, at));
      nextEvents.push(createEvent(nextState, "ProjectileResolved", outcome, at));
      if (nextState.status === "ended") {
        nextEvents.push(createEvent(nextState, "MatchEnded", { winnerId: nextState.winnerId }, at));
      } else {
        nextEvents.push(
          createEvent(nextState, "TurnStarted", {
            turnIndex: nextState.turnIndex,
            playerId: nextState.players[nextState.turnIndex].id
          }, at)
        );
      }
      nextEvents.push(createEvent(nextState, "StateSync", { state: publicState(nextState) }, at));
      return { state: nextState, events: nextEvents };
    }
  }
}

function resolveProjectile(state: MatchState, shooterIndex: number): {
  shooterId: string;
  targetId: string;
  impactX: number;
  distanceToTarget: number;
  damage: number;
  targetHealth: number;
} {
  const shooter = state.players[shooterIndex];
  const target = state.players[(shooterIndex + 1) % state.players.length];

  const radians = (Math.PI / 180) * shooter.angle;
  const direction = shooterIndex === 0 ? 1 : -1;
  const distance = shooter.power * 4 + Math.cos(radians) * 12 + state.wind * 2;
  const impactX = shooter.x + direction * distance;
  const distanceToTarget = Math.abs(target.x - impactX);
  const damage = Math.max(0, Math.round(60 - distanceToTarget * 0.35));
  target.health = clamp(target.health - damage, 0, 100);

  return {
    shooterId: shooter.id,
    targetId: target.id,
    impactX: Number(impactX.toFixed(2)),
    distanceToTarget: Number(distanceToTarget.toFixed(2)),
    damage,
    targetHealth: target.health
  };
}

function buildTerrain(seed: number): { terrain: number[]; rngState: number } {
  let rngState = seed;
  const terrain: number[] = [];

  for (let i = 0; i < 64; i += 1) {
    const next = nextRng(rngState);
    rngState = next.state;
    terrain.push(90 + Math.floor((next.value % 35) - 17));
  }

  return { terrain, rngState };
}

function mapWind(value: number): number {
  return (value % 21) - 10;
}

function nextRng(state: number): { value: number; state: number } {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const next = x >>> 0;
  return { value: next, state: next };
}

function createEvent(state: MatchState, type: ServerEvent["type"], payload: Record<string, unknown>, at: string): ServerEvent {
  return {
    eventId: state.commandLog.length,
    matchId: state.matchId,
    at,
    type,
    payload
  };
}

export function publicState(state: MatchState): Omit<MatchState, "rngState" | "processedCommandIds"> {
  const { rngState: _rngState, processedCommandIds: _processedCommandIds, ...publicView } = state;
  return publicView;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cloneState(state: MatchState): MatchState {
  return {
    ...state,
    players: state.players.map((player) => ({ ...player })),
    terrain: [...state.terrain],
    commandLog: [...state.commandLog],
    processedCommandIds: [...state.processedCommandIds]
  };
}
