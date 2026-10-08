const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'indexer.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── SCHEMA ──
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    number INTEGER PRIMARY KEY,
    hash TEXT,
    timestamp INTEGER,
    tx_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY,
    first_seen_block INTEGER,
    first_seen_time INTEGER,
    tx_count INTEGER DEFAULT 0,
    label TEXT
  );

  CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    decimals INTEGER,
    deployer TEXT,
    deploy_block INTEGER,
    deploy_time INTEGER,
    pair_address TEXT
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT,
    block_number INTEGER,
    timestamp INTEGER,
    token TEXT,
    from_addr TEXT,
    to_addr TEXT,
    amount TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_transfers_token ON transfers(token);
  CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_addr);
  CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_addr);
  CREATE INDEX IF NOT EXISTS idx_transfers_block ON transfers(block_number);

  CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT,
    block_number INTEGER,
    timestamp INTEGER,
    pair TEXT,
    sender TEXT,
    to_addr TEXT,
    amount0_in TEXT,
    amount1_in TEXT,
    amount0_out TEXT,
    amount1_out TEXT,
    is_buy INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_swaps_pair ON swaps(pair);
  CREATE INDEX IF NOT EXISTS idx_swaps_sender ON swaps(sender);
  CREATE INDEX IF NOT EXISTS idx_swaps_block ON swaps(block_number);

  CREATE TABLE IF NOT EXISTS pairs (
    address TEXT PRIMARY KEY,
    token0 TEXT,
    token1 TEXT,
    factory TEXT,
    created_block INTEGER,
    created_time INTEGER
  );
`);

// ── MIGRATION: drop a stale FOREIGN KEY constraint on transfers(token) from an earlier schema.
// That constraint required a matching row in `tokens` before any transfer could be inserted, but
// nothing ever populated `tokens` for arbitrary ERC-20s — so every transfer insert was silently
// rejected. CREATE TABLE IF NOT EXISTS above won't touch an already-existing table, so this check
// runs every startup and rebuilds `transfers` without the constraint if the old one is still there.
const transfersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='transfers'`).get();
if (transfersSql && transfersSql.sql && transfersSql.sql.includes('FOREIGN KEY')) {
  console.log('[db] Migrating transfers table: removing stale FOREIGN KEY constraint...');
  db.exec(`
    ALTER TABLE transfers RENAME TO transfers_old;
    CREATE TABLE transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT,
      block_number INTEGER,
      timestamp INTEGER,
      token TEXT,
      from_addr TEXT,
      to_addr TEXT,
      amount TEXT
    );
    INSERT INTO transfers (id, tx_hash, block_number, timestamp, token, from_addr, to_addr, amount)
      SELECT id, tx_hash, block_number, timestamp, token, from_addr, to_addr, amount FROM transfers_old;
    DROP TABLE transfers_old;
    CREATE INDEX IF NOT EXISTS idx_transfers_token ON transfers(token);
    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_addr);
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_addr);
    CREATE INDEX IF NOT EXISTS idx_transfers_block ON transfers(block_number);
  `);
  console.log('[db] Migration complete.');
}

