"use client";
// ============================================================
// app/page.tsx — Clash: Agent Arena v5
// Matchmaking + multi-round battles + real staking
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
  roundResults: RoundResult[];
  finalResults: FinalResult[];
  prizePool: number;
}

type Tab      = "lobby" | "my-agents" | "dashboard";
type AppPhase = "lobby" | "queue" | "battle" | "results";

// ── Game definitions ──────────────────────────────────────────
const GAME_CONFIGS = [
  { id: "rps",        label: "Rock · Paper · Scissors", emoji: "✊", desc: "Classic RPS — agents pick moves based on personality", rounds: 3 },
  { id: "quick-chat", label: "Quick Chat Battle",       emoji: "💬", desc: "Agent personalities go head to head — wit wins",       rounds: 3 },
  { id: "rps-blitz",  label: "Blitz RPS",               emoji: "⚡", desc: "Fast-paced 5-round RPS — highest score wins",          rounds: 5 },
];

const ROOM_SIZES = [
  { size: 2, label: "1v1",   desc: "Fast match, instant start" },
  { size: 5, label: "5-way", desc: "Mid-size arena" },
  { size: 8, label: "8-way", desc: "Full arena, biggest pool" },
];

const PRIZE_COLORS: Record<number, string> = { 1: "#FFD700", 2: "#C0C0C0", 3: "#CD7F32" };
const queryClient = new QueryClient();
const SOCKET_URL  = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

let _socket: Socket | null = null;
function getSocket(): Socket {
  if (!_socket) _socket = io(SOCKET_URL, {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 20,
    timeout: 5000,
  });
  return _socket;
}

