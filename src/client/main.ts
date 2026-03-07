interface PublicPlayer {
  id: string;
  name: string;
  x: number;
  health: number;
  angle: number;
  power: number;
  ready: boolean;
}

interface PublicState {
  matchId: string;
  status: "waiting" | "active" | "ended";
  turnIndex: number;
  wind: number;
  players: PublicPlayer[];
  terrain: number[];
  winnerId?: string;
}

interface ServerEvent {
  eventId: number;
  matchId: string;
  type: string;
  payload: Record<string, unknown>;
}

const state = {
  matchId: "",
  playerId: "",
  current: null as PublicState | null,
  eventSource: null as EventSource | null,
  lastImpactX: null as number | null,
  messages: [] as string[]
};

const canvas = document.querySelector<HTMLCanvasElement>("#battlefield");
const context = canvas?.getContext("2d");
const ownerInput = mustQuery<HTMLInputElement>("#ownerName");
const joinInput = mustQuery<HTMLInputElement>("#joinName");
const matchInput = mustQuery<HTMLInputElement>("#matchId");
const angleInput = mustQuery<HTMLInputElement>("#angle");
const powerInput = mustQuery<HTMLInputElement>("#power");
const messageInput = mustQuery<HTMLInputElement>("#feedback");
const statusOut = mustQuery<HTMLElement>("#status");
const logOut = mustQuery<HTMLElement>("#eventLog");

mustQuery<HTMLButtonElement>("#createMatch").addEventListener("click", createMatch);
mustQuery<HTMLButtonElement>("#joinMatch").addEventListener("click", joinMatch);
mustQuery<HTMLButtonElement>("#setAim").addEventListener("click", () => sendCommand({ type: "aim", angle: Number(angleInput.value) }));
mustQuery<HTMLButtonElement>("#setPower").addEventListener("click", () => sendCommand({ type: "power", power: Number(powerInput.value) }));
mustQuery<HTMLButtonElement>("#setReady").addEventListener("click", () => sendCommand({ type: "ready" }));
mustQuery<HTMLButtonElement>("#fire").addEventListener("click", () => sendCommand({ type: "fire" }));
mustQuery<HTMLButtonElement>("#sendFeedback").addEventListener("click", sendFeedback);

render();

async function createMatch(): Promise<void> {
  const ownerName = ownerInput.value.trim() || "Player 1";
  const response = await fetchJson<{ matchId: string; playerId: string; state: PublicState }>("/v1/matches", {
    method: "POST",
    body: JSON.stringify({ ownerName })
  });

  state.matchId = response.matchId;
  state.playerId = response.playerId;
  state.current = response.state;
  matchInput.value = response.matchId;
  state.messages.unshift(`Created match ${response.matchId}`);
  connectEvents();
  render();
}

async function joinMatch(): Promise<void> {
  const matchId = matchInput.value.trim();
  if (!matchId) {
    pushMessage("Enter a match id to join");
    return;
  }

  const playerName = joinInput.value.trim() || "Player 2";
  const response = await fetchJson<{ playerId: string; state: PublicState }>(`/v1/matches/${matchId}/join`, {
    method: "POST",
    body: JSON.stringify({ playerName })
  });

  state.matchId = matchId;
  state.playerId = response.playerId;
  state.current = response.state;
  state.messages.unshift(`Joined match ${matchId}`);
  connectEvents();
  render();
}

