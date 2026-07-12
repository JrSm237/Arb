// ── TELEGRAM BOT COMMANDER ────────────────────────────────────────────────────
// Contrôle du bot de trading via commandes Telegram
// Commandes disponibles :
//   /start_bot   — Démarrer le bot avec la dernière config sauvegardée
//   /stop_bot    — Arrêter le bot
//   /status      — Voir l'état du bot + PnL + balances
//   /rapport     — Envoyer le rapport hebdomadaire
//   /ping        — Vérifier que le serveur est en ligne
//   /help        — Liste des commandes

require('dotenv').config();

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.toString();
const APP_URL = process.env.APP_URL || 'https://arbiscan-f4fk.onrender.com';

// Intervalle de keep-alive (13 minutes = 780 secondes)
const KEEPALIVE_INTERVAL = 13 * 60 * 1000;
let keepAliveTimer = null;

// ── ENVOI DE MESSAGE ──────────────────────────────────────────────────────────
async function send(chatId, text, extra = {}) {
  if (!TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...extra,
      }),
    });
  } catch(e) {
    console.error('[TG Commander] send error:', e.message);
  }
}

// ── VÉRIFIER QUE LE MESSAGE VIENT DU BON CHAT ────────────────────────────────
function isAuthorized(chatId) {
  return chatId?.toString() === CHAT_ID;
}

// ── TRAITEMENT DES COMMANDES ──────────────────────────────────────────────────
async function handleCommand(msg, tradeBot, loadBotConfig, saveBotConfig) {
  const chatId = msg.chat?.id?.toString();
  const text   = (msg.text || '').trim().toLowerCase();

  if (!isAuthorized(chatId)) {
    await send(chatId, '⛔ Accès non autorisé.');
    return;
  }

  console.log(`[TG] Commande reçue : ${text}`);

  // ── /help ──────────────────────────────────────────────────────────────────
  if (text === '/help' || text === '/start') {
    await send(chatId, `🤖 *ArbiScan Bot Commander*

*Commandes disponibles :*

⬡ *Bot de trading*
/start\\_bot — Relancer le bot (dernière config)
/stop\\_bot — Arrêter le bot
/status — État du bot + PnL + balances
/rapport — Rapport complet

🔧 *Serveur*
/ping — Vérifier que le serveur tourne
/keepalive\\_on — Activer le ping automatique toutes les 13min
/keepalive\\_off — Désactiver le ping automatique

📊 *Signaux*
/scan — Lancer un scan rapide (Top 30 paires)
/help — Afficher cette aide`);
    return;
  }

  // ── /ping ──────────────────────────────────────────────────────────────────
  if (text === '/ping') {
    const start = Date.now();
    try {
      await fetch(APP_URL + '/api/status');
      const ms = Date.now() - start;
      await send(chatId, `✅ *Serveur en ligne*\n\n⏱ Temps de réponse : \`${ms}ms\`\n🌐 URL : ${APP_URL}`);
    } catch(e) {
      await send(chatId, `❌ *Serveur inaccessible*\n\`${e.message}\``);
    }
    return;
  }

  // ── /keepalive_on ──────────────────────────────────────────────────────────
  if (text === '/keepalive_on') {
    startKeepAlive(chatId);
    await send(chatId, `✅ *Keep-alive activé*\n\nLe serveur sera pingé toutes les 13 minutes pour éviter la mise en veille.\n\n_Utilisez /keepalive\\_off pour désactiver._`);
    return;
  }

  // ── /keepalive_off ─────────────────────────────────────────────────────────
  if (text === '/keepalive_off') {
    stopKeepAlive();
    await send(chatId, `⏹ *Keep-alive désactivé*\n\nLe serveur peut se mettre en veille après 15 minutes d'inactivité.`);
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if (text === '/status') {
    const state = tradeBot.getState();
    const cfg   = state.config || {};
    const bals  = state.balances || {};
    const ex1   = cfg.exchange1 || cfg.EXCHANGE_1 || 'okx';
    const ex2   = cfg.exchange2 || cfg.EXCHANGE_2 || 'htx';

    const pnlColor = state.totalPnL >= 0 ? '🟢' : '🔴';

    await send(chatId, `📊 *Statut ArbiScan Bot*

🤖 *État :* ${state.running ? '🟢 Actif' : '🔴 Arrêté'}
💎 *Paire :* \`${cfg.selectedPair || cfg.SELECTED_PAIR || '—'}\`
🏦 *Exchanges :* \`${ex1.toUpperCase()} ↔ ${ex2.toUpperCase()}\`
🎯 *Mode :* ${cfg.DRY_RUN ? '🧪 Simulation' : '💰 Production'}
📈 *Spread min :* ${cfg.MIN_SPREAD_PCT || 2}%

💰 *PnL Total :* ${pnlColor} \`${(state.totalPnL||0).toFixed(4)} USDT\`
✅ *Trades réussis :* ${state.successTrades || 0}
❌ *Trades échoués :* ${state.failedTrades  || 0}

*Balances :*
${ex1.toUpperCase()} USDT : \`${(bals[ex1]?.USDT||0).toFixed(2)}\`
${ex2.toUpperCase()} USDT : \`${(bals[ex2]?.USDT||0).toFixed(2)}\`

_Mis à jour : ${new Date().toLocaleString('fr-FR')}_`);
    return;
  }

  // ── /start_bot ─────────────────────────────────────────────────────────────
  if (text === '/start_bot') {
    if (tradeBot.getState().running) {
      await send(chatId, '⚠️ Le bot est déjà en cours d\'exécution. Utilisez /status pour voir son état.');
      return;
    }
    const savedConfig = loadBotConfig();
    if (!savedConfig) {
      await send(chatId, `❌ *Aucune configuration sauvegardée*\n\nDémarrez le bot une première fois depuis le site pour sauvegarder la config :\n${APP_URL}`);
      return;
    }
    await send(chatId, `⏳ *Démarrage du bot...*\n\nPaire : \`${savedConfig.pair}\`\nExchanges : \`${savedConfig.exchange1?.toUpperCase()} ↔ ${savedConfig.exchange2?.toUpperCase()}\``);
    try {
      await tradeBot.start(savedConfig);
      await send(chatId, `✅ *Bot démarré avec succès !*\n\nIl tourne maintenant en arrière-plan. Utilisez /status pour suivre son activité.`);
    } catch(e) {
      await send(chatId, `❌ *Erreur au démarrage :*\n\`${e.message}\``);
    }
    return;
  }

  // ── /stop_bot ──────────────────────────────────────────────────────────────
  if (text === '/stop_bot') {
    tradeBot.stop();
    await send(chatId, `⏹ *Bot arrêté*\n\nLa configuration a été conservée. Utilisez /start\\_bot pour le relancer.`);
    return;
  }

  // ── /rapport ───────────────────────────────────────────────────────────────
  if (text === '/rapport') {
    await tradeBot.sendWeeklyReport();
    return; // Le rapport est envoyé par sendWeeklyReport directement
  }

  // ── /scan ──────────────────────────────────────────────────────────────────
  if (text === '/scan') {
    await send(chatId, '⏳ Scan en cours sur les Top 30 paires...');
    try {
      const r = await fetch(`${APP_URL}/api/scan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minSpread: 0.5, capital: 100, pairLimit: 30, usePriority: true }),
      });
      const d = await r.json();
      const opps = (d.opportunities || []).slice(0, 5);
      if (!opps.length) {
        await send(chatId, '📭 Aucun signal trouvé (spread > 0.5%) sur les Top 30 paires.');
        return;
      }
      const lines = opps.map((o, i) =>
        `${i+1}. *${o.symbol}* — +${o.spreadPct.toFixed(2)}%\n   ${o.buyExchange} → ${o.sellExchange} | +${o.netProfit.toFixed(3)} USDT`
      ).join('\n\n');
      await send(chatId, `⬡ *Top ${opps.length} signaux d'arbitrage*\n\n${lines}\n\n_Scan: ${(d.stats.scanDurationMs/1000).toFixed(1)}s — ${d.stats.totalSignals} signaux total_`);
    } catch(e) {
      await send(chatId, `❌ Erreur scan : ${e.message}`);
    }
    return;
  }

  // Commande non reconnue
  await send(chatId, `❓ Commande non reconnue : \`${text}\`\n\nTapez /help pour voir les commandes disponibles.`);
}

// ── KEEP-ALIVE : ping toutes les 13 minutes ───────────────────────────────────
function startKeepAlive(notifyChatId = null) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);

  keepAliveTimer = setInterval(async () => {
    try {
      const r = await fetch(APP_URL + '/api/status');
      if (r.ok) {
        console.log(`[Keep-alive] ✅ Ping réussi — ${new Date().toLocaleTimeString('fr')}`);
      }
    } catch(e) {
      console.error('[Keep-alive] ❌ Ping échoué:', e.message);
      // Notifier sur Telegram si le serveur ne répond pas
      if (notifyChatId && TOKEN) {
        await send(notifyChatId, `⚠️ *Keep-alive : ping échoué*\n\`${e.message}\``).catch(() => {});
      }
    }
  }, KEEPALIVE_INTERVAL);

  console.log(`[Keep-alive] ✅ Activé — ping toutes les ${KEEPALIVE_INTERVAL/60000} minutes`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log('[Keep-alive] ⏹ Désactivé');
  }
}

