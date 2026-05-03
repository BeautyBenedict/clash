"use client";
// ============================================================
// app/page.tsx — Clash: Agent Arena
// © Beauty Benedict. All rights reserved.
// ETHGlobal Open Agents × Gensyn AXL
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
  loadAgents, saveAgents, loadHistory, saveHistory,
  buildChat, makeId, shortWallet,
  type UserAgent, type ChatEntry, type GameHistoryEntry,
} from "@/lib/axl";

// ── Types ─────────────────────────────────────────────────────
interface Player {
  walletAddress: string;
  agentName: string;
  agentDescription: string;
  score: number;
  roundWins: number;
  move?: string;
}
interface RoundResult {
  round: number;
  moves: Record<string, string>;
  roundScores: Record<string, number>;
  roundWinner: string;
  playerStandings: Array<{ agentName: string; walletAddress: string; score: number; roundScore: number }>;
}
interface FinalResult {
  rank: number;
  walletAddress: string;
  agentName: string;
  score: number;
  roundWins: number;
  prize: string;
  prizeEth: string;
}
interface Room {
  roomId: string;
  gameType: string;
  size: number;
  players: Player[];
  phase: "battle" | "results";
  currentRound: number;
  totalRounds: number;
  prizePool: number;
}

type Tab      = "lobby" | "my-agents" | "dashboard";
type AppPhase = "idle" | "queue" | "battle" | "results";

// ── Constants ─────────────────────────────────────────────────
const queryClient = new QueryClient();
const SOCKET_URL  = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";

const GAME_CONFIGS = [
  { id: "rps",        label: "Rock · Paper · Scissors", emoji: "✊", desc: "Agents pick moves based on personality" },
  { id: "quick-chat", label: "Quick Chat Battle",       emoji: "💬", desc: "Wit and personality decide the winner" },
  { id: "rps-blitz",  label: "Blitz RPS",               emoji: "⚡", desc: "Fast-paced 5-round battle" },
];

const ROOM_SIZES = [
  { size: 2, label: "1 v 1",  desc: "Fastest match" },
  { size: 5, label: "5-Way",  desc: "Mid arena" },
  { size: 8, label: "8-Way",  desc: "Full arena" },
];