function connectEvents(): void {
  if (!state.matchId) {
    return;
  }

  state.eventSource?.close();
  const source = new EventSource(`/v1/matches/${state.matchId}/events`);
  source.addEventListener("StateSync", (event) => {
    const parsed = parseEvent(event);
    const payload = parsed?.payload as { state?: PublicState };
    if (payload.state) {
      state.current = payload.state;
      render();
    }
  });

  source.addEventListener("ProjectileResolved", (event) => {
    const parsed = parseEvent(event);
    const impactX = parsed?.payload?.impactX;
    if (typeof impactX === "number") {
      state.lastImpactX = impactX;
    }
    pushMessage(`Projectile resolved: ${JSON.stringify(parsed?.payload ?? {})}`);
    render();
  });

  source.addEventListener("MatchEnded", (event) => {
    const parsed = parseEvent(event);
    pushMessage(`Match ended: ${JSON.stringify(parsed?.payload ?? {})}`);
    render();
  });

  source.addEventListener("CommandRejected", (event) => {
    const parsed = parseEvent(event);
    pushMessage(`Command rejected: ${JSON.stringify(parsed?.payload ?? {})}`);
    render();
  });

  source.onmessage = () => {
    // Keep stream active.
  };

  source.onerror = () => {
    pushMessage("Event stream disconnected.");
    render();
  };

  state.eventSource = source;
}

async function sendCommand(command: Record<string, unknown>): Promise<void> {
  if (!state.matchId || !state.playerId) {
    pushMessage("Create or join a match first");
    return;
  }

  const response = await fetchJson<{ rejected?: string; state: PublicState }>(
    `/v1/matches/${state.matchId}/commands`,
    {
      method: "POST",
      body: JSON.stringify({ playerId: state.playerId, command })
    }
  );

  if (response.rejected) {
    pushMessage(`Rejected: ${response.rejected}`);
  } else {
    state.current = response.state;
  }
  render();
}

async function sendFeedback(): Promise<void> {
  if (!state.matchId || !state.playerId) {
    pushMessage("Join a match first");
    return;
  }

  const message = messageInput.value.trim();
  if (!message) {
    return;
  }

  await fetchJson(`/v1/matches/${state.matchId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ playerId: state.playerId, message })
  });

  messageInput.value = "";
  pushMessage("Feedback submitted.");
  render();
}

function render(): void {
  const current = state.current;
  statusOut.textContent = current
    ? `match=${current.matchId} status=${current.status} wind=${current.wind} turn=${current.turnIndex} player=${state.playerId}`
    : "No active match";

  const lines = state.messages.slice(0, 10).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
  logOut.innerHTML = lines || "<li>No events yet</li>";

  if (!canvas || !context) {
    return;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4efe3";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (!current) {
    return;
  }

  drawTerrain(context, current.terrain);

  current.players.forEach((player, index) => {
    drawPlayer(context, player, index === current.turnIndex);
  });

  if (state.lastImpactX !== null) {
    context.fillStyle = "#b42318";
    context.beginPath();
    context.arc(state.lastImpactX, canvas.height - 40, 6, 0, Math.PI * 2);
    context.fill();
  }

  if (current.winnerId) {
    context.fillStyle = "#0f5132";
    context.font = "bold 24px ui-monospace, SFMono-Regular, Menlo";
    context.fillText(`Winner: ${current.winnerId}`, 20, 40);
  }
}

function drawTerrain(ctx: CanvasRenderingContext2D, terrain: number[]): void {
  ctx.fillStyle = "#7a5c3f";
  const step = canvas ? canvas.width / terrain.length : 10;
  terrain.forEach((value, index) => {
    ctx.fillRect(index * step, canvas!.height - value, step + 1, value);
  });
}

function drawPlayer(ctx: CanvasRenderingContext2D, player: PublicPlayer, isTurn: boolean): void {
  const y = canvas!.height - 90;
  ctx.fillStyle = isTurn ? "#0d6efd" : "#6c757d";
  ctx.fillRect(player.x - 10, y, 20, 16);

  const rad = (Math.PI / 180) * player.angle;
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(player.x, y);
  ctx.lineTo(player.x + Math.cos(rad) * 20, y - Math.sin(rad) * 20);
  ctx.stroke();

  ctx.fillStyle = "#111";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo";
  ctx.fillText(`${player.name} (${player.health})`, player.x - 35, y - 8);
}

function parseEvent(event: MessageEvent): ServerEvent | null {
  try {
    return JSON.parse(event.data) as ServerEvent;
  } catch {
    return null;
  }
}

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }

  return (await response.json()) as T;
}

function pushMessage(message: string): void {
  state.messages.unshift(message);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }
  return element as T;
}