function isKeepAliveActive() {
  return keepAliveTimer !== null;
}

// ── WEBHOOK : recevoir les mises à jour Telegram ───────────────────────────────
// Appelé depuis server.js via app.post('/telegram-webhook', ...)
async function processUpdate(update, tradeBot, loadBotConfig, saveBotConfig) {
  try {
    const msg = update.message || update.edited_message;
    if (msg?.text) {
      await handleCommand(msg, tradeBot, loadBotConfig, saveBotConfig);
    }
  } catch(e) {
    console.error('[TG Commander] processUpdate error:', e.message);
  }
}

// ── CONFIGURER LE WEBHOOK TELEGRAM ────────────────────────────────────────────
async function setupWebhook(appUrl) {
  if (!TOKEN) {
    console.log('[TG Commander] TELEGRAM_BOT_TOKEN non configuré — webhook désactivé');
    return;
  }
  const webhookUrl = `${appUrl}/telegram-webhook`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
    });
    const d = await r.json();
    if (d.ok) {
      console.log(`[TG Commander] ✅ Webhook configuré → ${webhookUrl}`);
    } else {
      console.error('[TG Commander] ❌ Webhook échec:', d.description);
    }
  } catch(e) {
    console.error('[TG Commander] ❌ Webhook erreur:', e.message);
  }
}

module.exports = {
  handleCommand,
  processUpdate,
  setupWebhook,
  startKeepAlive,
  stopKeepAlive,
  isKeepAliveActive,
  send,
};
