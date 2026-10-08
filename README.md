# Hood Watcher Indexer

Blockchain indexer and intelligence API for Robinhood Chain.
Watches every block, indexes swaps and transfers, and computes
security metrics: fresh wallets, snipers, bundlers, dev sold, top holders.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your config
cp .env.example .env

# 3. Start (indexes + API on port 3001)
npm start
```

On first run it backfills 5000 blocks (adjust `BACKFILL_BLOCKS` in `.env`).
After backfill it polls for new blocks every 500ms.

## API Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/status` | Indexer stats: blocks indexed, transfers, swaps |
| `GET /api/token/:address/security` | Fresh wallets, snipers, bundlers, dev sold, top holders, concentration |
| `GET /api/token/:address/trades` | Recent swaps for this token |
| `GET /api/token/:address/traders?limit=20` | Top traders ranked by on-chain swap count (buys/sells/trades — no USD price data, so no profit figure) |
| `GET /api/token/:address/holders` | Top holders + total count |
| `GET /api/token/:address` | Token info (name, symbol, deployer) |
| `GET /api/wallet/:address` | Wallet info (first seen, tx count) |
| `GET /api/wallet/:address/activity` | Transfer history |
| `GET /api/whales` | Recent large swaps |
| `GET /api/tokens` | All indexed tokens |

## Connecting to Hood Watcher Frontend

Already wired in — `hood-watcher.html` calls this indexer first (via `indexerGet()`, `applyIndexerSecurity()`,
`loadIndexerTraders()`), falling back to Birdeye/GMGN only for fields this indexer doesn't compute
(honeypot simulation, LP lock status — those need bytecode simulation / lock-contract parsing, not
just transfer/swap logs).

The only thing left to do on the frontend side is point it at your deployed URL. Open
`hood-watcher.html`, find this line near the top of the security-checks section:

```javascript
const INDEXER_API_BASE='';
```

and set it to wherever you deploy this indexer, e.g.:

```javascript
const INDEXER_API_BASE='https://hood-watcher-indexer-production.up.railway.app';
```

Leave it empty and the frontend just skips straight to Birdeye/GMGN.

## Deploying

### Railway (free tier)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Set the env vars from `.env.example`
4. It runs `npm start` automatically

### DigitalOcean ($6/mo)
1. Create a droplet (Ubuntu, smallest size)
2. SSH in, clone your repo, `npm install`
3. `cp .env.example .env` and edit
4. Use PM2: `npm install -g pm2 && pm2 start src/index.js --name hw-indexer`
5. `pm2 save && pm2 startup`

### Render (free tier)
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Set env vars

## Production Notes

- The public RPC at `rpc.mainnet.chain.robinhood.com` is rate-limited.
  For production, use QuickNode, Alchemy, or Chainstack.
- The SQLite database grows as you index more blocks. For heavy usage,
  consider migrating to PostgreSQL.
- Token names/symbols aren't fetched automatically yet (that requires
  calling the contract's name()/symbol() methods). You can add that
  by extending the indexer to call those on new contract deployments.
