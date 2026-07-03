// Out-of-band notifier used by CI when bookkeeping (the git commit/push of the
// updated DB) fails. It exists to keep a git/bookkeeping failure clearly
// DISTINCT from a trading-cycle failure: a green trading cycle must never be
// hidden behind a red git step, nor vice versa.
//
//   node src/notify.js commit-failed "<detail>"
//
// Strictly best-effort: logs a DB_COMMIT_FAILED event and sends a Telegram
// alert, and never exits non-zero (CI calls it with `|| true` anyway).
import { getDb, logEvent } from './db.js';
import { sendAlert } from './alert.js';

async function main() {
  const kind = process.argv[2];
  const detail = process.argv[3] || 'unspecified';
  if (kind === 'commit-failed') {
    try { logEvent('DB_COMMIT_FAILED', { detail }); } catch { /* DB may be unwritable */ }
    await sendAlert(
      `🟠 TradePilot-Futures: DB commit/push FAILED (${detail}).\n` +
      'This is a bookkeeping/git failure, NOT a trading failure — the cycle itself ran fine. ' +
      'The next run will reconcile the DB.',
    );
  }
}

main()
  .catch(() => { /* never fail CI on the notifier */ })
  .finally(() => process.exit(0));
