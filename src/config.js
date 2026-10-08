require('dotenv').config();

module.exports = {
  RPC_URL: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  PORT: parseInt(process.env.PORT || '3001'),
  BACKFILL_BLOCKS: parseInt(process.env.BACKFILL_BLOCKS || '5000'),
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL || '500'),
  FRONTEND_URL: process.env.FRONTEND_URL || '*',
  CHAIN_ID: 4663,

  // Uniswap V2 event signatures (Robinhood Chain DEXes are Uni V2 forks)
  EVENTS: {
    TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    PAIR_CREATED: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  },

  // Known DEX factory addresses — add more as you find them
  DEX_FACTORIES: [],

  // Whale threshold in ETH value
  WHALE_THRESHOLD_ETH: 1,
};
