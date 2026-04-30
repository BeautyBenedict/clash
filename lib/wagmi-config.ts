// ============================================================
// lib/wagmi-config.ts — Wagmi v2 + Base Sepolia
// Chain ID: 84532
// ============================================================
import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected, metaMask, coinbaseWallet } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http("https://sepolia.base.org"),
  },
  connectors: [
    injected(),
    metaMask(),
    coinbaseWallet({ appName: "Clash — Agent Arena" }),
  ],
});

export { baseSepolia };

// ── Entry fee (must match contract ENTRY_FEE exactly) ────────
export const ENTRY_FEE_ETH = "0.001";
export const ENTRY_FEE_WEI = BigInt("1000000000000000");

// ── Contract address ─────────────────────────────────────────
// After deploying ClashArena.sol on Base Sepolia via Remix,
// paste the deployed address here and save the file:
export const CLASH_CONTRACT_ADDRESS =
  "0x3d393cDb3F93acf8EA1Cc69766A3Bc6c4ea74Ea9" as `0x${string}`;
// ↑↑↑ REPLACE THIS after deployment ↑↑↑

// ── Contract ABI (functions called from frontend) ────────────
export const CLASH_ABI = [
  {
    name: "joinGame",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [],
  },
  {
    name: "declareWinners",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId",  type: "string"  },
      { name: "winner1", type: "address" },
      { name: "winner2", type: "address" },
      { name: "winner3", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "getPlayerCount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getPrizePool",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isPlayerInGame",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "gameId", type: "string"  },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "PlayerJoined",
    type: "event",
    inputs: [
      { name: "gameId",    type: "bytes32", indexed: true  },
      { name: "player",    type: "address", indexed: true  },
      { name: "prizePool", type: "uint256", indexed: false },
    ],
  },
  {
    name: "PrizePaid",
    type: "event",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true  },
      { name: "winner", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
      { name: "rank",   type: "uint8",   indexed: false },
    ],
  },
] as const;