// ── PREPARED STATEMENTS ──
const stmts = {
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),

  insertBlock: db.prepare('INSERT OR IGNORE INTO blocks (number, hash, timestamp, tx_count) VALUES (?, ?, ?, ?)'),

  upsertWallet: db.prepare(`
    INSERT INTO wallets (address, first_seen_block, first_seen_time, tx_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(address) DO UPDATE SET tx_count = tx_count + 1
  `),

  insertToken: db.prepare(`
    INSERT OR IGNORE INTO tokens (address, name, symbol, decimals, deployer, deploy_block, deploy_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  insertTransfer: db.prepare(`
    INSERT INTO transfers (tx_hash, block_number, timestamp, token, from_addr, to_addr, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  insertSwap: db.prepare(`
    INSERT INTO swaps (tx_hash, block_number, timestamp, pair, sender, to_addr,
      amount0_in, amount1_in, amount0_out, amount1_out, is_buy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  insertPair: db.prepare(`
    INSERT OR IGNORE INTO pairs (address, token0, token1, factory, created_block, created_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  // ── QUERIES ──
  getToken: db.prepare('SELECT * FROM tokens WHERE address = ?'),
  getWallet: db.prepare('SELECT * FROM wallets WHERE address = ?'),
  getPair: db.prepare('SELECT * FROM pairs WHERE address = ?'),

  getTokenTransfers: db.prepare(`
    SELECT * FROM transfers WHERE token = ?
    ORDER BY block_number DESC LIMIT ? OFFSET ?
  `),

  // Protocol-agnostic trade detection: any DEX (Uniswap V2/V3/V4, or a custom AMM like
  // flapsh) still moves the token via a standard ERC-20 Transfer to/from its pair address —
  // so instead of decoding each protocol's own Swap event, this just watches plain transfers
  // in and out of a known pair address. Works no matter what the pair's own contract is.
  getPairTransfers: db.prepare(`
    SELECT * FROM transfers
    WHERE token = ? AND (from_addr = ? OR to_addr = ?)
    ORDER BY block_number DESC LIMIT ? OFFSET ?
  `),

  // Auto-detect the real trading contract for a token: whichever address shows up most often
  // as a transfer counterparty is almost certainly the pool/vault/bonding-curve contract actually
  // moving the token — this works even when a DEX's real custody contract doesn't match whatever
  // address an aggregator like DexScreener reports as the "pair" (true for some launchpad-style AMMs).
  getTopTransferCounterparty: db.prepare(`
    SELECT addr, COUNT(*) as cnt FROM (
      SELECT from_addr as addr FROM transfers WHERE token = ?
      UNION ALL
      SELECT to_addr as addr FROM transfers WHERE token = ?
    )
    WHERE addr != '0x0000000000000000000000000000000000000000'
    GROUP BY addr
    ORDER BY cnt DESC
    LIMIT 1
  `),

  getTokenSwaps: db.prepare(`
    SELECT s.*, p.token0, p.token1 FROM swaps s
    JOIN pairs p ON s.pair = p.address
    WHERE p.token0 = ? OR p.token1 = ?
    ORDER BY s.block_number DESC LIMIT ? OFFSET ?
  `),

  getWalletTransfers: db.prepare(`
    SELECT * FROM transfers WHERE from_addr = ? OR to_addr = ?
    ORDER BY block_number DESC LIMIT ? OFFSET ?
  `),

  getTopHolders: db.prepare(`
    SELECT
      addr,
      SUM(CASE WHEN direction = 'in' THEN CAST(amount AS REAL) ELSE -CAST(amount AS REAL) END) as balance
    FROM (
      SELECT to_addr as addr, amount, 'in' as direction FROM transfers WHERE token = ?
      UNION ALL
      SELECT from_addr as addr, amount, 'out' as direction FROM transfers WHERE token = ?
    )
    GROUP BY addr
    HAVING balance > 0
    ORDER BY balance DESC
    LIMIT ?
  `),

  getTokenHolderCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM (
      SELECT addr,
        SUM(CASE WHEN direction = 'in' THEN CAST(amount AS REAL) ELSE -CAST(amount AS REAL) END) as balance
      FROM (
        SELECT to_addr as addr, amount, 'in' as direction FROM transfers WHERE token = ?
        UNION ALL
        SELECT from_addr as addr, amount, 'out' as direction FROM transfers WHERE token = ?
      )
      GROUP BY addr
      HAVING balance > 0
    )
  `),

  getRecentSwaps: db.prepare(`
    SELECT s.*, p.token0, p.token1 FROM swaps s
    JOIN pairs p ON s.pair = p.address
    ORDER BY s.block_number DESC LIMIT ?
  `),

  getWalletFirstSeen: db.prepare('SELECT first_seen_block, first_seen_time FROM wallets WHERE address = ?'),

  // Sniper detection: wallets that bought within N blocks of pair creation
  getEarlyBuyers: db.prepare(`
    SELECT s.sender, s.block_number, p.created_block,
      (s.block_number - p.created_block) as blocks_after
    FROM swaps s
    JOIN pairs p ON s.pair = p.address
    WHERE (p.token0 = ? OR p.token1 = ?) AND s.is_buy = 1
      AND (s.block_number - p.created_block) <= ?
    ORDER BY s.block_number ASC
  `),

  // Bundler detection: multiple wallets buying in the same block
  getSameBlockBuyers: db.prepare(`
    SELECT block_number, GROUP_CONCAT(sender) as buyers, COUNT(*) as cnt
    FROM swaps
    WHERE pair IN (SELECT address FROM pairs WHERE token0 = ? OR token1 = ?)
      AND is_buy = 1
    GROUP BY block_number
    HAVING cnt >= 2
    ORDER BY block_number ASC
  `),

  getDeployerActivity: db.prepare(`
    SELECT t.address as token, t.deployer, tr.amount, tr.block_number, tr.timestamp
    FROM tokens t
    JOIN transfers tr ON tr.token = t.address AND tr.from_addr = t.deployer
    WHERE t.address = ?
    ORDER BY tr.block_number ASC
  `),

  // Top traders for a token: ranked by number of swaps (no USD price data available,
  // so this is on-chain trade activity, not realized profit — labeled as such in the API response)
  getTokenTraderStats: db.prepare(`
    SELECT sender as wallet,
      COUNT(*) as trades,
      SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) as buys,
      SUM(CASE WHEN is_buy = 0 THEN 1 ELSE 0 END) as sells,
      MAX(s.block_number) as last_block
    FROM swaps s
    JOIN pairs p ON s.pair = p.address
    WHERE p.token0 = ? OR p.token1 = ?
    GROUP BY sender
    ORDER BY trades DESC
    LIMIT ?
  `),

  getAllTokens: db.prepare('SELECT * FROM tokens ORDER BY deploy_block DESC'),
  getIndexedBlockCount: db.prepare('SELECT COUNT(*) as cnt FROM blocks'),
  getLatestBlock: db.prepare('SELECT MAX(number) as num FROM blocks'),
  getTotalTransfers: db.prepare('SELECT COUNT(*) as cnt FROM transfers'),
  getTotalSwaps: db.prepare('SELECT COUNT(*) as cnt FROM swaps'),
};

module.exports = { db, stmts };