// ============================================================
function ClashArena() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balanceData } = useBalance({ address, chainId: baseSepolia.id, query: { enabled: isConnected } });

  const [mounted, setMounted]               = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [tab, setTab]                       = useState<Tab>("lobby");
  const [appPhase, setAppPhase]             = useState<AppPhase>("lobby");

  // Agent management
  const [myAgents, setMyAgents]             = useState<UserAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [agentForm, setAgentForm]           = useState({ name: "", description: "" });
  const [formError, setFormError]           = useState("");
  const [history, setHistory]               = useState<GameHistoryEntry[]>([]);

  // Game selection
  const [selectedGame, setSelectedGame]     = useState<string | null>(null);
  const [selectedSize, setSelectedSize]     = useState<number | null>(null);

  // Queue state
  const [queueStatus, setQueueStatus]       = useState<{ waiting: number; size: number; message: string } | null>(null);

  // Room / battle state
  const [room, setRoom]                     = useState<Room | null>(null);
  const [chatLog, setChatLog]               = useState<ChatEntry[]>([]);
  const [currentRound, setCurrentRound]     = useState(0);
  const [roundResults, setRoundResults]     = useState<RoundResult[]>([]);
  const [finalResults, setFinalResults]     = useState<FinalResult[]>([]);
  const [roundAnimating, setRoundAnimating] = useState(false);

  // Staking
  const { writeContract, data: txHash, isPending: isSending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txSuccess }     = useWaitForTransactionReceipt({ hash: txHash });
  const [hasPaidFee, setHasPaidFee]         = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!address) { setMyAgents([]); setHistory([]); return; }
    setMyAgents(loadAgents(address));
    setHistory(loadHistory(address));
  }, [address]);

  // ── Socket events ─────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    socket.on("connect",    () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));
    if (socket.connected) setSocketConnected(true);

    // Joined queue successfully
    socket.on("queue_joined", (data: { waiting: number; size: number; message: string }) => {
      setQueueStatus(data);
      setAppPhase("queue");
      addChat("🏟️ Arena", data.message, "system");
    });

    // Queue count updated (someone else joined/left)
    socket.on("queue_update", (data: { waiting: number; size: number; message?: string }) => {
      setQueueStatus(prev => prev ? { ...prev, ...data } : data as typeof prev);
      if (data.message) addChat("🏟️ Arena", data.message, "system");
    });

    // Matched into a room — battle about to start
    socket.on("matched", (data: { roomId: string; room: Room; message: string }) => {
      setRoom(data.room);
      setAppPhase("battle");
      setCurrentRound(0);
      setRoundResults([]);
      addChat("⚡ Arena", data.message, "join");
      data.room.players.forEach(p => {
        if (p.walletAddress !== address?.toLowerCase()) {
          addChat(`${p.agentName} (${shortWallet(p.walletAddress)})`, "is ready to battle!", "join", p.walletAddress);
        }
      });
    });

    // Round is starting
    socket.on("round_start", (data: { round: number; totalRounds: number; message: string }) => {
      setCurrentRound(data.round);
      setRoundAnimating(true);
      addChat(`⚔️ Round ${data.round}`, data.message, "system");
    });

    // Round resolved
    socket.on("round_result", (result: RoundResult) => {
      setRoundAnimating(false);
      setRoundResults(prev => [...prev, result]);
      setRoom(prev => prev ? { ...prev, currentRound: result.round } : prev);

      // Show each player's move
      Object.entries(result.moves).forEach(([wallet, move]) => {
        const player = room?.players.find(p => p.walletAddress === wallet);
        const name   = player?.agentName ?? shortWallet(wallet);
        if (move) addChat(name, `played ${move.toUpperCase()}`, "move", wallet);
      });

      addChat(`🏆 Round ${result.round}`, `Winner: ${result.roundWinner} (+${Math.max(...Object.values(result.roundScores))} pts)`, "result");
    });

    // Game over — all rounds done
    socket.on("game_over", (data: { finalResults: FinalResult[]; prizePool: number; totalRounds: number; roomId: string }) => {
      setFinalResults(data.finalResults);
      setAppPhase("results");
      addChat("🏆 Arena", `Battle complete after ${data.totalRounds} rounds!`, "system");

      const medals = ["🥇", "🥈", "🥉"];
      data.finalResults.slice(0, 3).forEach((r, i) => {
        addChat("🏆 Arena", `${medals[i]} ${r.agentName} — ${r.score}pts — ${r.prize} (${r.prizeEth} ETH)`, "result");
      });

      // Pay out on-chain if contract deployed
      if (CLASH_CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000" && address) {
        const myResult = data.finalResults.find(r => r.walletAddress === address.toLowerCase());
        if (myResult?.rank === 1) {
          // Only winner triggers payout (or owner does it via Remix)
          addChat("🏟️ Arena", "Confirm on-chain payout in MetaMask.", "system");
        }
      }

      // Save history
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

    socket.on("room_not_found", () => {
      addChat("🏟️ Arena", "Room not found. Returning to lobby.", "system");
      handleBackToLobby();
    });

    socket.on("game_event", (event: { agentName: string; walletAddress: string; content: string }) => {
      if (event.walletAddress === address?.toLowerCase()) return;
      addChat(`${event.agentName}`, event.content, "peer", event.walletAddress);
    });

    return () => {
      socket.off("connect"); socket.off("disconnect");
      socket.off("queue_joined"); socket.off("queue_update");
      socket.off("matched"); socket.off("round_start");
      socket.off("round_result"); socket.off("game_over");
      socket.off("room_not_found"); socket.off("game_event");
    };
  }, [address, myAgents, history, selectedGame, room]);

  useEffect(() => {
    if (txSuccess && selectedGame) setHasPaidFee(true);
  }, [txSuccess, selectedGame]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog]);

  function addChat(sender: string, content: string, type: ChatEntry["type"] = "system", wallet?: string) {
    setChatLog(prev => [...prev, buildChat(sender, content, type, wallet)]);
  }

  // ── Agent CRUD ────────────────────────────────────────────
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

  // ── Stake & Join Queue ────────────────────────────────────
  function handleStake() {
    if (!isConnected || !selectedGame || !selectedSize) return;
    if (CLASH_CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      // No contract deployed yet — skip payment and go straight to queue
      handleJoinQueue();
      return;
    }
    writeContract({
      address: CLASH_CONTRACT_ADDRESS,
      abi: CLASH_ABI,
      functionName: "joinGame",
      args: [`${selectedGame}-${selectedSize}`],
      value: parseEther(ENTRY_FEE_ETH),
      chainId: baseSepolia.id,
    });
  }

  function handleJoinQueue() {
    if (!address || !selectedAgentId || !selectedGame || !selectedSize) return;
    const agent = myAgents.find(a => a.id === selectedAgentId);
    if (!agent) return;

    setChatLog([]);
    setRoundResults([]);
    setFinalResults([]);
    setRoom(null);

    const socket = getSocket();
    socket.emit("join_queue", {
      gameType: selectedGame,
      size: selectedSize,
      walletAddress: address.toLowerCase(),
      agentName: agent.name,
      agentDescription: agent.description,
    });
  }

  // Join queue immediately after stake confirms
  useEffect(() => {
    if (hasPaidFee && selectedGame && selectedSize && appPhase === "lobby") {
      handleJoinQueue();
    }
  }, [hasPaidFee]);

  function handleBackToLobby() {
    if (address) {
      getSocket().emit("leave", { walletAddress: address.toLowerCase() });
    }
    setAppPhase("lobby");
    setQueueStatus(null);
    setRoom(null);
    setSelectedGame(null);
    setSelectedSize(null);
    setHasPaidFee(false);
    setChatLog([]);
    setRoundResults([]);
    setFinalResults([]);
  }

  // ── Derived ───────────────────────────────────────────────
  const selectedAgent = myAgents.find(a => a.id === selectedAgentId);
  const myRoomPlayer  = room?.players.find(p => p.walletAddress === address?.toLowerCase());
  const myFinalResult = finalResults.find(r => r.walletAddress === address?.toLowerCase());

  // ── RENDER ────────────────────────────────────────────────
  return (
    <div className="clash-root">
      <div className="grid-bg" aria-hidden />

      {/* ── HEADER ── */}
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
            {socketConnected ? "LIVE" : "OFFLINE"}
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

      {!socketConnected && (
        <div className="server-banner">
          ⚠️ Server offline. Make sure your Railway backend is running.
        </div>
      )}

      <main className="clash-body">

        {/* ══════════════════ LOBBY TAB ══════════════════ */}
        {tab === "lobby" && appPhase === "lobby" && (
          <div className="lobby-layout">

            {/* LEFT: Game + Size selection */}
            <div className="lobby-left">
              <h2 className="section-title">Choose Your Battle</h2>

              {!isConnected && <div className="notice">Connect your wallet to enter the arena.</div>}

              {isConnected && myAgents.length === 0 && (
                <div className="notice notice-warn">
                  No agents yet. <button className="link-btn" onClick={() => setTab("my-agents")}>Create one →</button>
                </div>
              )}

              {/* Agent selector */}
              {isConnected && myAgents.length > 0 && (
                <div className="section-block">
                  <div className="block-label">Your agent</div>
                  <div className="agent-select-list">
                    {myAgents.map(a => (
                      <button key={a.id}
                        className={`agent-pick ${selectedAgentId === a.id ? "agent-pick-active" : ""}`}
                        onClick={() => setSelectedAgentId(a.id)}>
                        <span className="agent-pick-name">{a.name}</span>
                        <span className="agent-pick-desc">{a.description.slice(0, 50)}{a.description.length > 50 ? "…" : ""}</span>
                        <span className="agent-pick-stats">W:{a.wins} L:{a.losses}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Game type */}
              {isConnected && myAgents.length > 0 && (
                <div className="section-block">
                  <div className="block-label">Game type</div>
                  <div className="game-type-list">
                    {GAME_CONFIGS.map(g => (
                      <button key={g.id}
                        className={`game-type-btn ${selectedGame === g.id ? "game-type-active" : ""}`}
                        onClick={() => setSelectedGame(g.id)}>
                        <span className="gt-emoji">{g.emoji}</span>
                        <div className="gt-info">
                          <div className="gt-label">{g.label}</div>
                          <div className="gt-desc">{g.desc}</div>
                          <div className="gt-rounds">{g.rounds} rounds</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Room size */}
              {selectedGame && (
                <div className="section-block">
                  <div className="block-label">Room size</div>
                  <div className="size-list">
                    {ROOM_SIZES.map(s => (
                      <button key={s.size}
                        className={`size-btn ${selectedSize === s.size ? "size-active" : ""}`}
                        onClick={() => setSelectedSize(s.size)}>
                        <span className="size-label">{s.label}</span>
                        <span className="size-fee">{(s.size * 0.001).toFixed(3)} ETH pool</span>
                        <span className="size-desc">{s.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Enter arena button */}
              {selectedGame && selectedSize && selectedAgentId && isConnected && (
                <div className="section-block">
                  <div className="entry-box">
                    <div className="entry-info">
                      <span className="entry-fee">Entry: {ENTRY_FEE_ETH} ETH</span>
                      <span className="entry-pool">Prize pool: {(selectedSize * 0.001).toFixed(3)} ETH</span>
                      <span className="entry-dist">60% · 30% · 10%</span>
                    </div>
                    <button className="btn btn-battle w-full"
                      onClick={handleStake}
                      disabled={isSending || isConfirming}>
                      {isSending ? "⏳ Confirm in MetaMask…"
                        : isConfirming ? "⏳ Confirming on-chain…"
                        : "⚡ Pay & Enter Arena"}
                    </button>
                    {txHash && (
                      <a className="tx-link" href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
                        View transaction ↗
                      </a>
                    )}
                    {CLASH_CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000" && (
                      <div className="notice notice-warn" style={{margin:"8px 0 0"}}>
                        Contract not deployed — joining without payment (demo mode)
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Live feed / waiting state */}
            <div className="lobby-right">
              {appPhase === "lobby" ? (
                <div className="feed-empty">
                  <span className="feed-empty-icon">⚔️</span>
                  <p>Select a game and room size to enter the arena.</p>
                  <p className="hint-text">
                    {socketConnected
                      ? "✅ Server live — multiplayer ready."
                      : "⚠️ Server offline — run node server.js locally or check Railway."}
                  </p>
                </div>
              ) : (
                <div className="chat-panel" style={{height:"100%", minHeight:400}}>
                  <div className="chat-header-row">
                    <span className="chat-label">⚔️ Live Feed</span>
                    <span className="chat-badge">{socketConnected ? "🟢 Live" : "🔴 Offline"}</span>
                  </div>
                  <div className="chat-log">
                    {chatLog.length === 0 && <div className="chat-empty">Messages appear here…</div>}
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
              )}
            </div>
          </div>
        )}

        {/* ══════════════════ QUEUE PHASE ══════════════════ */}
        {tab === "lobby" && appPhase === "queue" && (
          <div className="phase-screen">
            <div className="phase-card">
              <div className="phase-icon pulse-anim">🔍</div>
              <h2 className="phase-title">Finding Opponent…</h2>
              {queueStatus && (
                <>
                  <div className="queue-bar">
                    <div className="queue-bar-fill" style={{ width: `${(queueStatus.waiting / queueStatus.size) * 100}%` }} />
                  </div>
                  <div className="queue-count-big">
                    {mounted ? queueStatus.waiting : 0} / {queueStatus.size} players
                  </div>
                  <p className="phase-sub">{queueStatus.message}</p>
                </>
              )}
              <div className="phase-agent-preview">
                <span className="pap-label">Your agent</span>
                <span className="pap-name">{selectedAgent?.name}</span>
                <span className="pap-desc">{selectedAgent?.description.slice(0, 60)}…</span>
              </div>
              <button className="btn btn-ghost w-full" onClick={handleBackToLobby}>
                🚪 Leave Queue
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════ BATTLE PHASE ══════════════════ */}
        {tab === "lobby" && appPhase === "battle" && room && (
          <div className="battle-layout">

            {/* LEFT: Players + rounds */}
            <div className="battle-left">
              <div className="battle-header">
                <div>
                  <div className="battle-title">
                    {GAME_CONFIGS.find(g => g.id === room.gameType)?.emoji}{" "}
                    {GAME_CONFIGS.find(g => g.id === room.gameType)?.label}
                  </div>
                  <div className="battle-sub">
                    Round {currentRound || "—"} of {room.totalRounds} · {room.players.length} agents
                  </div>
                </div>
                <div className="pool-badge">
                  <span className="pool-label">Pool</span>
                  <span className="pool-value">{room.prizePool.toFixed(3)} ETH</span>
                </div>
              </div>

              {/* Round progress dots */}
              <div className="round-dots">
                {Array.from({ length: room.totalRounds }).map((_, i) => {
                  const rr = roundResults[i];
                  const isMyWin = rr?.roundWinner === myRoomPlayer?.agentName;
                  return (
                    <div key={i} className={`round-dot ${i < roundResults.length ? (isMyWin ? "dot-win" : "dot-lose") : i === currentRound - 1 ? "dot-active" : "dot-pending"}`}>
                      {rr ? (isMyWin ? "✓" : "✗") : i + 1}
                    </div>
                  );
                })}
              </div>

              {/* Players scoreboard */}
              <div className="scoreboard">
                <div className="sb-label">Scoreboard</div>
                {[...room.players]
                  .sort((a,b) => b.score - a.score)
                  .map((p, idx) => {
                    const isMe = p.walletAddress === address?.toLowerCase();
                    return (
                      <div key={p.walletAddress} className={`sb-row ${isMe ? "sb-me" : ""}`}>
                        <span className="sb-rank">#{idx + 1}</span>
                        <span className="sb-name">{p.agentName}{isMe ? " (you)" : ""}</span>
                        <span className="sb-wallet">{shortWallet(p.walletAddress)}</span>
                        <span className="sb-score">{p.score}pts</span>
                      </div>
                    );
                  })}
              </div>

              {/* Latest round result */}
              {roundResults.length > 0 && (
                <div className="round-summary">
                  <div className="rs-label">Last Round — Round {roundResults[roundResults.length - 1].round}</div>
                  {roundResults[roundResults.length - 1].playerStandings.map(p => (
                    <div key={p.walletAddress} className="rs-row">
                      <span className="rs-name">{p.agentName}</span>
                      {roundResults[roundResults.length - 1].moves[p.walletAddress] && (
                        <span className="rs-move">{roundResults[roundResults.length - 1].moves[p.walletAddress].toUpperCase()}</span>
                      )}
                      <span className="rs-pts">+{p.roundScore}pts</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Animating indicator */}
              {roundAnimating && (
                <div className="round-animating">
                  <span className="spin">⚙</span> Agents choosing moves…
                </div>
              )}
            </div>

            {/* RIGHT: Live chat */}
            <div className="battle-right">
              <div className="chat-panel" style={{height:"100%"}}>
                <div className="chat-header-row">
                  <span className="chat-label">⚔️ Battle Feed</span>
                  <span className="chat-badge">🟢 Live</span>
                </div>
                <div className="chat-log">
                  {chatLog.length === 0 && <div className="chat-empty">Battle starting…</div>}
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
          </div>
        )}

        {/* ══════════════════ RESULTS PHASE ══════════════════ */}
        {tab === "lobby" && appPhase === "results" && (
          <div className="phase-screen">
            <div className="results-card">
              <div className="results-title">🏆 Battle Complete</div>

              {myFinalResult && (
                <div className={`my-result ${myFinalResult.rank === 1 ? "my-result-win" : ""}`}>
                  {myFinalResult.rank === 1 ? "🥇 You Won!" : myFinalResult.rank === 2 ? "🥈 2nd Place" : myFinalResult.rank === 3 ? "🥉 3rd Place" : `#${myFinalResult.rank} Place`}
                  <span className="my-prize">{myFinalResult.prizeEth} ETH · {myFinalResult.prize}</span>
                </div>
              )}

              <div className="final-list">
                {finalResults.map(r => (
                  <div key={r.walletAddress} className="final-row">
                    <span className="final-medal" style={{ color: PRIZE_COLORS[r.rank] ?? "#aaa" }}>
                      {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`}
                    </span>
                    <span className="final-name">{r.agentName}</span>
                    <span className="final-wallet muted">{shortWallet(r.walletAddress)}</span>
                    <span className="final-rounds muted">{r.roundWins} round wins</span>
                    <span className="final-score muted">{r.score}pts</span>
                    <span className="final-prize" style={{ color: PRIZE_COLORS[r.rank] ?? "var(--muted2)" }}>{r.prize}</span>
                    <span className="final-eth muted">{r.prizeEth} ETH</span>
                  </div>
                ))}
              </div>

              {/* Round by round breakdown */}
              {roundResults.length > 0 && (
                <details className="round-breakdown">
                  <summary>Round by round breakdown</summary>
                  {roundResults.map(rr => (
                    <div key={rr.round} className="breakdown-round">
                      <div className="br-title">Round {rr.round} — Winner: {rr.roundWinner}</div>
                      {rr.playerStandings.map(p => (
                        <div key={p.walletAddress} className="br-row">
                          <span>{p.agentName}</span>
                          {rr.moves[p.walletAddress] && <span className="rs-move">{rr.moves[p.walletAddress]}</span>}
                          <span className="muted">+{p.roundScore}pts</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </details>
              )}

              <div className="results-actions">
                <button className="btn btn-primary" onClick={() => {
                  setAppPhase("lobby");
                  setSelectedGame(null);
                  setSelectedSize(null);
                  setHasPaidFee(false);
                  setFinalResults([]);
                  setRoundResults([]);
                  setChatLog([]);
                }}>
                  🔄 Play Again
                </button>
                <button className="btn btn-ghost" onClick={handleBackToLobby}>
                  Back to Lobby
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════ MY AGENTS TAB ══════════════════ */}
        {tab === "my-agents" && (
          <div className="agents-page">
            <div className="page-header">
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
                  <div className="afc-header">
                    <span className="afc-name">{agent.name}</span>
                    <button className="btn btn-ghost btn-xs danger" onClick={() => handleDeleteAgent(agent.id)}>✕</button>
                  </div>
                  <p className="afc-desc">{agent.description}</p>
                  <div className="afc-stats">
                    <span style={{color:"var(--green)"}}>W: {agent.wins}</span>
                    <span style={{color:"var(--accent)"}}>L: {agent.losses}</span>
                    <span className="muted">D: {agent.draws}</span>
                  </div>
                  <div className="afc-date muted">Created {fmtDate(agent.createdAt)}</div>
                  <button className="btn btn-join w-full" style={{marginTop:8}}
                    onClick={() => { setSelectedAgentId(agent.id); setTab("lobby"); }}>
                    Deploy to Arena →
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════════════ DASHBOARD TAB ══════════════════ */}
        {tab === "dashboard" && (
          <div className="dashboard-page">
            <h2 className="section-title">My Dashboard</h2>
            {!isConnected ? <div className="notice">Connect your wallet to view your dashboard.</div> : (
              <>
                <div className="dash-cards">
                  <div className="dash-card">
                    <div className="dash-card-label">Wallet</div>
                    <div className="dash-card-value" style={{fontSize:14, fontFamily:"var(--font-mono)"}}>{shortWallet(address!)}</div>
                  </div>
                  <div className="dash-card">
                    <div className="dash-card-label">Balance</div>
                    <div className="dash-card-value">{balanceData ? `${parseFloat(formatEther(balanceData.value)).toFixed(5)} ETH` : "…"}</div>
                    <div className="muted" style={{fontSize:11, marginTop:4}}>Base Sepolia</div>
                  </div>
                  <div className="dash-card">
                    <div className="dash-card-label">Agents</div>
                    <div className="dash-card-value">{myAgents.length}</div>
                  </div>
                  <div className="dash-card">
                    <div className="dash-card-label">Games Played</div>
                    <div className="dash-card-value">{history.length}</div>
                  </div>
                  <div className="dash-card">
                    <div className="dash-card-label">Total Wins</div>
                    <div className="dash-card-value" style={{color:"var(--green)"}}>{myAgents.reduce((s,a)=>s+a.wins,0)}</div>
                  </div>
                </div>
                <h3 className="section-subtitle">Game History</h3>
                {history.length === 0 ? <div className="notice">No games yet.</div> : (
                  <div className="history-table">
                    <div className="history-head">
                      <span>Game</span><span>Agent</span><span>Players</span><span>Rank</span><span>Prize</span><span>Date</span>
                    </div>
                    {history.map(h => (
                      <div key={h.sessionId+h.playedAt} className="history-row">
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
            <div className="modal-top">
              <span className="modal-title">Create Agent</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <label className="field-label">Agent Name</label>
            <input className="field-input" placeholder="e.g. Shadow Hawk" maxLength={30}
              value={agentForm.name} onChange={e => setAgentForm(f=>({...f,name:e.target.value}))} />
            <label className="field-label" style={{marginTop:12}}>
              Personality / Strategy
              <span style={{display:"block",fontSize:11,color:"var(--muted2)",fontWeight:400,textTransform:"none",letterSpacing:0,marginTop:3}}>
                This is your agent's fighting style. Be specific — it affects how they play.
              </span>
            </label>
            <textarea className="field-input" style={{resize:"vertical",minHeight:90}} rows={4} maxLength={300}
              placeholder="e.g. Aggressive risk-taker. Always picks rock. Bluffs opponents into scissors."
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
          --font-d:'Bebas Neue',sans-serif;--font-mono:'DM Mono',monospace;--font-body:'Cabinet Grotesk',sans-serif;
          --r:8px;
        }
        html,body{height:100%;background:var(--bg);color:var(--text);}
        body{font-family:var(--font-body);font-size:14px;line-height:1.6;overflow-x:hidden;}
        a{color:inherit;text-decoration:none;}
        .clash-root{min-height:100vh;display:flex;flex-direction:column;position:relative;}
        .grid-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(255,68,68,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,68,68,0.025) 1px,transparent 1px);background-size:44px 44px;}
        .server-banner{position:relative;z-index:15;background:rgba(255,140,0,0.12);border-bottom:1px solid rgba(255,140,0,0.35);padding:10px 24px;font-size:13px;color:var(--accent2);text-align:center;}

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
        .section-subtitle{font-family:var(--font-d);font-size:18px;letter-spacing:1px;margin:24px 0 12px;}
        .page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}

        /* Buttons */
        .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:var(--font-mono);font-size:13px;padding:9px 18px;border-radius:var(--r);border:1px solid transparent;cursor:pointer;transition:all 0.15s;white-space:nowrap;}
        .btn:disabled{opacity:0.4;cursor:not-allowed;}
        .w-full{width:100%;}
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
        .notice{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:14px 18px;font-size:13px;color:var(--muted2);margin-bottom:16px;}
        .notice-warn{border-color:rgba(255,140,0,0.3);color:var(--accent2);}
        .notice-green{border-color:rgba(61,219,150,0.3);color:var(--green);background:rgba(61,219,150,0.05);}
        .link-btn{background:none;border:none;color:var(--accent);cursor:pointer;font-size:inherit;text-decoration:underline;}
        .muted{color:var(--muted2);}

        /* Lobby layout */
        .lobby-layout{display:grid;grid-template-columns:460px 1fr;gap:24px;align-items:start;}
        .lobby-right{position:sticky;top:24px;min-height:400px;}
        @media(max-width:960px){.lobby-layout{grid-template-columns:1fr;}}
        .lobby-left{display:flex;flex-direction:column;gap:20px;}
        .section-block{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;scroll-margin-top:24px;}
        .block-label{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:10px;}
        .field-label{display:block;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}

        /* Agent selector */
        .agent-select-list{display:flex;flex-direction:column;gap:6px;}
        .agent-pick{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;cursor:pointer;display:flex;align-items:center;gap:10px;text-align:left;transition:all 0.15s;width:100%;}
        .agent-pick:hover{border-color:var(--border2);}
        .agent-pick-active{border-color:var(--accent);background:rgba(255,68,68,0.05);}
        .agent-pick-name{font-weight:700;font-size:13px;min-width:100px;}
        .agent-pick-desc{flex:1;font-size:11px;color:var(--muted2);}
        .agent-pick-stats{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}

        /* Game type selector */
        .game-type-list{display:flex;flex-direction:column;gap:8px;}
        .game-type-btn{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px;cursor:pointer;display:flex;align-items:flex-start;gap:12px;text-align:left;transition:all 0.15s;width:100%;}
        .game-type-btn:hover{border-color:var(--border2);}
        .game-type-active{border-color:var(--accent);background:rgba(255,68,68,0.05);}
        .gt-emoji{font-size:24px;flex-shrink:0;margin-top:2px;}
        .gt-info{flex:1;}
        .gt-label{font-weight:700;font-size:14px;margin-bottom:2px;}
        .gt-desc{font-size:12px;color:var(--muted2);line-height:1.4;}
        .gt-rounds{font-family:var(--font-mono);font-size:10px;color:var(--accent2);margin-top:4px;}

        /* Room size selector */
        .size-list{display:flex;flex-direction:row;gap:8px;overflow-x:auto;padding-bottom:4px;scroll-snap-type:x mandatory;}
        .size-list::-webkit-scrollbar{height:3px;}
        .size-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
        .size-btn{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all 0.15s;min-width:130px;flex-shrink:0;scroll-snap-align:start;}
        .size-btn:hover{border-color:var(--border2);}
        .size-active{border-color:var(--accent);background:rgba(255,68,68,0.08);}
        .size-label{font-family:var(--font-d);font-size:22px;letter-spacing:1px;color:var(--text);}
        .size-fee{font-family:var(--font-mono);font-size:10px;color:var(--accent2);}
        .size-desc{font-size:11px;color:var(--muted2);text-align:center;}

        /* Entry box */
        .entry-box{display:flex;flex-direction:column;gap:10px;}
        .entry-info{display:flex;gap:12px;flex-wrap:wrap;}
        .entry-fee{font-family:var(--font-mono);font-size:12px;color:var(--accent2);}
        .entry-pool{font-family:var(--font-mono);font-size:12px;color:var(--green);}
        .entry-dist{font-family:var(--font-mono);font-size:11px;color:var(--muted2);}
        .tx-link{font-family:var(--font-mono);font-size:10px;color:var(--blue);text-align:center;}
        .tx-link:hover{text-decoration:underline;}

        /* Queue cards */
        .queues-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;}
        .queue-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px;}
        .queue-card-top{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
        .queue-emoji{font-size:18px;}
        .queue-name{font-size:12px;font-weight:700;}
        .queue-size{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
        .queue-waiting{font-family:var(--font-mono);font-size:13px;margin-bottom:4px;}
        .queue-count{color:var(--accent2);font-size:16px;}
        .queue-slash,.queue-text{color:var(--muted2);}
        .queue-fee{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}

        /* Phase screens (queue + results) */
        .phase-screen{display:flex;align-items:center;justify-content:center;min-height:60vh;}
        .phase-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;max-width:480px;width:100%;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;}
        .phase-icon{font-size:48px;}
        .phase-title{font-family:var(--font-d);font-size:28px;letter-spacing:2px;}
        .phase-sub{font-size:13px;color:var(--muted2);}
        .pulse-anim{animation:pulse-scale 1.5s ease-in-out infinite;}
        @keyframes pulse-scale{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
        .queue-bar{width:100%;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;}
        .queue-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width 0.5s ease;border-radius:4px;}
        .queue-count-big{font-family:var(--font-d);font-size:32px;letter-spacing:2px;color:var(--accent2);}
        .phase-agent-preview{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;}
        .pap-label{font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase;}
        .pap-name{font-weight:700;font-size:16px;}
        .pap-desc{font-size:12px;color:var(--muted2);}

        /* Battle layout */
        .battle-layout{display:grid;grid-template-columns:1fr 380px;gap:24px;align-items:start;min-height:70vh;}
        @media(max-width:960px){.battle-layout{grid-template-columns:1fr;}}
        .battle-left{display:flex;flex-direction:column;gap:16px;}
        .battle-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
        .battle-title{font-family:var(--font-d);font-size:24px;letter-spacing:2px;}
        .battle-sub{font-size:12px;color:var(--muted2);margin-top:4px;}
        .pool-badge{text-align:right;flex-shrink:0;}
        .pool-label{display:block;font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
        .pool-value{font-family:var(--font-d);font-size:24px;color:var(--accent2);}

        /* Round dots */
        .round-dots{display:flex;gap:8px;flex-wrap:wrap;}
        .round-dot{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:12px;border:2px solid;transition:all 0.3s;}
        .dot-pending{border-color:var(--border);color:var(--muted2);}
        .dot-active{border-color:var(--accent);color:var(--accent);animation:pulse 1s infinite;}
        .dot-win{border-color:var(--green);background:rgba(61,219,150,0.15);color:var(--green);}
        .dot-lose{border-color:var(--muted);background:rgba(255,68,68,0.1);color:var(--accent);}

        /* Scoreboard */
        .scoreboard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;}
        .sb-label{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
        .sb-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);}
        .sb-row:last-child{border-bottom:none;}
        .sb-me{background:rgba(75,159,255,0.05);border-radius:4px;padding:6px 8px;margin:0 -8px;}
        .sb-rank{font-family:var(--font-mono);font-size:11px;color:var(--muted2);width:24px;}
        .sb-name{flex:1;font-weight:700;font-size:13px;}
        .sb-wallet{font-family:var(--font-mono);font-size:11px;color:var(--muted2);}
        .sb-score{font-family:var(--font-d);font-size:18px;color:var(--accent2);}

        /* Round summary */
        .round-summary{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px;}
        .rs-label{font-family:var(--font-mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
        .rs-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
        .rs-name{flex:1;font-size:13px;}
        .rs-move{font-family:var(--font-mono);font-size:11px;background:var(--surface3);padding:2px 8px;border-radius:4px;color:var(--accent2);}
        .rs-pts{font-family:var(--font-mono);font-size:12px;color:var(--green);}
        .round-animating{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:13px;color:var(--accent2);padding:12px;background:var(--surface);border-radius:var(--r);border:1px solid var(--border);}

        /* Results card */
        .results-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;max-width:640px;width:100%;display:flex;flex-direction:column;gap:16px;}
        .results-title{font-family:var(--font-d);font-size:32px;letter-spacing:3px;text-align:center;}
        .my-result{background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r);padding:16px;display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:16px;}
        .my-result-win{border-color:var(--green);background:rgba(61,219,150,0.08);color:var(--green);}
        .my-prize{font-family:var(--font-mono);font-size:13px;}
        .final-list{display:flex;flex-direction:column;gap:8px;}
        .final-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:var(--r);border:1px solid var(--border);}
        .final-medal{font-size:20px;width:28px;}
        .final-name{flex:1;font-weight:700;}
        .final-wallet,.final-rounds,.final-score,.final-eth{font-family:var(--font-mono);font-size:11px;}
        .final-prize{font-family:var(--font-d);font-size:18px;}
        .round-breakdown{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px;}
        .round-breakdown summary{cursor:pointer;font-family:var(--font-mono);font-size:12px;color:var(--muted2);padding:4px 0;}
        .breakdown-round{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);}
        .br-title{font-family:var(--font-mono);font-size:11px;color:var(--accent2);margin-bottom:6px;}
        .br-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;}
        .results-actions{display:flex;gap:10px;}

        /* Chat */
        .battle-right{height:calc(100vh - 200px);position:sticky;top:24px;}
        .chat-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;}
        .chat-header-row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;}
        .chat-label{font-family:var(--font-mono);font-size:11px;letter-spacing:1px;color:var(--muted2);}
        .chat-badge{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
        .chat-log{overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:6px;flex:1;}
        .chat-log::-webkit-scrollbar{width:3px;}
        .chat-log::-webkit-scrollbar-thumb{background:var(--border);}
        .chat-empty{color:var(--muted2);font-family:var(--font-mono);font-size:11px;text-align:center;padding:24px 0;}
        .chat-entry{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;padding:6px 10px;border-radius:5px;background:var(--surface2);border:1px solid var(--border);animation:fadein 0.2s ease;}
        @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        .chat-move{border-color:rgba(255,68,68,0.25);}
        .chat-result{border-color:rgba(255,140,0,0.35);background:rgba(255,140,0,0.04);}
        .chat-system{border-color:rgba(61,219,150,0.2);}
        .chat-peer{border-color:rgba(75,159,255,0.25);}
        .chat-join{border-color:rgba(75,159,255,0.35);background:rgba(75,159,255,0.05);}
        .chat-sender{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}
        .chat-content{font-size:12px;}
        .chat-time{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}
        .spin{animation:rotate 1s linear infinite;display:inline-block;}
        @keyframes rotate{to{transform:rotate(360deg)}}

        /* Agents */
        .agents-page{max-width:900px;}
        .agents-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:4px;}
        .agent-full-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color 0.15s;}
        .agent-full-card:hover{border-color:var(--border2);}
        .afc-header{display:flex;align-items:center;justify-content:space-between;}
        .afc-name{font-weight:800;font-size:16px;}
        .afc-desc{font-size:13px;color:var(--muted2);line-height:1.5;}
        .afc-stats{display:flex;gap:12px;font-family:var(--font-mono);font-size:12px;}
        .afc-date{font-family:var(--font-mono);font-size:10px;}
        .empty-state{display:flex;flex-direction:column;align-items:center;gap:16px;padding:60px;text-align:center;color:var(--muted2);}

        /* Dashboard */
        .dashboard-page{max-width:900px;}
        .dash-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:8px;}
        .dash-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;}
        .dash-card-label{font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;}
        .dash-card-value{font-family:var(--font-d);font-size:22px;letter-spacing:1px;}
        .history-table{display:flex;flex-direction:column;border-radius:var(--r);overflow:hidden;border:1px solid var(--border);}
        .history-head{display:grid;grid-template-columns:80px 1fr 70px 60px 70px 1fr;gap:8px;padding:8px 14px;background:var(--surface2);font-family:var(--font-mono);font-size:10px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase;}
        .history-row{display:grid;grid-template-columns:80px 1fr 70px 60px 70px 1fr;gap:8px;padding:10px 14px;background:var(--surface);font-size:13px;border-top:1px solid var(--border);}
        .history-row:hover{background:var(--surface2);}

        /* Modal */
        .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(7,9,12,0.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;}
        .modal{background:var(--surface);border:1px solid var(--border2);border-radius:12px;padding:24px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:8px;}
        .modal-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
        .modal-title{font-family:var(--font-d);font-size:22px;letter-spacing:2px;}
        .field-input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-family:var(--font-body);font-size:14px;transition:border-color 0.15s;outline:none;}
        .field-input:focus{border-color:var(--accent);}

        /* Feed empty state */
        .feed-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:300px;background:var(--surface);border:1px dashed var(--border);border-radius:var(--r);color:var(--muted2);text-align:center;padding:32px;}
        .feed-empty-icon{font-size:40px;}
        .hint-text{font-size:12px;color:var(--muted);}

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