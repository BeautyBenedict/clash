// ============================================================
// lib/axl.ts — Gensyn AXL peer-to-peer helpers (v3)
// Dual-channel: AXL node (real P2P) + BroadcastChannel (same machine)
// BroadcastChannel works instantly across browser tabs/windows
// AXL works across different machines on the same network
// ============================================================

export const AXL_BASE = "http://localhost:9002";
export const BROADCAST_CHANNEL_NAME = "clash-arena";

// ── Core Types ───────────────────────────────────────────────

export interface UserAgent {
  id: string;
  name: string;
  description: string;
  walletAddress: string;
  createdAt: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface GameSession {
  gameId: string;
  gameType: "rps" | "quick-chat";
  players: SessionPlayer[];
  phase: "lobby" | "battle" | "results";
  results: ArenaResult[];
  chatLog: ChatEntry[];
  startedAt: number;
  endedAt?: number;
  prizePool: number;
  lastUpdated: number; // used to detect stale local copies
}

export interface SessionPlayer {
  walletAddress: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
  axlPubKey: string | null;
  move?: RPSMove;
  score: number;
}

export type RPSMove = "rock" | "paper" | "scissors";

export interface ArenaResult {
  rank: number;
  walletAddress: string;
  agentName: string;
  score: number;
  prize: string;
  prizeEth: string;
}

export interface ChatEntry {
  id: string;
  sender: string;
  content: string;
  timestamp: number;
  type: "move" | "result" | "system" | "peer" | "join";
  walletAddress?: string;
}

export interface GameHistoryEntry {
  sessionId: string;
  gameType: "rps" | "quick-chat";
  agentName: string;
  rank: number;
  prize: string;
  playedAt: number;
  players: number;
}

// ── AXL Message envelope ─────────────────────────────────────

export type AXLMessageType =
  | "player_join"
  | "player_move"
  | "game_start"
  | "game_result"
  | "session_sync"   // full session state sync
  | "chat";

export interface AXLEnvelope {
  type: AXLMessageType;
  gameId: string;
  walletAddress: string;
  agentName: string;
  agentDescription?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ── AXL Node ─────────────────────────────────────────────────

export async function checkAXLStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${AXL_BASE}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getNodePublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${AXL_BASE}/identity`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.public_key ?? null;
  } catch {
    return null;
  }
}

// ── Dual broadcast: AXL + BroadcastChannel ───────────────────

/**
 * Broadcast an envelope over BOTH channels:
 *   1. BroadcastChannel — instant, works across tabs/windows on same machine
 *   2. AXL node         — works across machines on the same network
 *
 * This means testing with two browser windows ALWAYS works,
 * even without AXL running.
 */
export async function broadcastEnvelope(envelope: AXLEnvelope): Promise<void> {
  // ── Channel 1: BroadcastChannel (always works same-machine) ──
  try {
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      bc.postMessage(envelope);
      bc.close();
    }
  } catch {
    // BroadcastChannel not available — ignore
  }

  // ── Channel 2: AXL node (works cross-machine) ──────────────
  try {
    await fetch(`${AXL_BASE}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "arena-broadcast", // broadcast topic key
        payload: JSON.stringify(envelope),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // AXL not running — silent fail, BroadcastChannel still works
  }

  // ── Channel 3: localStorage event (fallback for same-origin tabs) ──
  try {
    if (typeof window !== "undefined") {
      const key = `clash:axl:event:${envelope.gameId}`;
      localStorage.setItem(key, JSON.stringify({ ...envelope, _t: Date.now() }));
      // Remove after 500ms so next event triggers storage again
      setTimeout(() => localStorage.removeItem(key), 500);
    }
  } catch {
    // ignore
  }
}

/**
 * Poll AXL node for incoming messages from other machines.
 * Returns parsed envelopes for this game.
 */
export async function pollAXLMessages(gameId?: string): Promise<AXLEnvelope[]> {
  try {
    const res = await fetch(`${AXL_BASE}/recv`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw: Array<{ payload: string }> = data.messages ?? [];

    const envelopes: AXLEnvelope[] = [];
    for (const msg of raw) {
      try {
        const parsed = JSON.parse(msg.payload) as AXLEnvelope;
        if (parsed.type && parsed.gameId) {
          // Filter by gameId if provided
          if (!gameId || parsed.gameId === gameId) {
            envelopes.push(parsed);
          }
        }
      } catch {
        // skip malformed
      }
    }
    return envelopes;
  } catch {
    return [];
  }
}

/**
 * Subscribe to incoming envelopes via BroadcastChannel.
 * Returns an unsubscribe function — call it in useEffect cleanup.
 *
 * Usage:
 *   useEffect(() => {
 *     return subscribeBroadcast(gameId, (env) => handleEnvelope(env));
 *   }, [gameId]);
 */
export function subscribeBroadcast(
  gameId: string,
  onMessage: (env: AXLEnvelope) => void
): () => void {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return () => {};
  }

  const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

  bc.onmessage = (event: MessageEvent<AXLEnvelope>) => {
    const env = event.data;
    if (env?.gameId === gameId) {
      onMessage(env);
    }
  };

  // Also listen to localStorage events (extra fallback)
  const storageHandler = (e: StorageEvent) => {
    if (!e.key?.startsWith(`clash:axl:event:${gameId}`)) return;
    if (!e.newValue) return;
    try {
      const env = JSON.parse(e.newValue) as AXLEnvelope;
      if (env.gameId === gameId) onMessage(env);
    } catch { /* ignore */ }
  };
  window.addEventListener("storage", storageHandler);

  return () => {
    bc.close();
    window.removeEventListener("storage", storageHandler);
  };
}

