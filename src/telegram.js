// ── MODULE TELEGRAM — ENVOI DE MESSAGES ──────────────────────────────────────
// Nécessite dans .env :
//   TELEGRAM_BOT_TOKEN=123456:ABC-xxx
//   TELEGRAM_CHAT_ID=-100xxxxxxxxxx  (groupe) ou @username ou votre ID perso

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Envoie un message Telegram
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠ Telegram non configuré (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant)');
    return false;
  }

  try {
    const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await resp.json();
    if (!data.ok) {
      console.error('Telegram error:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram fetch error:', err.message);
    return false;
  }
}

// Message de démarrage
async function sendStartupMessage() {
  const text = `✅ *ArbiScan Bot démarré*\n\nLe serveur est en ligne. Utilisez /status pour voir l'état du bot de trading, ou /help pour la liste des commandes.`;
  await sendTelegram(text);
}

module.exports = { sendTelegram, sendStartupMessage };
