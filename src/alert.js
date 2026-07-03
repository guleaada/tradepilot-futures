// Telegram alerting. Strictly best-effort: when TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID are unset this is a no-op, and no failure path ever throws
// or blocks the trading cycle.
import { config } from './config.js';

export async function sendAlert(message, cfg = config) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: String(message).slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false; // alerting must never break the loop
  }
}
