const { stmts } = require('./db');

// How many blocks after pair creation counts as a "sniper"
const SNIPER_WINDOW = 5;

// Fresh wallet = first seen within the last 7 days (in seconds)
const FRESH_WINDOW = 7 * 24 * 3600;

function getTokenSecurity(tokenAddr) {
  const token = tokenAddr.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  return {
    topHolders: getTopHolders(token, 10),
    holderCount: getHolderCount(token),
    freshWallets: getFreshWallets(token, now),
    snipers: getSnipers(token),
    bundlers: getBundlers(token),
    devSold: getDevSold(token),
    top10Concentration: getTop10Concentration(token),
  };
}

function getTopHolders(token, limit = 10) {
  try {
    return stmts.getTopHolders.all(token, token, limit).map(r => ({
      address: r.addr,
      balance: r.balance,
    }));
  } catch (e) { return []; }
}

function getHolderCount(token) {
  try {
    return stmts.getTokenHolderCount.get(token, token)?.cnt || 0;
  } catch (e) { return 0; }
}

function getTop10Concentration(token) {
  try {
    const top10 = stmts.getTopHolders.all(token, token, 10);
    const totalHolder = stmts.getTopHolders.all(token, token, 99999);
    if (!totalHolder.length) return 0;
    const totalSupply = totalHolder.reduce((s, h) => s + h.balance, 0);
    if (totalSupply <= 0) return 0;
    const top10Sum = top10.reduce((s, h) => s + h.balance, 0);
    return parseFloat(((top10Sum / totalSupply) * 100).toFixed(2));
  } catch (e) { return 0; }
}

function getFreshWallets(token, now) {
  try {
    // Get all holders of this token
    const holders = stmts.getTopHolders.all(token, token, 99999);
    let fresh1d = 0, fresh7d = 0, total = holders.length;

    for (const h of holders) {
      const wallet = stmts.getWalletFirstSeen.get(h.address);
      if (!wallet) continue;
      const age = now - wallet.first_seen_time;
      if (age <= 86400) fresh1d++;
      if (age <= FRESH_WINDOW) fresh7d++;
    }

    return {
      fresh1d,
      fresh7d,
      total,
      pct1d: total > 0 ? parseFloat(((fresh1d / total) * 100).toFixed(1)) : 0,
      pct7d: total > 0 ? parseFloat(((fresh7d / total) * 100).toFixed(1)) : 0,
    };
  } catch (e) { return { fresh1d: 0, fresh7d: 0, total: 0, pct1d: 0, pct7d: 0 }; }
}

function getSnipers(token) {
  try {
    const earlyBuyers = stmts.getEarlyBuyers.all(token, token, SNIPER_WINDOW);
    const unique = [...new Set(earlyBuyers.map(b => b.sender))];
    return {
      count: unique.length,
      wallets: unique,
      blocksWindow: SNIPER_WINDOW,
    };
  } catch (e) { return { count: 0, wallets: [], blocksWindow: SNIPER_WINDOW }; }
}

function getBundlers(token) {
  try {
    const sameBlock = stmts.getSameBlockBuyers.all(token, token);
    // A "bundle" is multiple distinct wallets buying in the same block
    const bundled = [];
    for (const row of sameBlock) {
      const buyers = row.buyers.split(',');
      if (buyers.length >= 2) {
        bundled.push({
          block: row.block_number,
          count: buyers.length,
          wallets: buyers,
        });
      }
    }
    const uniqueBundledWallets = [...new Set(bundled.flatMap(b => b.wallets))];
    return {
      count: uniqueBundledWallets.length,
      bundles: bundled.length,
      wallets: uniqueBundledWallets,
    };
  } catch (e) { return { count: 0, bundles: 0, wallets: [] }; }
}

