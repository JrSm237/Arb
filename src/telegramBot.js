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

// Fusionne un changement de config live (via Telegram) dans bot_config.json,
// pour qu'il survive à un redémarrage automatique du serveur.
function persistLiveConfig(loadBotConfig, saveBotConfig, changes) {
  try {
    const current = loadBotConfig() || {};
    saveBotConfig({ ...current, ...changes, autoRestart: true });
  } catch (e) {
    console.error('[TG Commander] Échec sauvegarde config live:', e.message);
  }
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
/status — État du bot + PnL + balances + position
/close\\_position — Clôturer la position en cours maintenant
/rapport — Rapport complet

⚙️ *Configuration à chaud*
/config — Voir la configuration actuelle
/spread \\<valeur\\> — Écart minimum, ex: \`/spread 2.5\`
/stoploss \\<valeur\\> — Stop-loss, ex: \`/stoploss 5\`
/capital \\<c1\\> \\<c2\\> — Capital par exchange, ex: \`/capital 10 15\`
/pair \\<SYMBOL\\> — Changer de paire, ex: \`/pair BTC/USDT\`
/mode sim|prod — Basculer Simulation/Production

🔧 *Serveur*
/ping — Vérifier que le serveur tourne
/keepalive\\_on — Activer le ping automatique toutes les 13min
/keepalive\\_off — Désactiver le ping automatique

/help — Afficher cette aide`);
    return;
  }

  // ── /ping ──────────────────────────────────────────────────────────────────
  if (text === '/ping') {
    const start = Date.now();
    try {
      await fetch(APP_URL + '/api/bot/status');
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
    const state = await tradeBot.getState();
    const cfg   = state.config || {};
    const bals  = state.balances || {};
    const ex1   = cfg.exchange1 || 'okx';
    const ex2   = cfg.exchange2 || 'htx';

    const pnlColor = state.totalPnL >= 0 ? '🟢' : '🔴';
    const posLine = state.position
      ? `\n🟢 *Position ouverte* sur \`${state.position.exchange}\` — ${state.position.quantity.toFixed(6)} unités @ $${state.position.entryPrice}${state.position.netGainPct != null ? ` (${state.position.netGainPct>=0?'+':''}${state.position.netGainPct.toFixed(2)}% net)` : ''}\n`
      : '\n⚪ Aucune position ouverte\n';

    await send(chatId, `📊 *Statut ArbiScan Bot*

🤖 *État :* ${state.running ? '🟢 Actif' : '🔴 Arrêté'}
💎 *Paire :* \`${cfg.selectedPair || '—'}\`
🏦 *Exchanges :* \`${ex1.toUpperCase()} ↔ ${ex2.toUpperCase()}\`
🎯 *Mode :* ${cfg.dryRun ? '🧪 Simulation' : '💰 Production'}
📈 *Écart min :* ${cfg.minSpreadPct || 2}% · 🛑 *Stop-loss :* ${cfg.stopLossPct || 5}%
${posLine}
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
    if ((await tradeBot.getState()).running) {
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

  // ── /config ────────────────────────────────────────────────────────────────
  if (text === '/config') {
    const cfg = tradeBot.getConfig();
    await send(chatId, `⚙️ *Configuration actuelle*

🏦 *Exchanges :* \`${cfg.exchange1?.toUpperCase() || '—'} ↔ ${cfg.exchange2?.toUpperCase() || '—'}\`
💎 *Paire :* \`${cfg.pair || '—'}\`
💵 *Capital :* ${cfg.capital1} / ${cfg.capital2} USDT
📈 *Écart min :* ${cfg.minSpreadPct}%
🛑 *Stop-loss :* ${cfg.stopLossPct}%
🎯 *Mode :* ${cfg.dryRun ? '🧪 Simulation' : '💰 Production'}

*Pour modifier :*
/spread \\<valeur\\> — écart minimum (%)
/stoploss \\<valeur\\> — stop-loss (%)
/capital \\<c1\\> \\<c2\\> — capital par exchange
/pair \\<SYMBOL\\> — ex: BTC/USDT
/mode sim|prod — changer de mode
/close\\_position — clôturer la position en cours`);
    return;
  }

  // ── /spread <valeur> ──────────────────────────────────────────────────────
  if (text.startsWith('/spread')) {
    const val = parseFloat(text.split(' ')[1]);
    if (isNaN(val) || val <= 0) {
      await send(chatId, '⚠️ Usage : `/spread 2.5` (valeur en %)');
      return;
    }
    const applied = tradeBot.updateConfig({ minSpreadPct: val });
    persistLiveConfig(loadBotConfig, saveBotConfig, { minSpreadPct: applied.minSpreadPct });
    await send(chatId, `✅ Écart minimum mis à jour : *${applied.minSpreadPct}%*`);
    return;
  }

  // ── /stoploss <valeur> ────────────────────────────────────────────────────
  if (text.startsWith('/stoploss')) {
    const val = parseFloat(text.split(' ')[1]);
    if (isNaN(val) || val <= 0) {
      await send(chatId, '⚠️ Usage : `/stoploss 5` (valeur en %)');
      return;
    }
    const applied = tradeBot.updateConfig({ stopLossPct: val });
    persistLiveConfig(loadBotConfig, saveBotConfig, { stopLossPct: applied.stopLossPct });
    await send(chatId, `✅ Stop-loss mis à jour : *-${applied.stopLossPct}%*`);
    return;
  }

  // ── /capital <c1> <c2> ────────────────────────────────────────────────────
  if (text.startsWith('/capital')) {
    const parts = text.split(' ');
    const c1 = parseFloat(parts[1]), c2 = parseFloat(parts[2]);
    if (isNaN(c1) || isNaN(c2) || c1 <= 0 || c2 <= 0) {
      await send(chatId, '⚠️ Usage : `/capital 10 10` (montant USDT par exchange)');
      return;
    }
    const applied = tradeBot.updateConfig({ capital1: c1, capital2: c2 });
    persistLiveConfig(loadBotConfig, saveBotConfig, { capital1: applied.capital1, capital2: applied.capital2 });
    await send(chatId, `✅ Capital mis à jour : *${applied.capital1} / ${applied.capital2} USDT*\n\n_S'applique à la prochaine entrée en position — pas d'effet sur une position déjà ouverte._`);
    return;
  }

  // ── /pair <SYMBOL> ────────────────────────────────────────────────────────
  if (text.startsWith('/pair')) {
    const sym = (msg.text.split(' ')[1] || '').trim().toUpperCase();
    if (!/^[A-Z0-9]+\/USDT$/.test(sym)) {
      await send(chatId, '⚠️ Usage : `/pair BTC/USDT` (doit finir par /USDT)');
      return;
    }
    const state = await tradeBot.getState();
    if (state.position) {
      await send(chatId, `⚠️ Impossible de changer de paire : une position est ouverte sur \`${state.position.symbol}\`. Utilisez /close\\_position d'abord.`);
      return;
    }
    const applied = tradeBot.updateConfig({ pair: sym });
    persistLiveConfig(loadBotConfig, saveBotConfig, { pair: applied.pair });
    await send(chatId, `✅ Paire mise à jour : *${applied.pair}*`);
    return;
  }

  // ── /mode sim|prod ────────────────────────────────────────────────────────
  if (text.startsWith('/mode')) {
    const arg = text.split(' ')[1];
    if (arg !== 'sim' && arg !== 'prod') {
      await send(chatId, '⚠️ Usage : `/mode sim` ou `/mode prod`');
      return;
    }
    const state = await tradeBot.getState();
    if (state.position) {
      await send(chatId, `⚠️ Impossible de changer de mode : une position est ouverte. Utilisez /close\\_position d'abord.`);
      return;
    }
    const dryRun = arg === 'sim';
    const applied = tradeBot.updateConfig({ dryRun });
    persistLiveConfig(loadBotConfig, saveBotConfig, { dryRun: applied.dryRun });
    await send(chatId, dryRun
      ? `✅ Mode *Simulation* activé — plus aucun ordre réel ne sera passé.`
      : `⚠️✅ Mode *Production* activé — le bot va maintenant passer de VRAIS ordres avec de l'argent réel.`);
    return;
  }

  // ── /close_position ───────────────────────────────────────────────────────
  if (text === '/close_position') {
    const state = await tradeBot.getState();
    if (!state.position) {
      await send(chatId, 'ℹ️ Aucune position ouverte actuellement.');
      return;
    }
    await send(chatId, `⏳ Clôture manuelle de la position sur \`${state.position.exchange}\`...`);
    const result = await tradeBot.sellPosition('manuel');
    if (!result.ok) {
      await send(chatId, `❌ Échec de la clôture : ${result.reason}`);
    }
    // Le message de confirmation détaillé est déjà envoyé par sellPosition() elle-même
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
      const r = await fetch(APP_URL + '/api/bot/status');
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
