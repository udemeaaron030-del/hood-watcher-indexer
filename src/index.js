const indexer = require('./indexer');
const api = require('./api');

console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║     hood watcher — indexer + api      ║');
console.log('  ║   Track · Analyze · Stay Ahead        ║');
console.log('  ╚══════════════════════════════════════╝');
console.log('');

// Start the API server first so it can serve status even during backfill
api.start();

// Then start the indexer
indexer.start().catch(err => {
  console.error('[fatal] Indexer crashed:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  indexer.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  indexer.stop();
  process.exit(0);
});