// ── Session sync helpers ──────────────────────────────────────

/**
 * Broadcast a full session sync so other browsers can
 * update their local copy instantly.
 */
export async function syncSession(
  session: GameSession,
  wallet: string,
  agentName: string
): Promise<void> {
  const envelope: AXLEnvelope = {
    type: "session_sync",
    gameId: session.gameId,
    walletAddress: wallet,
    agentName,
    payload: { session },
    timestamp: Date.now(),
  };
  await broadcastEnvelope(envelope);
}

// ── Game logic ────────────────────────────────────────────────

const RPS_MOVES: RPSMove[] = ["rock", "paper", "scissors"];

export function decideRPSMove(agentDescription: string): RPSMove {
  const desc = agentDescription.toLowerCase();
  const seed = Math.random();

  if (desc.includes("aggressive") || desc.includes("attack") || desc.includes("strong")) {
    return seed < 0.5 ? "rock" : seed < 0.8 ? "scissors" : "paper";
  }
  if (desc.includes("defend") || desc.includes("safe") || desc.includes("careful")) {
    return seed < 0.5 ? "paper" : seed < 0.8 ? "rock" : "scissors";
  }
  if (desc.includes("chaos") || desc.includes("random") || desc.includes("unpredictable")) {
    return RPS_MOVES[Math.floor(Math.random() * 3)];
  }
  if (desc.includes("smart") || desc.includes("analyt") || desc.includes("logic")) {
    return seed < 0.4 ? "paper" : seed < 0.7 ? "scissors" : "rock";
  }
  return RPS_MOVES[Math.floor(seed * 3)];
}

function resolveRPS(a: RPSMove, b: RPSMove): number {
  if (a === b) return 0;
  if (
    (a === "rock" && b === "scissors") ||
    (a === "scissors" && b === "paper") ||
    (a === "paper" && b === "rock")
  ) return 1;
  return -1;
}

export function resolveQuickChat(a: SessionPlayer, b: SessionPlayer): number {
  const scoreA =
    a.agentDescription.length +
    (a.agentDescription.toLowerCase().includes("persuade") ? 20 : 0) +
    Math.floor(Math.random() * 30);
  const scoreB =
    b.agentDescription.length +
    (b.agentDescription.toLowerCase().includes("persuade") ? 20 : 0) +
    Math.floor(Math.random() * 30);
  if (scoreA > scoreB) return 1;
  if (scoreB > scoreA) return -1;
  return 0;
}

export function resolveTournament(
  players: SessionPlayer[],
  gameType: "rps" | "quick-chat",
  prizePoolEth: number
): ArenaResult[] {
  players.forEach(p => (p.score = 0));

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      let result: number;

      if (gameType === "rps") {
        const moveA = a.move ?? decideRPSMove(a.agentDescription);
        const moveB = b.move ?? decideRPSMove(b.agentDescription);
        a.move = moveA;
        b.move = moveB;
        result = resolveRPS(moveA, moveB);
      } else {
        result = resolveQuickChat(a, b);
      }

      if (result === 1) a.score += 2;
      else if (result === -1) b.score += 2;
      else { a.score += 1; b.score += 1; }
    }
  }

  const sorted = [...players].sort((a, b) => b.score - a.score);
  const SHARES = [0.6, 0.3, 0.1];

  return sorted.map((p, idx) => ({
    rank: idx + 1,
    walletAddress: p.walletAddress,
    agentName: p.agentName,
    score: p.score,
    prize: idx < 3 ? `${SHARES[idx] * 100}%` : "0%",
    prizeEth: idx < 3 ? (prizePoolEth * SHARES[idx]).toFixed(4) : "0",
  }));
}

// ── localStorage helpers ──────────────────────────────────────

const AGENTS_KEY  = (w: string) => `clash:agents:${w.toLowerCase()}`;
const HISTORY_KEY = (w: string) => `clash:history:${w.toLowerCase()}`;
const SESSION_KEY = (g: string) => `clash:session:${g}`;

export function loadAgents(wallet: string): UserAgent[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(AGENTS_KEY(wallet)) ?? "[]"); }
  catch { return []; }
}

export function saveAgents(wallet: string, agents: UserAgent[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(AGENTS_KEY(wallet), JSON.stringify(agents));
}

export function loadHistory(wallet: string): GameHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY(wallet)) ?? "[]"); }
  catch { return []; }
}

export function saveHistory(wallet: string, history: GameHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(HISTORY_KEY(wallet), JSON.stringify(history));
}

export function loadSession(gameId: string): GameSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY(gameId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveSession(session: GameSession): void {
  if (typeof window === "undefined") return;
  const updated = { ...session, lastUpdated: Date.now() };
  localStorage.setItem(SESSION_KEY(session.gameId), JSON.stringify(updated));
}

// ── Utility ───────────────────────────────────────────────────

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function buildChat(
  sender: string,
  content: string,
  type: ChatEntry["type"] = "system",
  walletAddress?: string
): ChatEntry {
  return { id: makeId(), sender, content, timestamp: Date.now(), type, walletAddress };
}

export function shortWallet(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}