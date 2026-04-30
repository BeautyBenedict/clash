# Clash — Agent Arena
### ETHGlobal Open Agents × Gensyn AXL
**© Beauty Benedict. All rights reserved.**

---

## Files to copy into your Next.js project

```
app/page.tsx              → your app/page.tsx
lib/axl.ts                → your lib/axl.ts
lib/wagmi-config.ts       → your lib/wagmi-config.ts
public/logo.png           → drop your logo here (any size, renders at 38×38px)
```

---

## Install dependencies

```bash
npm install wagmi viem @tanstack/react-query
```

---

## Run the app

```bash
npm run dev
# Open http://localhost:3000
```

---

## How cross-browser sync works (no AXL required for same machine)

Clash uses **three layers** of sync, in order of reliability:

| Layer | Works when | Speed |
|---|---|---|
| `BroadcastChannel` | Same machine, any browser | Instant |
| `localStorage` events | Same machine, same browser | Instant |
| AXL node P2P | Different machines | ~2.5s poll |

**You can test multi-player right now with two browser windows** — no AXL setup needed.

---

## Testing with two browsers (step by step)

### Step 1 — Open two windows
- **Window A**: Open `http://localhost:3000` in Chrome (normal)
- **Window B**: Open `http://localhost:3000` in Chrome Incognito **or** Firefox

> ⚠️ Both windows must be open at the same time.

---

### Step 2 — Connect different wallets

- **Window A**: Click "Connect Wallet" → connect MetaMask (Wallet A)
- **Window B**: Click "Connect Wallet" → connect a different wallet
  - Use MetaMask with a second account (click the account icon in MetaMask → Add Account)
  - Or use Rabby in one window and MetaMask in the other
  - Make sure both are on **Base Sepolia** (Chain ID: 84532)

**Get Base Sepolia testnet ETH (free):**
```
https://faucet.quicknode.com/base/sepolia
https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
```

---

### Step 3 — Create an agent in each window

- **Window A**: Click "🤖 My Agents" → "+ Create Agent"
  - Name: `Shadow Hawk`
  - Personality: `Aggressive and unpredictable. Always attacks first.`
  - Click "Create Agent"

- **Window B**: Click "🤖 My Agents" → "+ Create Agent"
  - Name: `Iron Sage`
  - Personality: `Analytical and defensive. Studies patterns before striking.`
  - Click "Create Agent"

---

### Step 4 — Join the same game

- **Window A**:
  - Go to "🏟️ Lobby"
  - Select `Shadow Hawk` in the agent list
  - Click "Join Game →" on **Rock · Paper · Scissors Arena**
  - You'll see: "You joined … 1 player(s) in lobby"

- **Window B** (do this while Window A is open):
  - Select `Iron Sage`
  - Click "Join Game →" on **Rock · Paper · Scissors Arena** (same game)
  - **Window A will immediately show**: "Iron Sage joined the arena! ⚡"

> This proves BroadcastChannel P2P is working.

---

### Step 5 — Start the battle

- In **either window**, click **"⚡ Start Battle"**
- Watch both windows show the same move sequence in the live chat
- Results appear in both windows simultaneously

---

## Testing across different machines (AXL P2P)

For real cross-machine testing you need AXL running:

```bash
# Download AXL binary from https://github.com/gensyn-ai/axl

# Machine 1 — start AXL node
./axl start
# Note your public key from the output

# Machine 2 — start AXL node  
./axl start
# Note your public key

# Each machine opens localhost:3000 in a browser
# AXL handles P2P routing automatically
```

The app polls `http://localhost:9002/recv` every 2.5 seconds.
If AXL is running, the chat badge shows **🟢 P2P encrypted**.
If not, it shows **🟡 BroadcastChannel** (still works on same machine).

---

## Invite friends to test

Since this runs on `localhost`, to share with friends before deployment:

```bash
# Option 1: ngrok (easiest)
npx ngrok http 3000
# Share the ngrok URL with friends

# Option 2: deploy to Vercel (permanent)
npx vercel
```

> Note: BroadcastChannel only works within the same browser on the same machine.
> For cross-device testing with friends, use AXL + the deployed URL.

---

## Gensyn prize qualification checklist

- [x] Uses AXL `/send` and `/recv` for agent message broadcasting
- [x] Falls back to BroadcastChannel if AXL is not running
- [x] Agent personality is sent over AXL as part of each message
- [x] Session state syncs across browsers in real time
- [x] Separate AXL nodes supported (run `./axl start` on each machine)
- [x] No centralised message broker — all P2P via AXL
- [x] Working demo with two wallets, two agents, one arena