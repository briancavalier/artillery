import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { addPlayer, applyCommand, createInitialState, publicState } from "../shared/simulation.js";
import type { CommandEnvelope, MatchState, ServerEvent } from "../shared/types.js";
import { appendLedgerEvent } from "./ledger.js";

interface Subscriber {
  id: string;
  response: ServerResponse;
}

interface MatchRoom {
  state: MatchState;
  events: ServerEvent[];
  subscribers: Map<string, Subscriber>;
  nextEventId: number;
}

export class MatchStore {
  #rooms = new Map<string, MatchRoom>();

  async createMatch(ownerName: string, seed?: number): Promise<{ matchId: string; playerId: string; state: ReturnType<typeof publicState> }> {
    const matchId = randomUUID();
    const ownerId = randomUUID();
    const initialSeed = seed ?? createSeed();
    const state = addPlayer(createInitialState(matchId, initialSeed), ownerId, ownerName);

    const room: MatchRoom = {
      state,
      events: [],
      subscribers: new Map(),
      nextEventId: 1
    };

    this.#rooms.set(matchId, room);

    const createdEvent = this.#newEvent(room, "MatchCreated", {
      ownerId,
      seed: initialSeed,
      state: publicState(state)
    });

    room.events.push(createdEvent);

    await appendLedgerEvent({
      type: "game_event",
      action: "match_created",
      actor: "system",
      matchId,
      metadata: { ownerId, seed: initialSeed }
    });

    return { matchId, playerId: ownerId, state: publicState(state) };
  }

  async joinMatch(matchId: string, playerName: string): Promise<{ playerId: string; state: ReturnType<typeof publicState> }> {
    const room = this.#rooms.get(matchId);
    if (!room) {
      throw new Error("Match not found");
    }

    if (room.state.players.length >= 2) {
      throw new Error("Match already full");
    }

    const playerId = randomUUID();
    room.state = addPlayer(room.state, playerId, playerName);

    const joinedEvent = this.#newEvent(room, "PlayerJoined", {
      playerId,
      playerName,
      state: publicState(room.state)
    });

    room.events.push(joinedEvent);
    this.#broadcast(room, joinedEvent);

    if (room.state.status === "active") {
      const turnEvent = this.#newEvent(room, "TurnStarted", {
        turnIndex: room.state.turnIndex,
        playerId: room.state.players[room.state.turnIndex].id
      });
      room.events.push(turnEvent);
      this.#broadcast(room, turnEvent);
    }

    await appendLedgerEvent({
      type: "game_event",
      action: "player_joined",
      actor: "system",
      matchId,
      metadata: { playerId, playerName }
    });

    return { playerId, state: publicState(room.state) };
  }

  getState(matchId: string): ReturnType<typeof publicState> {
    const room = this.#rooms.get(matchId);
    if (!room) {
      throw new Error("Match not found");
    }

    return publicState(room.state);
  }

  async submitCommand(matchId: string, command: CommandEnvelope): Promise<{ state: ReturnType<typeof publicState>; events: ServerEvent[]; rejected?: string }> {
    const room = this.#rooms.get(matchId);
    if (!room) {
      throw new Error("Match not found");
    }

    const startedAt = performance.now();
    const result = applyCommand(room.state, command);
    room.state = result.state;

    const withIds = result.events.map((event) => {
      const resolved = { ...event, eventId: room.nextEventId };
      room.nextEventId += 1;
      room.events.push(resolved);
      this.#broadcast(room, resolved);
      return resolved;
    });

    const latencyMs = Number((performance.now() - startedAt).toFixed(2));

    await appendLedgerEvent({
      type: "game_event",
      action: result.rejected ? "command_rejected" : "command_accepted",
      actor: command.playerId,
      matchId,
      metadata: {
        commandId: command.commandId,
        commandType: command.body.type,
        rejected: result.rejected,
        latencyMs
      }
    });

    if (room.state.status === "ended") {
      await appendLedgerEvent({
        type: "game_event",
        action: "match_ended",
        actor: "system",
        matchId,
        metadata: { winnerId: room.state.winnerId }
      });
    }

    return { state: publicState(room.state), events: withIds, rejected: result.rejected };
  }

  async addFeedback(matchId: string, playerId: string, message: string): Promise<void> {
    await appendLedgerEvent({
      type: "user_feedback",
      action: "feedback_submitted",
      actor: playerId,
      matchId,
      metadata: { message }
    });

    const room = this.#rooms.get(matchId);
    if (!room) {
      return;
    }

    const event = this.#newEvent(room, "FeedbackReceived", {
      playerId,
      message
    });
    room.events.push(event);
    this.#broadcast(room, event);
  }

  subscribe(matchId: string, response: ServerResponse, lastEventId?: number): { subscriberId: string; close: () => Promise<void> } {
    const room = this.#rooms.get(matchId);
    if (!room) {
      throw new Error("Match not found");
    }

    const subscriberId = randomUUID();

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    response.write(`: connected ${new Date().toISOString()}\n\n`);

    const pendingEvents = typeof lastEventId === "number"
      ? room.events.filter((event) => event.eventId > lastEventId)
      : room.events;

    pendingEvents.forEach((event) => {
      response.write(toSseFrame(event));
    });

    room.subscribers.set(subscriberId, { id: subscriberId, response });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;

      room.subscribers.delete(subscriberId);
      if (!response.writableEnded) {
        response.end();
      }

      await appendLedgerEvent({
        type: "game_event",
        action: "player_disconnected",
        actor: subscriberId,
        matchId,
        metadata: { subscriberId }
      });

      const disconnectEvent = this.#newEvent(room, "PlayerDisconnected", {
        subscriberId
      });
      room.events.push(disconnectEvent);
      this.#broadcast(room, disconnectEvent);
    };

    return { subscriberId, close };
  }

  #broadcast(room: MatchRoom, event: ServerEvent): void {
    const frame = toSseFrame(event);
    room.subscribers.forEach((subscriber) => {
      subscriber.response.write(frame);
    });
  }

  #newEvent(room: MatchRoom, type: ServerEvent["type"], payload: Record<string, unknown>): ServerEvent {
    const event = {
      eventId: room.nextEventId,
      matchId: room.state.matchId,
      at: new Date().toISOString(),
      type,
      payload
    } satisfies ServerEvent;
    room.nextEventId += 1;
    return event;
  }
}

function createSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

function toSseFrame(event: ServerEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
