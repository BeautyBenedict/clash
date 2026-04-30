"use client";
// ============================================================
// app/page.tsx — Clash: Agent Arena v4
// Real multiplayer via Socket.io backend (server.js on port 3001)
// ETHGlobal Open Agents × Gensyn AXL
// © Beauty Benedict. All rights reserved.
// ============================================================

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import {
  useAccount, useConnect, useDisconnect,
  useWriteContract, useWaitForTransactionReceipt,
  useBalance, WagmiProvider,
} from "wagmi";
import { parseEther, formatEther } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { io, Socket } from "socket.io-client";

import { wagmiConfig, baseSepolia, ENTRY_FEE_ETH, CLASH_ABI, CLASH_CONTRACT_ADDRESS } from "@/lib/wagmi-config";
import {
  checkAXLStatus, getNodePublicKey,
  broadcastEnvelope, pollAXLMessages, subscribeBroadcast,
  decideRPSMove, resolveTournament,
  loadAgents, saveAgents,
  loadHistory, saveHistory,
  buildChat, makeId, shortWallet,
  type UserAgent, type SessionPlayer,
  type ChatEntry, type GameHistoryEntry, type AXLEnvelope,
} from "@/lib/axl";

// ── Types ─────────────────────────────────────────────────────
interface GameSession {
  gameId: string;
  gameType: "rps" | "quick-chat";
  players: SessionPlayer[];
  phase: "lobby" | "battle" | "results";
  results: ArenaResult[];
  prizePool: number;
  lastUpdated: number;
}
interface ArenaResult {
  rank: number;
  walletAddress: string;
  agentName: string;
  score: number;
  prize: string;
  prizeEth: string;
}
type Tab = "lobby" | "my-agents" | "dashboard";

// ── Constants ─────────────────────────────────────────────────
const queryClient = new QueryClient();
// Uses env var in production (Railway), falls back to localhost in development
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";

const AVAILABLE_GAMES = [
  { id: "rps-arena",         type: "rps" as const,        title: "Rock · Paper · Scissors Arena", description: "Agents pick moves based on personality. Best round-robin score wins.", emoji: "✊", maxPlayers: 8 },
  { id: "quick-chat-battle", type: "quick-chat" as const,  title: "Quick Chat Battle",              description: "Agents compete by wit and persuasion. Richest personality wins.",     emoji: "💬", maxPlayers: 6 },
  { id: "rps-blitz",         type: "rps" as const,        title: "Blitz RPS",                      description: "Fast-paced RPS — top scorer takes the pool.",                        emoji: "⚡", maxPlayers: 4 },
];

const PRIZE_COLORS: Record<number, string> = { 1: "#FFD700", 2: "#C0C0C0", 3: "#CD7F32" };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ── Socket singleton ──────────────────────────────────────────
let _socket: Socket | null = null;
function getSocket(): Socket {
  if (!_socket) {
    _socket = io(SOCKET_URL, { autoConnect: true, reconnection: true });
  }
  return _socket;
}

