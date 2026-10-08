const { createPublicClient, http, parseAbiItem, decodeEventLog, formatEther } = require('viem');
const { db, stmts } = require('./db');
const config = require('./config');

const client = createPublicClient({
  chain: { id: config.CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.RPC_URL] } } },
  transport: http(config.RPC_URL, { retryCount: 3, retryDelay: 1000 }),
});

// ABI fragments for decoding
const TRANSFER_ABI = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const SWAP_V2_ABI = parseAbiItem('event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)');
const PAIR_CREATED_ABI = parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)');

let isRunning = false;
let stats = { blocksIndexed: 0, transfers: 0, swaps: 0, pairs: 0, errors: 0 };

async function getLatestBlockNumber() {
  return Number(await client.getBlockNumber());
}

function getLastIndexedBlock() {
  const row = stmts.getMeta.get('last_block');
  return row ? parseInt(row.value) : null;
}

function setLastIndexedBlock(n) {
  stmts.setMeta.run('last_block', String(n));
}

async function indexBlock(blockNum) {
  try {
    const block = await client.getBlock({ blockNumber: BigInt(blockNum), includeTransactions: true });
    if (!block) return;

    const timestamp = Number(block.timestamp);
    const txCount = block.transactions.length;

    // Store block
    stmts.insertBlock.run(blockNum, block.hash, timestamp, txCount);

    // Get all logs for this block
    let logs = [];
    try {
      logs = await client.getLogs({
        fromBlock: BigInt(blockNum),
        toBlock: BigInt(blockNum),
      });
    } catch (e) {
      // Some RPCs don't support unfiltered getLogs — fall back to per-tx receipts
      for (const tx of block.transactions) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });
          if (receipt?.logs) logs.push(...receipt.logs);
        } catch (e2) { /* skip */ }
      }
    }

    // DIAGNOSTIC: log what's actually coming back from the RPC every ~200 blocks, so we can see
    // whether Transfer-topic logs are present at all and why they might not be matching/decoding.
    if (stats.blocksIndexed % 200 === 0 && logs.length > 0) {
      const topicCounts = {};
      for (const log of logs) {
        const t = log.topics[0] || '(no topic0)';
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }
      console.log(`[diag] Block ${blockNum}: ${logs.length} total logs`);
      console.log(`[diag] TRANSFER constant: ${config.EVENTS.TRANSFER}`);
      console.log(`[diag] Topic0 breakdown:`, JSON.stringify(topicCounts, null, 2));
    }

    // Batch insert in a transaction for speed
    const insertAll = db.transaction(() => {
      for (const log of logs) {
        const topic0 = log.topics[0];

        // ── TRANSFER ──
        if (topic0 === config.EVENTS.TRANSFER && log.topics.length >= 3) {
          try {
            const decoded = decodeEventLog({ abi: [TRANSFER_ABI], data: log.data, topics: log.topics });
            const from = decoded.args.from.toLowerCase();
            const to = decoded.args.to.toLowerCase();
            const amount = decoded.args.value.toString();
            const token = log.address.toLowerCase();

            stmts.insertTransfer.run(log.transactionHash, blockNum, timestamp, token, from, to, amount);
            stmts.upsertWallet.run(from, blockNum, timestamp);
            stmts.upsertWallet.run(to, blockNum, timestamp);
            stats.transfers++;
          } catch (e) {
            if (stats.transfers === 0 && Math.random() < 0.01) console.log('[diag] Transfer decode FAILED:', e.message);
          }
        }

        // ── SWAP (Uniswap V2) ──
        if (topic0 === config.EVENTS.SWAP_V2 && log.topics.length >= 3) {
          try {
            const decoded = decodeEventLog({ abi: [SWAP_V2_ABI], data: log.data, topics: log.topics });
            const sender = decoded.args.sender.toLowerCase();
            const to = decoded.args.to.toLowerCase();
            const pair = log.address.toLowerCase();

            const a0in = decoded.args.amount0In.toString();
            const a1in = decoded.args.amount1In.toString();
            const a0out = decoded.args.amount0Out.toString();
            const a1out = decoded.args.amount1Out.toString();

            // is_buy = token0 coming out (buying token0 with token1)
            const isBuy = BigInt(a0out) > 0n ? 1 : 0;

            stmts.insertSwap.run(log.transactionHash, blockNum, timestamp, pair, sender, to, a0in, a1in, a0out, a1out, isBuy);
            stmts.upsertWallet.run(sender, blockNum, timestamp);
            stats.swaps++;
          } catch (e) { /* not a standard V2 swap */ }
        }

        // ── PAIR CREATED ──
        if (topic0 === config.EVENTS.PAIR_CREATED && log.topics.length >= 3) {
          try {
            const decoded = decodeEventLog({ abi: [PAIR_CREATED_ABI], data: log.data, topics: log.topics });
            const token0 = decoded.args.token0.toLowerCase();
            const token1 = decoded.args.token1.toLowerCase();
            const pair = decoded.args.pair.toLowerCase();
            const factory = log.address.toLowerCase();

            stmts.insertPair.run(pair, token0, token1, factory, blockNum, timestamp);
            stats.pairs++;
          } catch (e) { /* not a standard pair creation */ }
        }
      }

      // Track contract deployments (tokens)
      for (const tx of block.transactions) {
        if (tx.to === null || tx.to === '0x') {
          // Contract creation
          const deployer = tx.from.toLowerCase();
          stmts.upsertWallet.run(deployer, blockNum, timestamp);
        }
      }
    });

    insertAll();
    setLastIndexedBlock(blockNum);
    stats.blocksIndexed++;

    if (stats.blocksIndexed % 100 === 0) {
      console.log(`[indexer] Block ${blockNum} | ${stats.blocksIndexed} blocks | ${stats.transfers} transfers | ${stats.swaps} swaps | ${stats.pairs} pairs`);
    }
  } catch (e) {
    stats.errors++;
    if (stats.errors % 10 === 1) {
      console.error(`[indexer] Error at block ${blockNum}:`, e.message);
    }
  }
}