const PRIZE_COLORS: Record<number, string> = { 1: "#FFD700", 2: "#C0C0C0", 3: "#CD7F32" };
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Socket singleton
let _socket: Socket | null = null;
function getSocket(): Socket {
  if (!_socket) {
    _socket = io(SOCKET_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 20,
    });
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

  const [socketConnected, setSocketConnected] = useState(false);
  const [tab, setTab]         = useState<Tab>("lobby");
  const [appPhase, setAppPhase] = useState<AppPhase>("idle");

  // Agents
  const [myAgents, setMyAgents]               = useState<UserAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [agentForm, setAgentForm]             = useState({ name: "", description: "" });
  const [formError, setFormError]             = useState("");
  const [history, setHistory]                 = useState<GameHistoryEntry[]>([]);

  // Game selection
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);

  // Queue
  const [queueMsg, setQueueMsg]       = useState("");
  const [queueCounts, setQueueCounts] = useState<Record<number, number>>({ 2: 0, 5: 0, 8: 0 });

  // Battle
  const [room, setRoom]               = useState<Room | null>(null);
  const [chatLog, setChatLog]         = useState<ChatEntry[]>([]);
  const [roundResults, setRoundResults] = useState<RoundResult[]>([]);
  const [finalResults, setFinalResults] = useState<FinalResult[]>([]);
  const [roundAnimating, setRoundAnimating] = useState(false);
  const [currentRound, setCurrentRound]     = useState(0);

  // Staking
  const { writeContract, data: txHash, isPending: isSending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txSuccess }     = useWaitForTransactionReceipt({ hash: txHash });
  const [hasPaid, setHasPaid] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load agents/history when wallet connects
  useEffect(() => {
    if (!address) { setMyAgents([]); setHistory([]); return; }
    setMyAgents(loadAgents(address));
    setHistory(loadHistory(address));
  }, [address]);

  // Socket setup
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setSocketConnected(true);
      ROOM_SIZES.forEach(s => {
        socket.emit("get_queue_status", { gameType: selectedGame ?? "rps", size: s.size });
      });
    };

    socket.on("connect",    onConnect);
    socket.on("disconnect", () => setSocketConnected(false));
    if (socket.connected) setSocketConnected(true);

    socket.on("queue_joined", (data: { waiting: number; size: number; message: string }) => {
      setQueueMsg(data.message);
      setQueueCounts(prev => ({ ...prev, [data.size]: data.waiting }));
      setAppPhase("queue");
      addChat("🏟️ Arena", data.message, "system");
    });

    socket.on("queue_update", (data: { waiting: number; size: number; message?: string }) => {
      if (data.size) setQueueCounts(prev => ({ ...prev, [data.size]: data.waiting }));
      if (data.message) setQueueMsg(data.message);
    });

    socket.on("matched", (data: { room: Room; message: string }) => {
      setRoom(data.room);
      setAppPhase("battle");
      setCurrentRound(0);
      setRoundResults([]);
      addChat("⚡ Arena", data.message, "join");
      data.room.players.forEach(p => {
        if (p.walletAddress !== address?.toLowerCase()) {
          addChat(`${p.agentName}`, `(${shortWallet(p.walletAddress)}) is ready!`, "join", p.walletAddress);
        }
      });
    });

    socket.on("round_start", (data: { round: number; totalRounds: number; message: string }) => {
      setCurrentRound(data.round);
      setRoundAnimating(true);
      addChat(`⚔️ Round ${data.round}`, data.message, "system");
    });

    socket.on("round_result", (result: RoundResult) => {
      setRoundAnimating(false);
      setRoundResults(prev => [...prev, result]);
      Object.entries(result.moves ?? {}).forEach(([wallet, move]) => {
        const player = result.playerStandings.find(p => p.walletAddress === wallet);
        if (move) addChat(player?.agentName ?? shortWallet(wallet), `played ${move.toUpperCase()}`, "move", wallet);
      });
      addChat(`🏆 Round ${result.round}`, `Winner: ${result.roundWinner}`, "result");
    });

    socket.on("game_over", (data: { finalResults: FinalResult[]; prizePool: number; totalRounds: number; roomId: string }) => {
      setFinalResults(data.finalResults);
      setAppPhase("results");
      const medals = ["🥇", "🥈", "🥉"];
      data.finalResults.slice(0, 3).forEach((r, i) => {
        addChat("🏆 Arena", `${medals[i]} ${r.agentName} — ${r.prize} (${r.prizeEth} ETH)`, "result");
      });

      // Save to history
      if (address) {
        const myResult = data.finalResults.find(r => r.walletAddress === address.toLowerCase());
        if (myResult) {
          const updatedAgents = myAgents.map(a => ({
            ...a,
            wins:   a.wins   + (myResult.rank === 1 ? 1 : 0),
            losses: a.losses + (myResult.rank > 3  ? 1 : 0),
            draws:  a.draws  + (myResult.rank > 1 && myResult.rank <= 3 ? 1 : 0),
          }));
          setMyAgents(updatedAgents);
          saveAgents(address, updatedAgents);
          const h: GameHistoryEntry = {
            sessionId: data.roomId,
            gameType: (selectedGame ?? "rps") as "rps" | "quick-chat",
            agentName: myResult.agentName,
            rank: myResult.rank,
            prize: myResult.prize,
            playedAt: Date.now(),
            players: data.finalResults.length,
          };
          const updated = [h, ...history].slice(0, 50);
          setHistory(updated);
          saveHistory(address, updated);
        }
      }
    });

    socket.on("game_event", (event: { agentName: string; walletAddress: string; content: string }) => {
      if (event.walletAddress !== address?.toLowerCase()) {
        addChat(event.agentName, event.content, "peer", event.walletAddress);
      }
    });

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect");
      socket.off("queue_joined");
      socket.off("queue_update");
      socket.off("matched");
      socket.off("round_start");
      socket.off("round_result");
      socket.off("game_over");
      socket.off("game_event");
    };
  }, [address, myAgents, history, selectedGame]);

  // After stake confirms, join queue
  useEffect(() => {
    if (txSuccess) {
      setHasPaid(true);
      joinQueue();
    }
  }, [txSuccess]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog]);

  function addChat(sender: string, content: string, type: ChatEntry["type"] = "system", wallet?: string) {
    setChatLog(prev => [...prev, buildChat(sender, content, type, wallet)]);
  }

  // Agent management
  function handleCreateAgent() {
    if (!address) return;
    const name = agentForm.name.trim();
    const desc = agentForm.description.trim();
    if (!name) { setFormError("Agent needs a name."); return; }
    if (!desc)  { setFormError("Give your agent a personality."); return; }
    if (name.length > 30) { setFormError("Name max 30 characters."); return; }
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

  function joinQueue() {
    if (!address || !selectedAgentId || !selectedGame || !selectedSize) return;
    const agent = myAgents.find(a => a.id === selectedAgentId);
    if (!agent) return;
    setChatLog([]); setRoundResults([]); setFinalResults([]); setRoom(null);
    getSocket().emit("join_queue", {
      gameType: selectedGame,
      size: selectedSize,
      walletAddress: address.toLowerCase(),
      agentName: agent.name,
      agentDescription: agent.description,
    });
  }

  function handleEnterArena() {
    if (!isConnected || !selectedGame || !selectedSize || !selectedAgentId) return;

    // If contract deployed → pay first, then join queue after tx confirms
    if (CLASH_CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      writeContract({
        address: CLASH_CONTRACT_ADDRESS,
        abi: CLASH_ABI,
        functionName: "joinGame",
        args: [`${selectedGame}-${selectedSize}`],
        value: parseEther(ENTRY_FEE_ETH),
        chainId: baseSepolia.id,
      });
    } else {
      // No contract yet — join queue directly (demo mode)
      joinQueue();
    }
  }

  function handleLeave() {
    if (address) getSocket().emit("leave", { walletAddress: address.toLowerCase() });
    setAppPhase("idle");
    setRoom(null);
    setChatLog([]);
    setRoundResults([]);
    setFinalResults([]);
    setHasPaid(false);
    setQueueMsg("");
  }

  // Derived
  const selectedAgent = myAgents.find(a => a.id === selectedAgentId);
  const myFinalResult = finalResults.find(r => r.walletAddress === address?.toLowerCase());
  const contractReady = CLASH_CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000";

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
          {isConnected ? (
            <div className="wallet-chip">
              <div className="wallet-info">
                <span className="wallet-addr">{shortWallet(address!)}</span>
                {balanceData && (
                  <span className="wallet-bal">{parseFloat(formatEther(balanceData.value)).toFixed(4)} ETH</span>
                )}
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

      <main className="clash-body">

        {/* ════════ LOBBY ════════ */}
        {tab === "lobby" && appPhase === "idle" && (
          <div className="lobby-layout">

            {/* LEFT */}
            <div className="lobby-left">
              <h2 className="section-title">Choose Your Battle</h2>

              {!isConnected && (
                <div className="notice">
                  Connect your wallet to enter the arena.
                </div>
              )}

              {isConnected && myAgents.length === 0 && (
                <div className="notice notice-warn">
                  You have no agents yet.{" "}
                  <button className="link-btn" onClick={() => setTab("my-agents")}>Create one →</button>
                </div>
              )}

              {/* 1. Pick agent */}
              {isConnected && myAgents.length > 0 && (
                <div className="select-section">
                  <div className="select-label">1. Select your agent</div>
                  {myAgents.map(a => (
                    <button key={a.id}
                      className={`agent-pick ${selectedAgentId === a.id ? "agent-pick-active" : ""}`}
                      onClick={() => setSelectedAgentId(a.id)}>
                      <div className="ap-left">
                        <span className="ap-name">{a.name}</span>
                        <span className="ap-desc">{a.description.slice(0, 55)}{a.description.length > 55 ? "…" : ""}</span>
                      </div>
                      <span className="ap-stats">W:{a.wins} L:{a.losses}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* 2. Pick game */}
              {isConnected && selectedAgentId && (
                <div className="select-section">
                  <div className="select-label">2. Select game type</div>
                  {GAME_CONFIGS.map(g => (
                    <button key={g.id}
                      className={`game-pick ${selectedGame === g.id ? "game-pick-active" : ""}`}
                      onClick={() => setSelectedGame(g.id)}>
                      <span className="gp-emoji">{g.emoji}</span>
                      <div className="gp-info">
                        <span className="gp-label">{g.label}</span>
                        <span className="gp-desc">{g.desc}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* 3. Pick room size */}
              {isConnected && selectedGame && (
                <div className="select-section">
                  <div className="select-label">3. Select room size</div>
                  <div className="size-row">
                    {ROOM_SIZES.map(s => (
                      <button key={s.size}
                        className={`size-card ${selectedSize === s.size ? "size-card-active" : ""}`}
                        onClick={() => setSelectedSize(s.size)}>
                        <div className="size-counter">
                          <span className="sc-waiting">{queueCounts[s.size] ?? 0}</span>
                          <span className="sc-sep">/</span>
                          <span className="sc-total">{s.size}</span>
                        </div>
                        <span className="size-name">{s.label}</span>
                        <span className="size-pool">{(s.size * 0.001).toFixed(3)} ETH pool</span>
                        <span className="size-hint">{s.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 4. Enter */}
              {isConnected && selectedAgent && selectedGame && selectedSize && (
                <div className="select-section entry-section">
                  <div className="entry-summary">
                    <span>Agent: <strong>{selectedAgent.name}</strong></span>
                    <span>Game: <strong>{GAME_CONFIGS.find(g => g.id === selectedGame)?.label}</strong></span>
                    <span>Room: <strong>{selectedSize} players</strong></span>
                    <span>Entry fee: <strong>{ENTRY_FEE_ETH} ETH</strong></span>
                    <span>Prize pool: <strong>{(selectedSize * 0.001).toFixed(3)} ETH</strong></span>
                  </div>

                  {!contractReady && (
                    <div className="notice notice-warn" style={{margin:"0 0 8px"}}>
                      Contract not deployed — running in demo mode (no real ETH)
                    </div>
                  )}

                  <button className="btn btn-battle w-full"
                    onClick={handleEnterArena}
                    disabled={isSending || isConfirming}>
                    {isSending    ? "⏳ Confirm in MetaMask…"
                    : isConfirming ? "⏳ Confirming on-chain…"
                    : contractReady ? `⚡ Pay ${ENTRY_FEE_ETH} ETH & Enter Arena`
                    : "⚡ Enter Arena (Demo)"}
                  </button>

                  {txHash && (
                    <a className="tx-link" href={`https://sepolia.basescan.org/tx/${txHash}`}
                      target="_blank" rel="noreferrer">
                      View transaction ↗
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* RIGHT: idle state */}
            <div className="lobby-right">
              <div className="idle-panel">
                <span className="idle-icon">⚔️</span>
                <p className="idle-title">Arena is ready</p>
                <p className="idle-sub">
                  Select an agent, pick a game, choose your room size, then enter the arena.
                  When enough players join the same room, battle begins automatically.
                </p>
                <div className="idle-steps">
                  <div className="idle-step"><span className="step-n">1</span> Create or select an agent</div>
                  <div className="idle-step"><span className="step-n">2</span> Choose a game type</div>
                  <div className="idle-step"><span className="step-n">3</span> Pick room size (1v1, 5-way, 8-way)</div>
                  <div className="idle-step"><span className="step-n">4</span> Pay entry fee &amp; enter</div>
                  <div className="idle-step"><span className="step-n">5</span> Wait for opponent — battle starts!</div>
                </div>
                <div className={`server-status ${socketConnected ? "ss-live" : "ss-offline"}`}>
                  <span className="ss-dot" />
                  {socketConnected ? "Server connected — multiplayer ready" : "Server offline — check Railway"}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════ QUEUE ════════ */}
        {tab === "lobby" && appPhase === "queue" && (
          <div className="center-screen">
            <div className="phase-card">
              <div className="phase-icon">🔍</div>
              <h2 className="phase-h">Finding Opponent…</h2>
              <div className="queue-progress">
                <div className="qp-fill" style={{ width: `${((queueCounts[selectedSize ?? 2] ?? 0) / (selectedSize ?? 2)) * 100}%` }} />
              </div>
              <div className="queue-num">
                {queueCounts[selectedSize ?? 2] ?? 0} / {selectedSize} players
              </div>
              <p className="phase-sub">{queueMsg}</p>
              {selectedAgent && (
                <div className="agent-preview">
                  <span className="ap-prev-name">{selectedAgent.name}</span>
                  <span className="ap-prev-desc">{selectedAgent.description.slice(0, 80)}…</span>
                </div>
              )}
              <button className="btn btn-ghost w-full" onClick={handleLeave}>🚪 Leave Queue</button>
            </div>
          </div>
        )}

        {/* ════════ BATTLE ════════ */}
        {tab === "lobby" && appPhase === "battle" && room && (
          <div className="battle-layout">
            <div className="battle-left">
              {/* Header */}
              <div className="battle-top">
                <div>
                  <div className="battle-title">
                    {GAME_CONFIGS.find(g => g.id === room.gameType)?.emoji}{" "}
                    {GAME_CONFIGS.find(g => g.id === room.gameType)?.label}
                  </div>
                  <div className="battle-sub">
                    Round {currentRound || "—"} of {room.totalRounds} · {room.players.length} agents
                  </div>
                </div>
                <div className="pool-box">
                  <span className="pool-label">Prize Pool</span>
                  <span className="pool-val">{room.prizePool.toFixed(3)} ETH</span>
                </div>
              </div>

              {/* Round dots */}
              <div className="round-dots">
                {Array.from({ length: room.totalRounds }).map((_, i) => {
                  const rr = roundResults[i];
                  const myWin = rr?.roundWinner === room.players.find(p => p.walletAddress === address?.toLowerCase())?.agentName;
                  return (
                    <div key={i} className={`rd ${!rr ? (i === currentRound - 1 ? "rd-active" : "rd-pending") : myWin ? "rd-win" : "rd-lose"}`}>
                      {rr ? (myWin ? "✓" : "✗") : i + 1}
                    </div>
                  );
                })}
              </div>

              {/* Scoreboard */}
              <div className="scoreboard">
                <div className="sb-head">Scoreboard</div>
                {[...room.players].sort((a, b) => b.score - a.score).map((p, idx) => {
                  const isMe = p.walletAddress === address?.toLowerCase();
                  return (
                    <div key={p.walletAddress} className={`sb-row ${isMe ? "sb-me" : ""}`}>
                      <span className="sb-rank">#{idx + 1}</span>
                      <span className="sb-name">{p.agentName}{isMe ? " (you)" : ""}</span>
                      <span className="sb-wallet muted">{shortWallet(p.walletAddress)}</span>
                      <span className="sb-score">{p.score}pts</span>
                    </div>
                  );
                })}
              </div>

              {/* Last round */}
              {roundResults.length > 0 && (() => {
                const last = roundResults[roundResults.length - 1];
                return (
                  <div className="last-round">
                    <div className="lr-head">Round {last.round} result — {last.roundWinner} wins</div>
                    {last.playerStandings.map(p => (
                      <div key={p.walletAddress} className="lr-row">
                        <span>{p.agentName}</span>
                        {last.moves[p.walletAddress] && (
                          <span className="lr-move">{last.moves[p.walletAddress].toUpperCase()}</span>
                        )}
                        <span className="muted" style={{fontFamily:"var(--font-mono)",fontSize:12}}>+{p.roundScore}pts</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {roundAnimating && (
                <div className="animating-row">
                  <span className="spin">⚙</span> Agents are choosing their moves…
                </div>
              )}
            </div>

            {/* RIGHT: chat */}
            <div className="battle-right">
              <div className="chat-wrap">
                <div className="chat-head">
                  <span className="chat-label">⚔️ Battle Feed</span>
                  <span className="chat-badge">🟢 Live</span>
                </div>
                <div className="chat-log">
                  {chatLog.length === 0 && <div className="chat-empty">Battle starting…</div>}
                  {chatLog.map(e => (
                    <div key={e.id} className={`chat-entry chat-${e.type}`}>
                      <span className="chat-sender">{e.sender}</span>
                      <span className="chat-content">{e.content}</span>
                      <span className="chat-time">{fmtTime(e.timestamp)}</span>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════ RESULTS ════════ */}
        {tab === "lobby" && appPhase === "results" && (
          <div className="center-screen">
            <div className="results-card">
              <div className="results-h">🏆 Battle Complete</div>

              {myFinalResult && (
                <div className={`my-result ${myFinalResult.rank === 1 ? "my-win" : ""}`}>
                  <span>{myFinalResult.rank === 1 ? "🥇 You Won!" : myFinalResult.rank === 2 ? "🥈 2nd Place" : myFinalResult.rank === 3 ? "🥉 3rd Place" : `#${myFinalResult.rank} Place`}</span>
                  <span className="muted" style={{fontFamily:"var(--font-mono)",fontSize:13}}>{myFinalResult.prizeEth} ETH · {myFinalResult.prize}</span>
                </div>
              )}

              <div className="final-list">
                {finalResults.map(r => (
                  <div key={r.walletAddress} className="final-row">
                    <span style={{fontSize:18,color:PRIZE_COLORS[r.rank]??"#aaa",width:28}}>
                      {r.rank===1?"🥇":r.rank===2?"🥈":r.rank===3?"🥉":`#${r.rank}`}
                    </span>
                    <span style={{flex:1,fontWeight:700}}>{r.agentName}</span>
                    <span className="muted" style={{fontFamily:"var(--font-mono)",fontSize:11}}>{shortWallet(r.walletAddress)}</span>
                    <span className="muted" style={{fontFamily:"var(--font-mono)",fontSize:11}}>{r.score}pts</span>
                    <span style={{fontFamily:"var(--font-d)",fontSize:18,color:PRIZE_COLORS[r.rank]??"var(--muted2)"}}>{r.prize}</span>
                    <span className="muted" style={{fontFamily:"var(--font-mono)",fontSize:11}}>{r.prizeEth} ETH</span>
                  </div>
                ))}
              </div>

              {roundResults.length > 0 && (
                <details className="breakdown">
                  <summary>Round by round breakdown</summary>
                  {roundResults.map(rr => (
                    <div key={rr.round} className="bk-round">
                      <div className="bk-head">Round {rr.round} — {rr.roundWinner} wins</div>
                      {rr.playerStandings.map(p => (
                        <div key={p.walletAddress} className="bk-row">
                          <span>{p.agentName}</span>
                          {rr.moves[p.walletAddress] && <span className="lr-move">{rr.moves[p.walletAddress]}</span>}
                          <span className="muted">+{p.roundScore}pts</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </details>
              )}

              <div style={{display:"flex",gap:10,marginTop:8}}>
                <button className="btn btn-primary" style={{flex:1}} onClick={() => {
                  setAppPhase("idle");
                  setSelectedGame(null);
                  setSelectedSize(null);
                  setHasPaid(false);
                  setFinalResults([]);
                  setRoundResults([]);
                  setChatLog([]);
                }}>🔄 Play Again</button>
                <button className="btn btn-ghost" style={{flex:1}} onClick={handleLeave}>Back to Lobby</button>
              </div>
            </div>
          </div>
        )}

        {/* ════════ MY AGENTS ════════ */}
        {tab === "my-agents" && (
          <div className="agents-page">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
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
                <div key={agent.id} className="agent-card">
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontWeight:800,fontSize:16}}>{agent.name}</span>
                    <button className="btn btn-ghost btn-xs danger" onClick={() => handleDeleteAgent(agent.id)}>✕</button>
                  </div>
                  <p style={{fontSize:13,color:"var(--muted2)",lineHeight:1.5,marginTop:6}}>{agent.description}</p>
                  <div style={{display:"flex",gap:12,fontFamily:"var(--font-mono)",fontSize:12,marginTop:8}}>
                    <span style={{color:"var(--green)"}}>W: {agent.wins}</span>
                    <span style={{color:"var(--accent)"}}>L: {agent.losses}</span>
                    <span className="muted">D: {agent.draws}</span>
                  </div>
                  <div className="muted" style={{fontFamily:"var(--font-mono)",fontSize:10,marginTop:4}}>Created {fmtDate(agent.createdAt)}</div>
                  <button className="btn btn-join w-full" style={{marginTop:10}}
                    onClick={() => { setSelectedAgentId(agent.id); setTab("lobby"); }}>
                    Deploy to Arena →
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════════ DASHBOARD ════════ */}
        {tab === "dashboard" && (
          <div style={{maxWidth:900}}>
            <h2 className="section-title">My Dashboard</h2>
            {!isConnected ? (
              <div className="notice">Connect your wallet to view your dashboard.</div>
            ) : (
              <>
                <div className="dash-cards">
                  {[
                    { label: "Wallet",       value: shortWallet(address!),    style: {fontSize:13,fontFamily:"var(--font-mono)"} },
                    { label: "Balance",      value: balanceData ? `${parseFloat(formatEther(balanceData.value)).toFixed(5)} ETH` : "…", sub: "Base Sepolia" },
                    { label: "Agents",       value: String(myAgents.length) },
                    { label: "Games Played", value: String(history.length) },
                    { label: "Total Wins",   value: String(myAgents.reduce((s,a)=>s+a.wins,0)), style: {color:"var(--green)"} },
                  ].map(c => (
                    <div key={c.label} className="dash-card">
                      <div className="dash-label">{c.label}</div>
                      <div className="dash-val" style={c.style ?? {}}>{c.value}</div>
                      {c.sub && <div className="muted" style={{fontSize:11,marginTop:4}}>{c.sub}</div>}
                    </div>
                  ))}
                </div>
                <h3 style={{fontFamily:"var(--font-d)",fontSize:18,letterSpacing:1,margin:"24px 0 12px"}}>Game History</h3>
                {history.length === 0 ? <div className="notice">No games yet.</div> : (
                  <div className="history-table">
                    <div className="hist-head">
                      <span>Game</span><span>Agent</span><span>Players</span><span>Rank</span><span>Prize</span><span>Date</span>
                    </div>
                    {history.map(h => (
                      <div key={h.sessionId+h.playedAt} className="hist-row">
                        <span style={{fontFamily:"var(--font-mono)",fontSize:11}}>{h.gameType==="rps"?"✊ RPS":"💬 Chat"}</span>
                        <span>{h.agentName}</span>
                        <span>{h.players}</span>
                        <span style={{color:PRIZE_COLORS[h.rank]??"var(--muted2)"}}>#{h.rank}</span>
                        <span style={{color:PRIZE_COLORS[h.rank]??"var(--muted2)"}}>{h.prize}</span>
                        <span className="muted" style={{fontSize:11}}>{fmtDate(h.playedAt)}</span>
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
        <span className="muted">·</span>
        <span>ETHGlobal Open Agents × Gensyn AXL</span>
      </footer>

      {/* CREATE AGENT MODAL */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <span style={{fontFamily:"var(--font-d)",fontSize:22,letterSpacing:2}}>Create Agent</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <label className="field-label">Agent Name</label>
            <input className="field-input" placeholder="e.g. Shadow Hawk" maxLength={30}
              value={agentForm.name} onChange={e => setAgentForm(f=>({...f,name:e.target.value}))} />
            <label className="field-label" style={{marginTop:12}}>
              Personality / Strategy
              <span style={{display:"block",fontSize:11,color:"var(--muted2)",fontWeight:400,textTransform:"none",letterSpacing:0,marginTop:3}}>
                This is your agent's fighting style — it affects how they play every round.
              </span>
            </label>
            <textarea className="field-input" style={{resize:"vertical",minHeight:90,marginTop:4}} rows={4} maxLength={300}
              placeholder="e.g. Aggressive risk-taker who always picks rock and never backs down."
              value={agentForm.description} onChange={e => setAgentForm(f=>({...f,description:e.target.value}))} />
            {formError && <div style={{fontSize:12,color:"var(--accent)",padding:"4px 0"}}>{formError}</div>}
            <button className="btn btn-primary w-full" style={{marginTop:16}} onClick={handleCreateAgent}>
              Create Agent
            </button>
          </div>
        </div>
      )}

      {/* STYLES */}
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=Cabinet+Grotesk:wght@400;500;700;800&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        :root{
          --bg:#07090C;--surface:#0D1117;--surface2:#131920;--surface3:#1A2230;
          --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);
          --accent:#FF4444;--accent2:#FF8C00;--green:#3DDB96;--blue:#4B9FFF;
          --text:#E2E8F0;--muted:#4A5568;--muted2:#718096;
          --font-d:'Bebas Neue',sans-serif;
          --font-mono:'DM Mono',monospace;
          --font-body:'Cabinet Grotesk',sans-serif;
          --r:8px;
        }
        html,body{height:100%;background:var(--bg);color:var(--text);}
        body{font-family:var(--font-body);font-size:14px;line-height:1.6;overflow-x:hidden;}
        a{color:inherit;text-decoration:none;}
        .clash-root{min-height:100vh;display:flex;flex-direction:column;position:relative;}
        .grid-bg{position:fixed;inset:0;z-index:0;pointer-events:none;
          background-image:linear-gradient(rgba(255,68,68,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,68,68,0.025) 1px,transparent 1px);
          background-size:44px 44px;}

        /* Header */
        .clash-header{position:relative;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 24px;border-bottom:1px solid var(--border);background:rgba(7,9,12,0.92);backdrop-filter:blur(16px);flex-wrap:wrap;}
        .header-brand{display:flex;align-items:center;gap:10px;flex-shrink:0;}
        .header-logo{border-radius:6px;object-fit:contain;}
        .header-title{font-family:var(--font-d);font-size:30px;letter-spacing:3px;color:var(--accent);line-height:1;}
        .header-sub{font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:2px;border:1px solid var(--border);border-radius:4px;padding:2px 8px;}
        .header-nav{display:flex;gap:4px;}
        .nav-btn{background:none;border:1px solid transparent;border-radius:6px;color:var(--muted2);font-family:var(--font-body);font-size:13px;padding:6px 14px;cursor:pointer;transition:all 0.15s;}
        .nav-btn:hover{color:var(--text);border-color:var(--border2);}
        .nav-active{color:var(--text)!important;background:var(--surface2)!important;border-color:var(--border2)!important;}
        .header-right{display:flex;align-items:center;gap:10px;}
        .wallet-chip{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border2);border-radius:8px;padding:6px 12px;}
        .wallet-info{display:flex;flex-direction:column;gap:1px;}
        .wallet-addr{font-family:var(--font-mono);font-size:12px;}
        .wallet-bal{font-family:var(--font-mono);font-size:11px;color:var(--green);}
        .wallet-chain{font-size:10px;color:var(--muted2);}
        .status-pill{display:flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;padding:5px 12px;border-radius:20px;border:1px solid;}
        .pill-green{border-color:var(--green);color:var(--green);}
        .pill-red{border-color:var(--accent);color:var(--accent);}
        .pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s infinite;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

        /* Body */
        .clash-body{position:relative;z-index:1;flex:1;padding:24px;max-width:1400px;margin:0 auto;width:100%;}
        .section-title{font-family:var(--font-d);font-size:24px;letter-spacing:2px;margin-bottom:16px;}
        .muted{color:var(--muted2);}
        .w-full{width:100%;}

        /* Buttons */
        .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:var(--font-mono);font-size:13px;padding:9px 18px;border-radius:var(--r);border:1px solid transparent;cursor:pointer;transition:all 0.15s;white-space:nowrap;}
        .btn:disabled{opacity:0.4;cursor:not-allowed;}
        .btn-primary{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700;}
        .btn-primary:hover:not(:disabled){background:#e03333;}
        .btn-ghost{background:transparent;color:var(--muted2);border-color:var(--border);}
        .btn-ghost:hover:not(:disabled){color:var(--text);border-color:var(--border2);}
        .btn-ghost.danger:hover{color:var(--accent);border-color:var(--accent);}
        .btn-xs{padding:4px 8px;font-size:11px;}
        .btn-join{background:var(--surface3);color:var(--text);border-color:var(--border2);}
        .btn-join:hover:not(:disabled){border-color:var(--accent);color:var(--accent);}
        .btn-battle{background:linear-gradient(135deg,var(--accent) 0%,#cc0000 100%);color:#fff;font-size:16px;font-family:var(--font-d);letter-spacing:2px;padding:16px;box-shadow:0 0 24px rgba(255,68,68,0.2);}
        .btn-battle:hover:not(:disabled){box-shadow:0 0 36px rgba(255,68,68,0.45);}

        /* Notices */
        .notice{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:14px 18px;font-size:13px;color:var(--muted2);margin-bottom:12px;}
        .notice-warn{border-color:rgba(255,140,0,0.3);color:var(--accent2);}
        .link-btn{background:none;border:none;color:var(--accent);cursor:pointer;font-size:inherit;text-decoration:underline;}
        .tx-link{font-family:var(--font-mono);font-size:11px;color:var(--blue);text-align:center;display:block;margin-top:6px;}
        .tx-link:hover{text-decoration:underline;}

        /* Lobby layout */
        .lobby-layout{display:grid;grid-template-columns:440px 1fr;gap:24px;align-items:start;}
        @media(max-width:900px){.lobby-layout{grid-template-columns:1fr;}}
        .lobby-left{display:flex;flex-direction:column;gap:16px;}
        .lobby-right{position:sticky;top:24px;}

        /* Selection sections */
        .select-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:8px;}
        .select-label{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px;}
        .field-label{display:block;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:6px;}

        /* Agent picker */
        .agent-pick{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;transition:all 0.15s;width:100%;}
        .agent-pick:hover{border-color:var(--border2);}
        .agent-pick-active{border-color:var(--accent)!important;background:rgba(255,68,68,0.06)!important;}
        .ap-left{display:flex;flex-direction:column;gap:3px;flex:1;}
        .ap-name{font-weight:700;font-size:14px;}
        .ap-desc{font-size:11px;color:var(--muted2);}
        .ap-stats{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}

        /* Game picker */
        .game-pick{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;text-align:left;transition:all 0.15s;width:100%;}
        .game-pick:hover{border-color:var(--border2);}
        .game-pick-active{border-color:var(--accent)!important;background:rgba(255,68,68,0.06)!important;}
        .gp-emoji{font-size:22px;flex-shrink:0;}
        .gp-info{display:flex;flex-direction:column;gap:2px;}
        .gp-label{font-weight:700;font-size:14px;}
        .gp-desc{font-size:11px;color:var(--muted2);}

        /* Room size cards */
        .size-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;}
        .size-row::-webkit-scrollbar{height:3px;}
        .size-row::-webkit-scrollbar-thumb{background:var(--border2);}
        .size-card{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:14px 12px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all 0.15s;min-width:120px;flex-shrink:0;}
        .size-card:hover{border-color:var(--border2);}
        .size-card-active{border-color:var(--accent)!important;background:rgba(255,68,68,0.08)!important;}
        .size-counter{display:flex;align-items:baseline;gap:2px;}
        .sc-waiting{font-family:var(--font-d);font-size:30px;color:var(--accent2);line-height:1;}
        .sc-sep{font-family:var(--font-d);font-size:20px;color:var(--muted2);}
        .sc-total{font-family:var(--font-d);font-size:30px;color:var(--text);line-height:1;}
        .size-name{font-family:var(--font-mono);font-size:11px;letter-spacing:1px;color:var(--muted2);text-transform:uppercase;}
        .size-pool{font-family:var(--font-mono);font-size:10px;color:var(--accent2);}
        .size-hint{font-size:10px;color:var(--muted2);text-align:center;}

        /* Entry section */
        .entry-section{}
        .entry-summary{display:flex;flex-direction:column;gap:4px;font-size:13px;padding:12px;background:var(--surface2);border-radius:6px;margin-bottom:10px;}
        .entry-summary span{color:var(--muted2);}
        .entry-summary strong{color:var(--text);}

        /* Idle panel */
        .idle-panel{background:var(--surface);border:1px dashed var(--border2);border-radius:var(--r);padding:32px 24px;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;min-height:360px;justify-content:center;}
        .idle-icon{font-size:48px;}
        .idle-title{font-family:var(--font-d);font-size:22px;letter-spacing:2px;}
        .idle-sub{font-size:13px;color:var(--muted2);max-width:360px;line-height:1.6;}
        .idle-steps{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;}
        .idle-step{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted2);}
        .step-n{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;}
        .server-status{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:11px;padding:8px 12px;border-radius:20px;border:1px solid;}
        .ss-live{border-color:var(--green);color:var(--green);}
        .ss-offline{border-color:var(--accent);color:var(--accent);}
        .ss-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}

        /* Center screen (queue + results) */
        .center-screen{display:flex;align-items:center;justify-content:center;min-height:60vh;}
        .phase-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;max-width:480px;width:100%;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;}
        .phase-icon{font-size:48px;animation:pulse-s 1.5s ease-in-out infinite;}
        @keyframes pulse-s{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
        .phase-h{font-family:var(--font-d);font-size:28px;letter-spacing:2px;}
        .phase-sub{font-size:13px;color:var(--muted2);}
        .queue-progress{width:100%;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;}
        .qp-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width 0.5s ease;border-radius:4px;}
        .queue-num{font-family:var(--font-d);font-size:32px;letter-spacing:2px;color:var(--accent2);}
        .agent-preview{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;}
        .ap-prev-name{font-weight:700;font-size:15px;}
        .ap-prev-desc{font-size:12px;color:var(--muted2);}

        /* Battle */
        .battle-layout{display:grid;grid-template-columns:1fr 360px;gap:24px;align-items:start;}
        @media(max-width:900px){.battle-layout{grid-template-columns:1fr;}}
        .battle-left{display:flex;flex-direction:column;gap:14px;}
        .battle-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
        .battle-title{font-family:var(--font-d);font-size:24px;letter-spacing:2px;}
        .battle-sub{font-size:12px;color:var(--muted2);margin-top:4px;}
        .pool-box{text-align:right;flex-shrink:0;}
        .pool-label{display:block;font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
        .pool-val{font-family:var(--font-d);font-size:24px;color:var(--accent2);}
        .round-dots{display:flex;gap:8px;flex-wrap:wrap;}
        .rd{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:12px;border:2px solid;transition:all 0.3s;}
        .rd-pending{border-color:var(--border);color:var(--muted2);}
        .rd-active{border-color:var(--accent);color:var(--accent);animation:pulse 1s infinite;}
        .rd-win{border-color:var(--green);background:rgba(61,219,150,0.15);color:var(--green);}
        .rd-lose{border-color:var(--muted);color:var(--accent);}
        .scoreboard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;}
        .sb-head{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
        .sb-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);}
        .sb-row:last-child{border-bottom:none;}
        .sb-me{background:rgba(75,159,255,0.05);border-radius:4px;padding:6px 8px;margin:0 -8px;}
        .sb-rank{font-family:var(--font-mono);font-size:11px;color:var(--muted2);width:24px;}
        .sb-name{flex:1;font-weight:700;font-size:13px;}
        .sb-wallet{font-family:var(--font-mono);font-size:11px;}
        .sb-score{font-family:var(--font-d);font-size:18px;color:var(--accent2);}
        .last-round{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px;}
        .lr-head{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--accent2);margin-bottom:8px;}
        .lr-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;}
        .lr-move{font-family:var(--font-mono);font-size:11px;background:var(--surface3);padding:2px 8px;border-radius:4px;color:var(--accent2);}
        .animating-row{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:13px;color:var(--accent2);padding:12px;background:var(--surface);border-radius:var(--r);border:1px solid var(--border);}

        /* Battle right chat */
        .battle-right{position:sticky;top:24px;}
        .chat-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;height:calc(100vh - 160px);}
        .chat-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;}
        .chat-label{font-family:var(--font-mono);font-size:11px;letter-spacing:1px;color:var(--muted2);}
        .chat-badge{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
        .chat-log{overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:6px;flex:1;}
        .chat-log::-webkit-scrollbar{width:3px;}
        .chat-log::-webkit-scrollbar-thumb{background:var(--border);}
        .chat-empty{color:var(--muted2);font-family:var(--font-mono);font-size:11px;text-align:center;padding:24px 0;}
        .chat-entry{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;padding:6px 10px;border-radius:5px;background:var(--surface2);border:1px solid var(--border);animation:fi 0.2s ease;}
        @keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        .chat-move{border-color:rgba(255,68,68,0.25);}
        .chat-result{border-color:rgba(255,140,0,0.35);background:rgba(255,140,0,0.04);}
        .chat-system{border-color:rgba(61,219,150,0.2);}
        .chat-peer{border-color:rgba(75,159,255,0.25);}
        .chat-join{border-color:rgba(75,159,255,0.35);background:rgba(75,159,255,0.05);}
        .chat-sender{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}
        .chat-content{font-size:12px;}
        .chat-time{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}
        .spin{animation:rot 1s linear infinite;display:inline-block;}
        @keyframes rot{to{transform:rotate(360deg)}}

        /* Results */
        .results-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;max-width:600px;width:100%;display:flex;flex-direction:column;gap:14px;}
        .results-h{font-family:var(--font-d);font-size:32px;letter-spacing:3px;text-align:center;}
        .my-result{background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:15px;}
        .my-win{border-color:var(--green);background:rgba(61,219,150,0.08);color:var(--green);}
        .final-list{display:flex;flex-direction:column;gap:8px;}
        .final-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:var(--r);border:1px solid var(--border);}
        .breakdown{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px;}
        .breakdown summary{cursor:pointer;font-family:var(--font-mono);font-size:12px;color:var(--muted2);}
        .bk-round{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);}
        .bk-head{font-family:var(--font-mono);font-size:11px;color:var(--accent2);margin-bottom:6px;}
        .bk-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;}

        /* Agents */
        .agents-page{max-width:900px;}
        .agents-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:4px;}
        .agent-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;transition:border-color 0.15s;}
        .agent-card:hover{border-color:var(--border2);}
        .empty-state{display:flex;flex-direction:column;align-items:center;gap:16px;padding:60px;text-align:center;color:var(--muted2);}

        /* Dashboard */
        .dash-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:8px;}
        .dash-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;}
        .dash-label{font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;}
        .dash-val{font-family:var(--font-d);font-size:22px;letter-spacing:1px;}
        .history-table{display:flex;flex-direction:column;border-radius:var(--r);overflow:hidden;border:1px solid var(--border);}
        .hist-head{display:grid;grid-template-columns:80px 1fr 70px 60px 70px 1fr;gap:8px;padding:8px 14px;background:var(--surface2);font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase;}
        .hist-row{display:grid;grid-template-columns:80px 1fr 70px 60px 70px 1fr;gap:8px;padding:10px 14px;background:var(--surface);font-size:13px;border-top:1px solid var(--border);}
        .hist-row:hover{background:var(--surface2);}

        /* Modal */
        .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(7,9,12,0.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;}
        .modal{background:var(--surface);border:1px solid var(--border2);border-radius:12px;padding:24px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:8px;}
        .field-input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-family:var(--font-body);font-size:14px;transition:border-color 0.15s;outline:none;}
        .field-input:focus{border-color:var(--accent);}

        /* Footer */
        .clash-footer{position:relative;z-index:10;display:flex;align-items:center;justify-content:center;gap:10px;padding:16px 24px;border-top:1px solid var(--border);background:rgba(7,9,12,0.8);backdrop-filter:blur(8px);font-family:var(--font-mono);font-size:11px;color:var(--muted2);flex-wrap:wrap;text-align:center;}
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