// ============================================================
function ClashArena() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();

  const { data: balanceData } = useBalance({
    address, chainId: baseSepolia.id, query: { enabled: isConnected },
  });

  const [axlOnline, setAxlOnline]       = useState<boolean | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [tab, setTab]                   = useState<Tab>("lobby");
  const [myAgents, setMyAgents]         = useState<UserAgent[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [agentForm, setAgentForm]       = useState({ name: "", description: "" });
  const [formError, setFormError]       = useState("");
  const [history, setHistory]           = useState<GameHistoryEntry[]>([]);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<GameSession | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [chatLog, setChatLog]           = useState<ChatEntry[]>([]);
  const [isBattling, setIsBattling]     = useState(false);
  const [battleProgress, setBattleProgress] = useState(0);
  const [stakedForGame, setStakedForGame] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const { writeContract, data: txHash, isPending: isSending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txSuccess }     = useWaitForTransactionReceipt({ hash: txHash });

  const chatEndRef   = useRef<HTMLDivElement>(null);
  const activeGameRef = useRef<string | null>(null);
  activeGameRef.current = activeGameId;

  // ── Mounted flag (prevents SSR/client hydration mismatch) ──
  useEffect(() => { setMounted(true); }, []);

  // ── Load wallet data ─────────────────────────────────────
  useEffect(() => {
    if (!address) { setMyAgents([]); setHistory([]); return; }
    setMyAgents(loadAgents(address));
    setHistory(loadHistory(address));
  }, [address]);

  // ── AXL check ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const on = await checkAXLStatus();
      if (!cancelled) setAxlOnline(on);
    };
    check();
    const t = setInterval(check, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // ── Socket.io ────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setSocketConnected(true);
      // Rejoin room if we were in a game
      if (activeGameRef.current) {
        socket.emit("get_session", { gameId: activeGameRef.current });
      }
    };
    const onDisconnect = () => setSocketConnected(false);

    const onSessionUpdate = (session: GameSession) => {
      setActiveSession(session);
      // Show join messages for new players
      if (session.phase === "lobby") {
        setChatLog(prev => {
          const knownWallets = new Set(prev.filter(e => e.type === "join").map(e => e.walletAddress));
          const newEntries: ChatEntry[] = [];
          for (const p of session.players) {
            if (!knownWallets.has(p.walletAddress) && p.walletAddress !== address?.toLowerCase()) {
              newEntries.push(buildChat(
                `${p.agentName} (${shortWallet(p.walletAddress)})`,
                "joined the arena! ⚡", "join", p.walletAddress
              ));
            }
          }
          return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
        });
      }
    };

    const onGameEvent = (event: { type: string; agentName: string; walletAddress: string; content: string }) => {
      if (event.walletAddress === address?.toLowerCase()) return;
      addChat(
        `${event.agentName} (${shortWallet(event.walletAddress)})`,
        event.content,
        event.type === "move" ? "move" : "peer",
        event.walletAddress
      );
    };

    socket.on("connect",        onConnect);
    socket.on("disconnect",     onDisconnect);
    socket.on("session_update", onSessionUpdate);
    socket.on("game_event",     onGameEvent);

    if (socket.connected) setSocketConnected(true);

    return () => {
      socket.off("connect",        onConnect);
      socket.off("disconnect",     onDisconnect);
      socket.off("session_update", onSessionUpdate);
      socket.off("game_event",     onGameEvent);
    };
  }, [address]);

  // ── Stake confirmed ───────────────────────────────────────
  useEffect(() => {
    if (txSuccess && activeGameId) setStakedForGame(activeGameId);
  }, [txSuccess, activeGameId]);

  // ── Auto-scroll chat ──────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog]);

  // ── Helpers ───────────────────────────────────────────────
  function addChat(sender: string, content: string, type: ChatEntry["type"] = "system", wallet?: string) {
    setChatLog(prev => [...prev, buildChat(sender, content, type, wallet)]);
  }

  // ── Create agent ──────────────────────────────────────────
  function handleCreateAgent() {
    if (!address) return;
    const name = agentForm.name.trim();
    const desc = agentForm.description.trim();
    if (!name) { setFormError("Agent needs a name."); return; }
    if (!desc)  { setFormError("Give your agent a personality."); return; }
    if (name.length > 30) { setFormError("Name max 30 chars."); return; }
    const agent: UserAgent = {
      id: makeId(), name, description: desc,
      walletAddress: address.toLowerCase(),
      createdAt: Date.now(), wins: 0, losses: 0, draws: 0,
    };
    const updated = [...myAgents, agent];
    setMyAgents(updated);
    saveAgents(address, updated);
    setAgentForm({ name: "", description: "" });
    setFormError("");
    setShowCreateModal(false);
  }

  function handleDeleteAgent(id: string) {
    if (!address) return;
    const updated = myAgents.filter(a => a.id !== id);
    setMyAgents(updated);
    saveAgents(address, updated);
  }

  // ── Join game ─────────────────────────────────────────────
  function handleJoinGame(game: typeof AVAILABLE_GAMES[0]) {
    if (!address || !selectedAgentId) return;
    const agent = myAgents.find(a => a.id === selectedAgentId);
    if (!agent) return;

    setActiveGameId(game.id);
    setChatLog([]);

    const socket = getSocket();
    socket.emit("join_game", {
      gameId: game.id,
      gameType: game.type,
      walletAddress: address.toLowerCase(),
      agentName: agent.name,
      agentDescription: agent.description,
    });

    // Also broadcast over AXL for cross-machine P2P (bonus for Gensyn judges)
    broadcastEnvelope({
      type: "player_join",
      gameId: game.id,
      walletAddress: address.toLowerCase(),
      agentName: agent.name,
      agentDescription: agent.description,
      payload: { gameType: game.type },
      timestamp: Date.now(),
    });

    addChat("🏟️ Arena", `You joined ${game.title} with ${agent.name}`, "system");
    addChat("🏟️ Arena", "Waiting for opponent to join…", "system");
  }

  // ── Leave game ────────────────────────────────────────────
  function handleLeaveSession() {
    if (activeGameId && address) {
      getSocket().emit("leave_game", {
        gameId: activeGameId,
        walletAddress: address.toLowerCase(),
      });
    }
    setActiveSession(null);
    setActiveGameId(null);
    setChatLog([]);
    setSelectedAgentId(null);
    setStakedForGame(null);
    setBattleProgress(0);
    setIsBattling(false);
  }

  // ── Stake ─────────────────────────────────────────────────
  function handleStake() {
    if (!isConnected || !activeGameId) return;
    if (CLASH_CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      alert("Paste your deployed contract address into lib/wagmi-config.ts first.");
      return;
    }
    writeContract({
      address: CLASH_CONTRACT_ADDRESS,
      abi: CLASH_ABI,
      functionName: "joinGame",
      args: [activeGameId],
      value: parseEther(ENTRY_FEE_ETH),
      chainId: baseSepolia.id,
    });
  }

  // ── Start battle ──────────────────────────────────────────
  async function handleStartBattle() {
    if (!activeSession || !address || isBattling) return;
    if (activeSession.players.length < 2) {
      addChat("🏟️ Arena", "Need at least 2 players to start!", "system");
      return;
    }

    setIsBattling(true);
    setBattleProgress(0);
    const socket = getSocket();
    const players = activeSession.players.map(p => ({ ...p }));

    addChat("⚔️ Arena", `Battle begins! ${players.length} agents fighting…`, "system");

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      await delay(600);
      const move = decideRPSMove(p.agentDescription);
      p.move = move;
      const isMe = p.walletAddress === address.toLowerCase();
      const content = activeSession.gameType === "rps"
        ? `⚔️ chose: ${move.toUpperCase()}`
        : `💬 presenting their case…`;

      addChat(`${p.agentName}${isMe ? " (you)" : ""}`, content, "move", p.walletAddress);

      socket.emit("game_event", {
        gameId: activeSession.gameId,
        event: { type: "move", agentName: p.agentName, walletAddress: p.walletAddress, content },
      });

      setBattleProgress(((i + 1) / players.length) * 65);
    }

    await delay(700);
    addChat("🏟️ Arena", "Resolving tournament…", "system");

    const results = resolveTournament(players, activeSession.gameType, activeSession.prizePool);
    const medals = ["🥇", "🥈", "🥉"];
    results.slice(0, 3).forEach((r, i) => {
      addChat("🏟️ Arena", `${medals[i]} ${r.agentName} — ${r.score}pts — ${r.prize} (${r.prizeEth} ETH)`, "result");
    });

    // Push final results to ALL browsers via server
    socket.emit("battle_results", {
      gameId: activeSession.gameId,
      results,
      players,
    });

    // Declare winners on-chain if contract is deployed
    if (CLASH_CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      try {
        const w1 = results[0]?.walletAddress as `0x${string}`;
        const w2 = (results[1]?.walletAddress ?? results[0]?.walletAddress) as `0x${string}`;
        const w3 = (results[2]?.walletAddress ?? results[1]?.walletAddress ?? results[0]?.walletAddress) as `0x${string}`;
        if (w1) {
          writeContract({
            address: CLASH_CONTRACT_ADDRESS, abi: CLASH_ABI,
            functionName: "declareWinners",
            args: [activeSession.gameId, w1, w2, w3],
            chainId: baseSepolia.id,
          });
          addChat("🏟️ Arena", "Declaring winners on-chain — confirm in MetaMask.", "system");
        }
      } catch (e) { console.error("declareWinners:", e); }
    }

    // Update local stats
    const myResult = results.find(r => r.walletAddress === address.toLowerCase());
    if (myResult && address) {
      const updatedAgents = myAgents.map(a => {
        if (a.name !== myResult.agentName) return a;
        return { ...a, wins: a.wins + (myResult.rank === 1 ? 1 : 0), losses: a.losses + (myResult.rank > 3 ? 1 : 0), draws: a.draws + (myResult.rank > 1 && myResult.rank <= 3 ? 1 : 0) };
      });
      setMyAgents(updatedAgents);
      saveAgents(address, updatedAgents);
      const h: GameHistoryEntry = { sessionId: activeSession.gameId, gameType: activeSession.gameType, agentName: myResult.agentName, rank: myResult.rank, prize: myResult.prize, playedAt: Date.now(), players: activeSession.players.length };
      const updatedHistory = [h, ...history].slice(0, 50);
      setHistory(updatedHistory);
      saveHistory(address, updatedHistory);
    }

    setBattleProgress(100);
    setIsBattling(false);
  }

  // ── New game ──────────────────────────────────────────────
  function handleNewGame() {
    if (activeGameId) {
      getSocket().emit("reset_game", { gameId: activeGameId, gameType: activeSession?.gameType });
    }
    setActiveSession(null); setActiveGameId(null);
    setChatLog([]); setSelectedAgentId(null);
    setStakedForGame(null); setBattleProgress(0); setIsBattling(false);
  }

  // ── Derived ───────────────────────────────────────────────
  const isInSession = !!activeSession;
  const canBattle   = isInSession && activeSession!.players.length >= 2 && activeSession!.phase !== "results" && !isBattling;

  // ── RENDER ────────────────────────────────────────────────
  return (
    <div className="clash-root">
      <div className="grid-bg" aria-hidden />

      {/* HEADER */}
      <header className="clash-header">
        <div className="header-brand">
          <Image src="/logo.png" alt="Clash" width={38} height={38} className="header-logo"
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <span className="header-title">CLASH</span>
          <span className="header-sub">Agent Arena</span>
        </div>

        <nav className="header-nav">
          {(["lobby", "my-agents", "dashboard"] as Tab[]).map(t => (
            <button key={t} className={`nav-btn ${tab === t ? "nav-active" : ""}`} onClick={() => setTab(t)}>
              {t === "lobby" ? "🏟️ Lobby" : t === "my-agents" ? "🤖 My Agents" : "📊 Dashboard"}
            </button>
          ))}
        </nav>

        <div className="header-right">
          <div className={`status-pill ${socketConnected ? "pill-green" : "pill-red"}`}>
            <span className="pill-dot" />
            {socketConnected ? "SERVER LIVE" : "SERVER OFFLINE"}
          </div>
          <div className={`status-pill ${axlOnline ? "pill-green" : "pill-gray"}`} style={{fontSize:9}}>
            <span className="pill-dot" />
            AXL {axlOnline ? "ON" : "OFF"}
          </div>

          {isConnected ? (
            <div className="wallet-chip">
              <div className="wallet-info">
                <span className="wallet-addr">{shortWallet(address!)}</span>
                {balanceData && <span className="wallet-bal">{parseFloat(formatEther(balanceData.value)).toFixed(4)} ETH</span>}
                <span className="wallet-chain">Base Sepolia</span>
              </div>
              <button className="btn btn-ghost btn-xs" onClick={() => disconnect()}>✕</button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => connect({ connector: connectors[0] })} disabled={isConnecting}>
              {isConnecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      {/* SERVER OFFLINE BANNER */}
      {!socketConnected && (
        <div className="server-banner">
          ⚠️ Backend offline. Open a terminal in your project folder and run: <code>node server.js</code>
        </div>
      )}

      {/* BODY */}
      <main className="clash-body">

        {/* ══ LOBBY ══ */}
        {tab === "lobby" && (
          <div className="lobby-layout">

            {/* LEFT */}
            <div className="lobby-left">
              <h2 className="section-title">Available Games</h2>

              {!isConnected && <div className="notice">Connect your wallet to join a game.</div>}
              {isConnected && myAgents.length === 0 && (
                <div className="notice notice-warn">
                  No agents yet. <button className="link-btn" onClick={() => setTab("my-agents")}>Create one →</button>
                </div>
              )}

              {isConnected && myAgents.length > 0 && !isInSession && (
                <div className="agent-selector">
                  <label className="field-label">Select agent to deploy:</label>
                  <div className="agent-select-list">
                    {myAgents.map(a => (
                      <button key={a.id} className={`agent-pick ${selectedAgentId === a.id ? "agent-pick-active" : ""}`}
                        onClick={() => setSelectedAgentId(a.id)}>
                        <span className="agent-pick-name">{a.name}</span>
                        <span className="agent-pick-desc">{a.description.slice(0, 45)}{a.description.length > 45 ? "…" : ""}</span>
                        <span className="agent-pick-stats">W:{a.wins} L:{a.losses}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="game-list">
                {AVAILABLE_GAMES.map(game => {
                  const isThisActive = activeGameId === game.id;
                  const count = mounted && isThisActive && activeSession ? activeSession.players.length : 0;
                  return (
                    <div key={game.id} className={`game-card ${isThisActive ? "game-card-active" : ""}`}>
                      <div className="game-card-top">
                        <span className="game-emoji">{game.emoji}</span>
                        <div className="game-info">
                          <div className="game-title">{game.title}</div>
                          <div className="game-desc">{game.description}</div>
                        </div>
                        <div className="game-meta">
                          <span className="game-players">{count} / {game.maxPlayers} players</span>
                          <span className="game-fee">{ENTRY_FEE_ETH} ETH</span>
                        </div>
                      </div>
                      {isConnected && (
                        <div className="game-card-actions">
                          {isThisActive ? (
                            <div className="flex-row">
                              <span className="badge badge-green">✓ Joined</span>
                              <button className="btn btn-ghost btn-xs" onClick={handleLeaveSession}>🚪 Leave</button>
                            </div>
                          ) : (
                            <button className="btn btn-join"
                              disabled={!selectedAgentId || isInSession}
                              onClick={() => handleJoinGame(game)}
                              title={!selectedAgentId ? "Select an agent first" : isInSession ? "Leave your current game first" : ""}>
                              {!selectedAgentId ? "Select agent first" : "Join Game →"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* RIGHT — Session panel */}
            <div className="lobby-right">
              {!isInSession ? (
                <div className="session-empty">
                  <span style={{fontSize:40}}>⚔️</span>
                  <p>Join a game to start battling.</p>
                  <p style={{fontSize:12, color:"var(--muted)"}}>
                    {socketConnected
                      ? "✅ Server live — open in another browser to test multiplayer."
                      : "⚠️ Run node server.js first for real multiplayer."}
                  </p>
                </div>
              ) : (
                <div className="session-panel">

                  {/* Session header */}
                  <div className="session-header">
                    <div style={{flex:1}}>
                      <div className="session-title">{AVAILABLE_GAMES.find(g => g.id === activeGameId)?.title}</div>
                      <div className="session-status">
                        {activeSession!.phase === "lobby"   && `Lobby · ${activeSession!.players.length} player(s) · waiting for opponent`}
                        {activeSession!.phase === "battle"  && "⚔️ Battle in progress…"}
                        {activeSession!.phase === "results" && "✅ Battle complete"}
                      </div>
                    </div>
                    <div className="session-pool">
                      <span className="pool-label">Prize Pool</span>
                      <span className="pool-value">{activeSession!.prizePool.toFixed(3)} ETH</span>
                    </div>
                  </div>

                  {/* Players */}
                  <div>
                    <div className="field-label" style={{marginBottom:8}}>
                      Players in lobby ({activeSession!.players.length})
                    </div>
                    {activeSession!.players.length === 0 && (
                      <div className="notice" style={{margin:0}}>No one here yet…</div>
                    )}
                    {activeSession!.players.map(p => {
                      const isMe = p.walletAddress === address?.toLowerCase();
                      return (
                        <div key={p.walletAddress} className={`player-row ${isMe ? "player-me" : ""}`} style={{marginBottom:6}}>
                          <div className="player-info">
                            <span className="player-name">{p.agentName}</span>
                            <span className="player-wallet">{shortWallet(p.walletAddress)}</span>
                            {isMe && <span className="badge badge-blue">you</span>}
                          </div>
                          {p.axlPubKey && <span style={{fontFamily:"var(--font-mono)", fontSize:10, color:"var(--green)"}}>AXL ✓</span>}
                        </div>
                      );
                    })}
                  </div>

                  {/* Stake + Leave */}
                  {activeSession!.phase === "lobby" && (
                    <div className="flex-row">
                      {stakedForGame === activeGameId ? (
                        <div className="notice notice-green" style={{margin:0, flex:1}}>
                          ✅ Staked!
                          {txHash && <a className="tx-link" style={{marginLeft:8}} href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">View tx ↗</a>}
                        </div>
                      ) : (
                        <button className="btn btn-stake" style={{flex:1}} onClick={handleStake} disabled={isSending || isConfirming || !isConnected}>
                          {isSending ? "⏳ Confirm in wallet…" : isConfirming ? "⏳ Confirming…" : "⚡ Stake & Lock In (0.001 ETH)"}
                        </button>
                      )}
                      <button className="btn btn-ghost" onClick={handleLeaveSession}>🚪 Leave Game</button>
                    </div>
                  )}

                  {/* Battle button */}
                  {activeSession!.phase !== "results" && (
                    <>
                      <button className="btn btn-battle w-full" onClick={handleStartBattle} disabled={!canBattle}>
                        {isBattling ? <><span className="spin">⚙</span> Battle in progress…</>
                          : activeSession!.players.length < 2 ? "⏳ Waiting for opponent…"
                          : "⚡ Start Battle"}
                      </button>
                      {isBattling && (
                        <div className="progress-track">
                          <div className="progress-fill" style={{width:`${battleProgress}%`}} />
                        </div>
                      )}
                    </>
                  )}

                  {/* Results */}
                  {activeSession!.phase === "results" && activeSession!.results.length > 0 && (
                    <div className="results-box">
                      <div className="results-title">🏆 Results</div>
                      {activeSession!.results.slice(0, 3).map(r => (
                        <div key={r.walletAddress} className="result-row">
                          <span style={{fontSize:18, color: PRIZE_COLORS[r.rank] ?? "#aaa"}}>
                            {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : "🥉"}
                          </span>
                          <span style={{flex:1, fontWeight:700}}>{r.agentName}</span>
                          <span className="muted" style={{fontFamily:"var(--font-mono)", fontSize:11}}>{shortWallet(r.walletAddress)}</span>
                          <span className="muted" style={{fontFamily:"var(--font-mono)", fontSize:11}}>{r.score}pts</span>
                          <span style={{fontFamily:"var(--font-d)", fontSize:18, color: PRIZE_COLORS[r.rank] ?? "#aaa"}}>{r.prize}</span>
                          <span className="muted" style={{fontFamily:"var(--font-mono)", fontSize:11}}>{r.prizeEth} ETH</span>
                        </div>
                      ))}
                      <div className="flex-row" style={{marginTop:12}}>
                        <button className="btn btn-primary w-full" onClick={handleNewGame}>🔄 Play Again</button>
                        <button className="btn btn-ghost w-full" onClick={handleLeaveSession}>Back to Lobby</button>
                      </div>
                    </div>
                  )}

                  {/* Live chat */}
                  <div className="chat-panel">
                    <div className="chat-header-row">
                      <span className="chat-label">Live Feed</span>
                      <span className="chat-badge">{socketConnected ? "🟢 Live" : "🔴 Offline"}{axlOnline ? " · AXL" : ""}</span>
                    </div>
                    <div className="chat-log">
                      {chatLog.length === 0 && <div className="chat-empty">Messages appear here in real time…</div>}
                      {chatLog.map(entry => (
                        <div key={entry.id} className={`chat-entry chat-${entry.type}`}>
                          <span className="chat-sender">{entry.sender}</span>
                          <span className="chat-content">{entry.content}</span>
                          <span className="chat-time">{fmtTime(entry.timestamp)}</span>
                        </div>
                      ))}
                      <div ref={chatEndRef} />
                    </div>
                  </div>

                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ MY AGENTS ══ */}
        {tab === "my-agents" && (
          <div className="agents-page">
            <div className="flex-row" style={{marginBottom:20}}>
              <h2 className="section-title" style={{marginBottom:0}}>My Agents</h2>
              {isConnected && <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ Create Agent</button>}
            </div>
            {!isConnected && <div className="notice">Connect your wallet to manage agents.</div>}
            {isConnected && myAgents.length === 0 && (
              <div className="empty-state">
                <span style={{fontSize:48}}>🤖</span>
                <p>No agents yet. Create your first one!</p>
                <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ Create Agent</button>
              </div>
            )}
            <div className="agents-grid">
              {myAgents.map(agent => (
                <div key={agent.id} className="agent-full-card">
                  <div className="flex-row">
                    <span style={{fontWeight:800, fontSize:16}}>{agent.name}</span>
                    <button className="btn btn-ghost btn-xs danger" onClick={() => handleDeleteAgent(agent.id)}>✕</button>
                  </div>
                  <p style={{fontSize:13, color:"var(--muted2)", lineHeight:1.5}}>{agent.description}</p>
                  <div style={{display:"flex", gap:12, fontFamily:"var(--font-mono)", fontSize:12}}>
                    <span style={{color:"var(--green)"}}>W: {agent.wins}</span>
                    <span style={{color:"var(--accent)"}}>L: {agent.losses}</span>
                    <span style={{color:"var(--muted2)"}}>D: {agent.draws}</span>
                  </div>
                  <div style={{fontFamily:"var(--font-mono)", fontSize:10, color:"var(--muted2)"}}>Created {fmtDate(agent.createdAt)}</div>
                  <button className="btn btn-join w-full" style={{marginTop:8}}
                    onClick={() => { setSelectedAgentId(agent.id); setTab("lobby"); }}>
                    Deploy to Arena →
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ DASHBOARD ══ */}
        {tab === "dashboard" && (
          <div style={{maxWidth:900}}>
            <h2 className="section-title">My Dashboard</h2>
            {!isConnected ? <div className="notice">Connect your wallet to view your dashboard.</div> : (
              <>
                <div className="dash-cards">
                  {[
                    { label: "Wallet",      value: shortWallet(address!), style: {fontSize:14, fontFamily:"var(--font-mono)"} },
                    { label: "Balance",     value: balanceData ? `${parseFloat(formatEther(balanceData.value)).toFixed(5)} ETH` : "…", sub: "Base Sepolia" },
                    { label: "Agents",      value: String(myAgents.length) },
                    { label: "Games Played",value: String(history.length) },
                    { label: "Total Wins",  value: String(myAgents.reduce((s,a) => s+a.wins, 0)), style: {color:"var(--green)"} },
                  ].map(c => (
                    <div key={c.label} className="dash-card">
                      <div className="dash-card-label">{c.label}</div>
                      <div className="dash-card-value" style={c.style ?? {}}>{c.value}</div>
                      {c.sub && <div style={{fontSize:11, color:"var(--muted2)", marginTop:4}}>{c.sub}</div>}
                    </div>
                  ))}
                </div>
                <h3 className="section-subtitle">Game History</h3>
                {history.length === 0 ? <div className="notice">No games yet. Jump into the lobby!</div> : (
                  <div className="history-table">
                    <div className="history-head">
                      <span>Game</span><span>Agent</span><span>Players</span><span>Rank</span><span>Prize</span><span>Date</span>
                    </div>
                    {history.map(h => (
                      <div key={h.sessionId + h.playedAt} className="history-row">
                        <span style={{fontFamily:"var(--font-mono)", fontSize:11}}>{h.gameType === "rps" ? "✊ RPS" : "💬 Chat"}</span>
                        <span>{h.agentName}</span>
                        <span>{h.players}</span>
                        <span style={{color: PRIZE_COLORS[h.rank] ?? "var(--muted2)"}}>#{h.rank}</span>
                        <span style={{color: PRIZE_COLORS[h.rank] ?? "var(--muted2)"}}>{h.prize}</span>
                        <span style={{fontSize:11, color:"var(--muted2)"}}>{fmtDate(h.playedAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>

      {/* FOOTER */}
      <footer className="clash-footer">
        <span>© {new Date().getFullYear()} Beauty Benedict. All rights reserved.</span>
        <span style={{color:"var(--muted)"}}>·</span>
        <span>Built for ETHGlobal Open Agents × Gensyn AXL</span>
      </footer>

      {/* CREATE AGENT MODAL */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="flex-row" style={{marginBottom:8}}>
              <span style={{fontFamily:"var(--font-d)", fontSize:22, letterSpacing:2}}>Create Agent</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <label className="field-label">Agent Name</label>
            <input className="field-input" placeholder="e.g. Shadow Hawk" maxLength={30}
              value={agentForm.name} onChange={e => setAgentForm(f => ({ ...f, name: e.target.value }))} />
            <label className="field-label" style={{marginTop:12}}>
              Personality / Strategy
              <span style={{display:"block", fontSize:11, color:"var(--muted2)", fontWeight:400, textTransform:"none", letterSpacing:0, marginTop:3}}>
                This determines how your agent fights — sent to opponents via AXL.
              </span>
            </label>
            <textarea className="field-input" style={{resize:"vertical", minHeight:90}} rows={4} maxLength={300}
              placeholder="e.g. Aggressive and unpredictable. Always attacks first. Loves to bluff opponents."
              value={agentForm.description} onChange={e => setAgentForm(f => ({ ...f, description: e.target.value }))} />
            {formError && <div style={{fontSize:12, color:"var(--accent)", padding:"4px 0"}}>{formError}</div>}
            <button className="btn btn-primary w-full" style={{marginTop:16}} onClick={handleCreateAgent}>
              Create Agent
            </button>
          </div>
        </div>
      )}

      {/* STYLES */}
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=Cabinet+Grotesk:wght@400;500;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg:#07090C; --surface:#0D1117; --surface2:#131920; --surface3:#1A2230;
          --border:rgba(255,255,255,0.07); --border2:rgba(255,255,255,0.12);
          --accent:#FF4444; --accent2:#FF8C00; --green:#3DDB96; --blue:#4B9FFF;
          --text:#E2E8F0; --muted:#4A5568; --muted2:#718096;
          --font-d:'Bebas Neue',sans-serif; --font-mono:'DM Mono',monospace; --font-body:'Cabinet Grotesk',sans-serif;
          --r:8px;
        }
        html,body { height:100%; background:var(--bg); color:var(--text); }
        body { font-family:var(--font-body); font-size:14px; line-height:1.6; overflow-x:hidden; }
        a { color:inherit; text-decoration:none; }
        .clash-root { min-height:100vh; display:flex; flex-direction:column; position:relative; }
        .grid-bg { position:fixed; inset:0; z-index:0; pointer-events:none; background-image:linear-gradient(rgba(255,68,68,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,68,68,0.025) 1px,transparent 1px); background-size:44px 44px; }
        .server-banner { position:relative; z-index:15; background:rgba(255,140,0,0.12); border-bottom:1px solid rgba(255,140,0,0.35); padding:10px 24px; font-size:13px; color:var(--accent2); text-align:center; }
        .server-banner code { background:rgba(255,140,0,0.2); padding:2px 8px; border-radius:4px; font-family:var(--font-mono); }

        /* Header */
        .clash-header { position:relative; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 24px; border-bottom:1px solid var(--border); background:rgba(7,9,12,0.92); backdrop-filter:blur(16px); flex-wrap:wrap; }
        .header-brand { display:flex; align-items:center; gap:10px; flex-shrink:0; }
        .header-logo  { border-radius:6px; object-fit:contain; }
        .header-title { font-family:var(--font-d); font-size:30px; letter-spacing:3px; color:var(--accent); line-height:1; }
        .header-sub   { font-family:var(--font-mono); font-size:10px; color:var(--muted2); letter-spacing:2px; border:1px solid var(--border); border-radius:4px; padding:2px 8px; }
        .header-nav   { display:flex; gap:4px; }
        .nav-btn      { background:none; border:1px solid transparent; border-radius:6px; color:var(--muted2); font-family:var(--font-body); font-size:13px; padding:6px 14px; cursor:pointer; transition:all 0.15s; }
        .nav-btn:hover{ color:var(--text); border-color:var(--border2); }
        .nav-active   { color:var(--text)!important; background:var(--surface2)!important; border-color:var(--border2)!important; }
        .header-right { display:flex; align-items:center; gap:10px; }
        .wallet-chip  { display:flex; align-items:center; gap:10px; background:var(--surface); border:1px solid var(--border2); border-radius:8px; padding:6px 12px; }
        .wallet-info  { display:flex; flex-direction:column; gap:1px; }
        .wallet-addr  { font-family:var(--font-mono); font-size:12px; }
        .wallet-bal   { font-family:var(--font-mono); font-size:11px; color:var(--green); }
        .wallet-chain { font-size:10px; color:var(--muted2); }
        .status-pill  { display:flex; align-items:center; gap:7px; font-family:var(--font-mono); font-size:10px; letter-spacing:1px; padding:5px 12px; border-radius:20px; border:1px solid; }
        .pill-green   { border-color:var(--green); color:var(--green); }
        .pill-red     { border-color:var(--accent); color:var(--accent); }
        .pill-gray    { border-color:var(--border); color:var(--muted2); }
        .pill-dot     { width:6px; height:6px; border-radius:50%; background:currentColor; animation:pulse 2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

        /* Layout */
        .clash-body { position:relative; z-index:1; flex:1; padding:24px; max-width:1400px; margin:0 auto; width:100%; }
        .section-title    { font-family:var(--font-d); font-size:24px; letter-spacing:2px; margin-bottom:16px; }
        .section-subtitle { font-family:var(--font-d); font-size:18px; letter-spacing:1px; margin:24px 0 12px; }
        .flex-row { display:flex; align-items:center; gap:10px; }

        /* Buttons */
        .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; font-family:var(--font-mono); font-size:13px; padding:9px 18px; border-radius:var(--r); border:1px solid transparent; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
        .btn:disabled { opacity:0.4; cursor:not-allowed; }
        .w-full { width:100%; }
        .btn-primary { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
        .btn-primary:hover:not(:disabled) { background:#e03333; }
        .btn-ghost { background:transparent; color:var(--muted2); border-color:var(--border); }
        .btn-ghost:hover:not(:disabled) { color:var(--text); border-color:var(--border2); }
        .btn-ghost.danger:hover { color:var(--accent); border-color:var(--accent); }
        .btn-xs { padding:4px 8px; font-size:11px; }
        .btn-stake { background:transparent; color:var(--accent2); border-color:var(--accent2); }
        .btn-stake:hover:not(:disabled) { background:rgba(255,140,0,0.1); }
        .btn-join { background:var(--surface3); color:var(--text); border-color:var(--border2); }
        .btn-join:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
        .btn-battle { background:linear-gradient(135deg,var(--accent) 0%,#cc0000 100%); color:#fff; font-size:15px; font-family:var(--font-d); letter-spacing:2px; padding:14px; box-shadow:0 0 24px rgba(255,68,68,0.2); }
        .btn-battle:hover:not(:disabled) { box-shadow:0 0 36px rgba(255,68,68,0.45); }

        /* Notices */
        .notice       { background:var(--surface2); border:1px solid var(--border); border-radius:var(--r); padding:14px 18px; font-size:13px; color:var(--muted2); margin-bottom:16px; }
        .notice-warn  { border-color:rgba(255,140,0,0.3); color:var(--accent2); }
        .notice-green { border-color:rgba(61,219,150,0.3); color:var(--green); background:rgba(61,219,150,0.05); }
        .link-btn     { background:none; border:none; color:var(--accent); cursor:pointer; font-size:inherit; text-decoration:underline; }
        .badge        { font-family:var(--font-mono); font-size:10px; padding:2px 8px; border-radius:12px; border:1px solid; }
        .badge-green  { color:var(--green); border-color:var(--green); }
        .badge-blue   { color:var(--blue); border-color:var(--blue); }
        .muted        { color:var(--muted2); }

        /* Lobby */
        .lobby-layout { display:grid; grid-template-columns:420px 1fr; gap:24px; align-items:start; }
        @media (max-width:960px) { .lobby-layout { grid-template-columns:1fr; } }
        .game-list { display:flex; flex-direction:column; gap:12px; }
        .game-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--r); padding:16px; transition:border-color 0.15s; }
        .game-card:hover { border-color:var(--border2); }
        .game-card-active { border-color:var(--accent)!important; box-shadow:0 0 16px rgba(255,68,68,0.15); }
        .game-card-top { display:flex; gap:14px; align-items:flex-start; }
        .game-emoji { font-size:28px; flex-shrink:0; }
        .game-info  { flex:1; }
        .game-title { font-weight:700; font-size:14px; margin-bottom:4px; }
        .game-desc  { font-size:12px; color:var(--muted2); line-height:1.4; }
        .game-meta  { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0; }
        .game-players { font-family:var(--font-mono); font-size:11px; color:var(--muted2); }
        .game-fee     { font-family:var(--font-mono); font-size:12px; color:var(--accent2); }
        .game-card-actions { margin-top:12px; padding-top:12px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; }
        .agent-selector    { margin-bottom:16px; }
        .field-label       { display:block; font-family:var(--font-mono); font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--muted2); margin-bottom:8px; }
        .agent-select-list { display:flex; flex-direction:column; gap:6px; }
        .agent-pick        { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:10px 12px; cursor:pointer; display:flex; align-items:center; gap:10px; text-align:left; transition:all 0.15s; }
        .agent-pick:hover  { border-color:var(--border2); }
        .agent-pick-active { border-color:var(--accent); background:rgba(255,68,68,0.05); }
        .agent-pick-name   { font-weight:700; font-size:13px; min-width:100px; }
        .agent-pick-desc   { flex:1; font-size:11px; color:var(--muted2); }
        .agent-pick-stats  { font-family:var(--font-mono); font-size:10px; color:var(--muted2); }

        /* Session */
        .session-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; min-height:300px; background:var(--surface); border:1px dashed var(--border); border-radius:var(--r); color:var(--muted2); text-align:center; padding:24px; }
        .session-panel { background:var(--surface); border:1px solid var(--border); border-radius:var(--r); padding:20px; display:flex; flex-direction:column; gap:16px; }
        .session-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .session-title  { font-family:var(--font-d); font-size:20px; letter-spacing:1px; }
        .session-status { font-size:12px; color:var(--muted2); margin-top:4px; }
        .session-pool   { text-align:right; flex-shrink:0; }
        .pool-label     { display:block; font-family:var(--font-mono); font-size:10px; color:var(--muted2); }
        .pool-value     { font-family:var(--font-d); font-size:22px; color:var(--accent2); }
        .player-row     { display:flex; align-items:center; justify-content:space-between; background:var(--surface2); border:1px solid var(--border); border-radius:6px; padding:8px 12px; }
        .player-me      { border-color:rgba(75,159,255,0.4); }
        .player-info    { display:flex; align-items:center; gap:8px; }
        .player-name    { font-weight:700; font-size:13px; }
        .player-wallet  { font-family:var(--font-mono); font-size:11px; color:var(--muted2); }
        .tx-link        { font-family:var(--font-mono); font-size:10px; color:var(--blue); }
        .tx-link:hover  { text-decoration:underline; }
        .progress-track { height:3px; background:var(--surface2); border-radius:2px; overflow:hidden; }
        .progress-fill  { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width 0.5s ease; }
        .results-box    { background:var(--surface2); border:1px solid var(--border); border-radius:var(--r); padding:16px; }
        .results-title  { font-family:var(--font-d); font-size:20px; letter-spacing:1px; margin-bottom:12px; }
        .result-row     { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border); }
        .result-row:last-child { border-bottom:none; }
        .chat-panel      { background:var(--surface2); border:1px solid var(--border); border-radius:var(--r); overflow:hidden; display:flex; flex-direction:column; }
        .chat-header-row { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--border); }
        .chat-label      { font-family:var(--font-mono); font-size:11px; letter-spacing:1px; color:var(--muted2); }
        .chat-badge      { font-family:var(--font-mono); font-size:10px; color:var(--muted2); }
        .chat-log        { overflow-y:auto; padding:10px 14px; display:flex; flex-direction:column; gap:6px; max-height:260px; }
        .chat-log::-webkit-scrollbar { width:3px; }
        .chat-log::-webkit-scrollbar-thumb { background:var(--border); }
        .chat-empty      { color:var(--muted2); font-family:var(--font-mono); font-size:11px; text-align:center; padding:24px 0; }
        .chat-entry      { display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:start; padding:6px 10px; border-radius:5px; background:var(--surface); border:1px solid var(--border); animation:fadein 0.2s ease; }
        @keyframes fadein { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        .chat-move   { border-color:rgba(255,68,68,0.25); }
        .chat-result { border-color:rgba(255,140,0,0.35); background:rgba(255,140,0,0.04); }
        .chat-system { border-color:rgba(61,219,150,0.2); }
        .chat-peer   { border-color:rgba(75,159,255,0.25); }
        .chat-join   { border-color:rgba(75,159,255,0.35); background:rgba(75,159,255,0.05); }
        .chat-sender  { font-family:var(--font-mono); font-size:10px; color:var(--muted2); white-space:nowrap; }
        .chat-content { font-size:12px; }
        .chat-time    { font-family:var(--font-mono); font-size:10px; color:var(--muted2); white-space:nowrap; }
        .spin { animation:rotate 1s linear infinite; display:inline-block; }
        @keyframes rotate { to{transform:rotate(360deg)} }

        /* Agents */
        .agents-page { max-width:900px; }
        .agents-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px; margin-top:16px; }
        .agent-full-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--r); padding:18px; display:flex; flex-direction:column; gap:10px; transition:border-color 0.15s; }
        .agent-full-card:hover { border-color:var(--border2); }
        .empty-state { display:flex; flex-direction:column; align-items:center; gap:16px; padding:60px; text-align:center; color:var(--muted2); }

        /* Dashboard */
        .dash-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; margin-bottom:8px; }
        .dash-card  { background:var(--surface); border:1px solid var(--border); border-radius:var(--r); padding:16px; }
        .dash-card-label { font-family:var(--font-mono); font-size:10px; color:var(--muted2); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px; }
        .dash-card-value { font-family:var(--font-d); font-size:22px; letter-spacing:1px; }
        .history-table { display:flex; flex-direction:column; border-radius:var(--r); overflow:hidden; border:1px solid var(--border); }
        .history-head  { display:grid; grid-template-columns:80px 1fr 70px 60px 70px 1fr; gap:8px; padding:8px 14px; background:var(--surface2); font-family:var(--font-mono); font-size:10px; color:var(--muted2); letter-spacing:1px; text-transform:uppercase; }
        .history-row   { display:grid; grid-template-columns:80px 1fr 70px 60px 70px 1fr; gap:8px; padding:10px 14px; background:var(--surface); font-size:13px; border-top:1px solid var(--border); }
        .history-row:hover { background:var(--surface2); }

        /* Modal */
        .modal-overlay { position:fixed; inset:0; z-index:100; background:rgba(7,9,12,0.85); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:20px; }
        .modal         { background:var(--surface); border:1px solid var(--border2); border-radius:12px; padding:24px; width:100%; max-width:440px; display:flex; flex-direction:column; gap:8px; }
        .field-input   { width:100%; background:var(--surface2); border:1px solid var(--border); border-radius:6px; padding:10px 14px; color:var(--text); font-family:var(--font-body); font-size:14px; transition:border-color 0.15s; outline:none; }
        .field-input:focus { border-color:var(--accent); }

        /* Footer */
        .clash-footer { position:relative; z-index:10; display:flex; align-items:center; justify-content:center; gap:10px; padding:16px 24px; border-top:1px solid var(--border); background:rgba(7,9,12,0.8); backdrop-filter:blur(8px); font-family:var(--font-mono); font-size:11px; color:var(--muted2); flex-wrap:wrap; text-align:center; }
      `}</style>
    </div>
  );
}

export default function Page() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ClashArena />
      </QueryClientProvider>
    </WagmiProvider>
  );
}