function getDevSold(token) {
  try {
    const tokenInfo = stmts.getToken.get(token);
    if (!tokenInfo || !tokenInfo.deployer) return { deployer: null, sold: false, transfers: [] };

    const deployerTransfers = stmts.getDeployerActivity.all(token);
    const totalSold = deployerTransfers.reduce((s, t) => s + parseFloat(t.amount), 0);

    // Check current deployer balance
    const holders = stmts.getTopHolders.all(token, token, 99999);
    const deployerHolding = holders.find(h => h.address === tokenInfo.deployer);
    const currentBalance = deployerHolding ? deployerHolding.balance : 0;

    return {
      deployer: tokenInfo.deployer,
      sold: deployerTransfers.length > 0,
      soldAmount: totalSold.toString(),
      currentBalance: currentBalance.toString(),
      transferCount: deployerTransfers.length,
      pctSold: currentBalance > 0 && totalSold > 0
        ? parseFloat(((totalSold / (totalSold + currentBalance)) * 100).toFixed(1))
        : deployerTransfers.length > 0 ? 100 : 0,
    };
  } catch (e) { return { deployer: null, sold: false, transfers: [] }; }
}

// Get recent trades for a token (swaps, not just transfers)
function getTokenTrades(token, limit = 50, offset = 0) {
  try {
    return stmts.getTokenSwaps.all(token, token, limit, offset);
  } catch (e) { return []; }
}

// Top traders by on-chain swap activity. No price oracle is wired in, so this ranks by trade
// count rather than realized USD profit — honestly labeled "trades" in the response, not "profit".
function getTopTraders(token, limit = 20) {
  try {
    return stmts.getTokenTraderStats.all(token, token, limit).map(r => ({
      wallet: r.wallet,
      trades: r.trades,
      buys: r.buys,
      sells: r.sells,
      lastBlock: r.last_block,
    }));
  } catch (e) { return []; }
}

// Protocol-agnostic version of getTokenTrades: given a pair address (the caller already knows
// this — e.g. from DexScreener, which correctly identifies the pair regardless of DEX protocol),
// derive buy/sell directly from ERC-20 Transfer direction instead of trying to decode that DEX's
// own Swap event. A transfer FROM the pair TO a wallet is a buy; FROM a wallet TO the pair is a sell.
function getTokenTradesByPair(token, pairAddr, limit = 50, offset = 0) {
  try {
    const t = token.toLowerCase();
    const pair = pairAddr.toLowerCase();
    return stmts.getPairTransfers.all(t, pair, pair, limit, offset).map(r => {
      const isBuy = r.from_addr === pair;
      const wallet = isBuy ? r.to_addr : r.from_addr;
      return {
        type: isBuy ? 'buy' : 'sell',
        wallet,
        amount: r.amount,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        timestamp: r.timestamp,
      };
    });
  } catch (e) { return []; }
}

// Get wallet activity
function getWalletActivity(address, limit = 50, offset = 0) {
  const addr = address.toLowerCase();
  try {
    return stmts.getWalletTransfers.all(addr, addr, limit, offset);
  } catch (e) { return []; }
}

// Get recent whale-sized swaps across all pairs
function getWhaleSwaps(limit = 20) {
  try {
    const recent = stmts.getRecentSwaps.all(500);
    // Filter for large amounts — this is a rough filter
    // In practice you'd compare against token price, but without price data
    // we use raw amount thresholds
    return recent
      .filter(s => {
        const maxAmount = Math.max(
          parseFloat(s.amount0_in || 0),
          parseFloat(s.amount1_in || 0),
          parseFloat(s.amount0_out || 0),
          parseFloat(s.amount1_out || 0)
        );
        return maxAmount > 1e18; // rough: more than 1 full token unit in raw
      })
      .slice(0, limit);
  } catch (e) { return []; }
}

module.exports = {
  getTokenSecurity,
  getTopHolders,
  getHolderCount,
  getTokenTrades,
  getTokenTradesByPair,
  getTopTraders,
  getWalletActivity,
  getWhaleSwaps,
  getDevSold,
  getSnipers,
  getBundlers,
  getFreshWallets,
  getTop10Concentration,
};