async function start() {
  if (isRunning) return;
  isRunning = true;
  console.log('[indexer] Starting...');

  const latestOnChain = await getLatestBlockNumber();
  let lastIndexed = getLastIndexedBlock();

  if (lastIndexed === null) {
    // First run — start from BACKFILL_BLOCKS ago
    lastIndexed = Math.max(0, latestOnChain - config.BACKFILL_BLOCKS);
    console.log(`[indexer] First run — backfilling from block ${lastIndexed} (${config.BACKFILL_BLOCKS} blocks back)`);
  } else {
    console.log(`[indexer] Resuming from block ${lastIndexed + 1}`);
  }

  // Backfill
  const backfillEnd = latestOnChain;
  for (let i = lastIndexed + 1; i <= backfillEnd; i++) {
    if (!isRunning) break;
    await indexBlock(i);
    // Rate-limit to avoid hammering the public RPC
    if (i % 5 === 0) await sleep(200);
  }

  console.log(`[indexer] Backfill complete. Now watching for new blocks...`);

  // Live polling
  while (isRunning) {
    try {
      const latest = await getLatestBlockNumber();
      const last = getLastIndexedBlock() || 0;
      for (let i = last + 1; i <= latest; i++) {
        await indexBlock(i);
      }
    } catch (e) {
      console.error('[indexer] Poll error:', e.message);
    }
    await sleep(config.POLL_INTERVAL);
  }
}

function stop() {
  isRunning = false;
  console.log('[indexer] Stopping...');
}

function getStats() {
  return {
    ...stats,
    lastBlock: getLastIndexedBlock(),
    totalBlocks: stmts.getIndexedBlockCount.get()?.cnt || 0,
    totalTransfers: stmts.getTotalTransfers.get()?.cnt || 0,
    totalSwaps: stmts.getTotalSwaps.get()?.cnt || 0,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, stop, getStats, client };
