const express = require('express');
const cors = require('cors');
const config = require('./config');
const { stmts } = require('./db');
const analysis = require('./analysis');
const { getStats } = require('./indexer');

const app = express();
app.use(cors({ origin: config.FRONTEND_URL }));
app.use(express.json());

// ── STATUS ──
app.get('/api/status', (req, res) => {
  res.json({ ok: true, chain: 'robinhood', chainId: config.CHAIN_ID, ...getStats() });
});

// ── TOKEN SECURITY (the main endpoint Hood Watcher calls) ──
app.get('/api/token/:address/security', (req, res) => {
  try {
    const data = analysis.getTokenSecurity(req.params.address);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TOKEN INFO ──
app.get('/api/token/:address', (req, res) => {
  try {
    const token = stmts.getToken.get(req.params.address.toLowerCase());
    if (!token) return res.status(404).json({ ok: false, error: 'Token not found' });
    const holderCount = analysis.getHolderCount(token.address);
    res.json({ ok: true, data: { ...token, holderCount } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TOKEN TRADES ──
// Pass ?pair=0x... (the pair/pool address — the frontend already has this from DexScreener,
// which identifies pairs correctly across every DEX protocol) to get protocol-agnostic buy/sell
// detection via plain Transfer events. Without it, falls back to the Uniswap-V2-only Swap decoder,
// which only works for pairs on actual V2 forks.
app.get('/api/token/:address/trades', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const trades = req.query.pair
      ? analysis.getTokenTradesByPair(req.params.address, req.query.pair, limit, offset)
      : analysis.getTokenTrades(req.params.address, limit, offset);
    res.json({ ok: true, data: trades });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DIAGNOSTIC: raw recent transfers for a token, no pair filter ──
// Use this to check whether a token's known pair address ever actually shows up as a from/to on a
// transfer — if it never does, that DEX routes trades through something other than the pair contract
// directly (an intermediary router/vault), and pair-based buy/sell detection won't work for it.
app.get('/api/token/:address/transfers', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = stmts.getTokenTransfers.all(req.params.address.toLowerCase(), limit, 0);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TOKEN TOP TRADERS ──
app.get('/api/token/:address/traders', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const traders = analysis.getTopTraders(req.params.address, limit);
    res.json({ ok: true, data: traders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TOKEN TOP HOLDERS ──
app.get('/api/token/:address/holders', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const holders = analysis.getTopHolders(req.params.address, limit);
    const count = analysis.getHolderCount(req.params.address);
    res.json({ ok: true, data: { holders, totalCount: count } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── WALLET ──
app.get('/api/wallet/:address', (req, res) => {
  try {
    const wallet = stmts.getWallet.get(req.params.address.toLowerCase());
    if (!wallet) return res.status(404).json({ ok: false, error: 'Wallet not found' });
    res.json({ ok: true, data: wallet });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── WALLET ACTIVITY ──
app.get('/api/wallet/:address/activity', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const activity = analysis.getWalletActivity(req.params.address, limit, offset);
    res.json({ ok: true, data: activity });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── WHALES ──
app.get('/api/whales', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const whales = analysis.getWhaleSwaps(limit);
    res.json({ ok: true, data: whales });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ALL TOKENS ──
app.get('/api/tokens', (req, res) => {
  try {
    const tokens = stmts.getAllTokens.all();
    res.json({ ok: true, data: tokens });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function start() {
  app.listen(config.PORT, () => {
    console.log(`[api] Hood Watcher API running on http://localhost:${config.PORT}`);
    console.log(`[api] Security endpoint: GET /api/token/:address/security`);
    console.log(`[api] Trades endpoint:   GET /api/token/:address/trades`);
    console.log(`[api] Whales endpoint:   GET /api/whales`);
  });
}

module.exports = { start, app };
