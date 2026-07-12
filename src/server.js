require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const express    = require('express');
const cors       = require('cors');
const ccxt       = require('ccxt');
const { sendTelegram, sendStartupMessage } = require('./telegram');
const tradeBot    = require('./tradeBot');
const tgCommander = require('./telegramBot');

const app  = express();
const PORT    = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://arbiscan-f4fk.onrender.com';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ── FILETS DE SÉCURITÉ GLOBAUX ────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Promise Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err?.message || err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── EXCHANGES SUPPORTÉS PAR LE BOT (4 max, pour limiter la RAM utilisée) ─────
const EXCHANGE_IDS = ['bybit', 'mexc', 'htx', 'kucoin'];

// ── PERSISTANCE CONFIG BOT ────────────────────────────────────────────────────
const BOT_CONFIG_FILE = path.join(__dirname, '..', 'bot_config.json');

function saveBotConfig(config) {
  try {
    const toSave = {
      pair:         config.pair,
      exchange1:    config.exchange1,
      exchange2:    config.exchange2,
      capital1:     config.capital1,
      capital2:     config.capital2,
      minSpreadPct: config.minSpreadPct,
      dryRun:       config.dryRun,
      // Encodage simple (base64) — évite l'exposition en clair dans les logs.
      // Ce n'est PAS un chiffrement fort : bot_config.json ne doit jamais être exposé publiquement.
      apiConfigs: config.apiConfigs ? encodeAPIs(config.apiConfigs) : null,
      savedAt: new Date().toISOString(),
      autoRestart: true,
    };
    fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(toSave, null, 2));
    console.log('💾 Config bot sauvegardée');
  } catch(e) {
    console.error('Erreur sauvegarde config bot:', e.message);
  }
}

function loadBotConfig() {
  try {
    if (!fs.existsSync(BOT_CONFIG_FILE)) return null;
    const raw = fs.readFileSync(BOT_CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.apiConfigs) cfg.apiConfigs = decodeAPIs(cfg.apiConfigs);
    console.log('📂 Config bot restaurée:', cfg.pair, cfg.exchange1, '↔', cfg.exchange2);
    return cfg;
  } catch(e) {
    console.error('Erreur chargement config bot:', e.message);
    return null;
  }
}

function clearBotConfig() {
  try {
    if (fs.existsSync(BOT_CONFIG_FILE)) {
      fs.unlinkSync(BOT_CONFIG_FILE);
      console.log('🗑 Config bot supprimée');
    }
  } catch(e) {}
}

function encodeAPIs(apiConfigs) {
  const encoded = {};
  for (const [id, cfg] of Object.entries(apiConfigs)) {
    encoded[id] = {
      apiKey:     Buffer.from(cfg.apiKey     || '').toString('base64'),
      secret:     Buffer.from(cfg.secret     || '').toString('base64'),
      passphrase: Buffer.from(cfg.passphrase || '').toString('base64'),
    };
  }
  return encoded;
}

function decodeAPIs(encoded) {
  const decoded = {};
  for (const [id, cfg] of Object.entries(encoded)) {
    decoded[id] = {
      apiKey:     Buffer.from(cfg.apiKey     || '', 'base64').toString('utf8'),
      secret:     Buffer.from(cfg.secret     || '', 'base64').toString('utf8'),
      passphrase: Buffer.from(cfg.passphrase || '', 'base64').toString('utf8'),
    };
  }
  return decoded;
}

// ── AUTH SIMPLE POUR LES ROUTES BOT (une seule clé admin, définie dans .env) ──
function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY n'est pas configurée sur le serveur (variable d'environnement)" });
  }
  if (req.body?.adminKey !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Clé admin invalide' });
  }
  next();
}

// ── ROUTES BOT D'EXÉCUTION ────────────────────────────────────────────────────

app.get('/api/exchanges', (req, res) => {
  res.json({ exchanges: EXCHANGE_IDS });
});

// GET /api/bot/status — état du bot (public : lecture seule, aucune donnée sensible)
app.get('/api/bot/status', (req, res) => {
  res.json(tradeBot.getState());
});

// POST /api/bot/test-connections — tester des clés API avant de démarrer le bot
app.post('/api/bot/test-connections', requireAdminKey, async (req, res) => {
  const { exchanges: exIds, apiConfigs } = req.body;
  const results = {};

  for (const id of (exIds || [])) {
    if (!EXCHANGE_IDS.includes(id)) {
      results[id] = { success: false, error: `Exchange "${id}" non supporté par ce bot (4 max : ${EXCHANGE_IDS.join(', ')})` };
      continue;
    }
    const cfg = apiConfigs?.[id] || {};
    try {
      const ExClass = ccxt[id];
      if (!ExClass) { results[id] = { success: false, error: `Exchange "${id}" non supporté` }; continue; }

      const ex = new ExClass({
        apiKey:   cfg.apiKey,
        secret:   cfg.secret,
        password: cfg.passphrase || '',
        timeout:  8000,
        enableRateLimit: true,
        options: { defaultType: 'spot' },
      });

      const bal  = await ex.fetchBalance();
      const usdt = bal?.USDT?.free ?? bal?.USDT?.total ?? 0;

      results[id] = {
        success:     true,
        usdtBalance: parseFloat(usdt) || 0,
        message:     `Connecté — ${parseFloat(usdt).toFixed(2)} USDT disponible`,
      };
      console.log(`✅ ${id} connecté — USDT: ${usdt}`);
    } catch (e) {
      results[id] = {
        success: false,
        error:   e.message?.split('\n')[0]?.slice(0, 120) || 'Erreur connexion',
      };
      console.error(`❌ ${id} échec:`, e.message?.slice(0, 100));
    }
  }

  res.json({ results });
});

// POST /api/bot/start — démarrer le bot avec config dynamique (2 exchanges au choix parmi 4)
app.post('/api/bot/start', requireAdminKey, async (req, res) => {
  const { pair, exchange1, exchange2, apiConfigs, capital1, capital2, minSpreadPct, dryRun } = req.body;

  if (!exchange1 || !exchange2) {
    return res.status(400).json({ error: 'Sélectionnez deux exchanges (exchange1, exchange2)' });
  }
  if (!EXCHANGE_IDS.includes(exchange1) || !EXCHANGE_IDS.includes(exchange2)) {
    return res.status(400).json({ error: `Exchanges supportés par ce bot : ${EXCHANGE_IDS.join(', ')}` });
  }

  const config = {
    pair, exchange1, exchange2, apiConfigs,
    capital1:     parseFloat(capital1) || 10,
    capital2:     parseFloat(capital2) || 10,
    minSpreadPct: parseFloat(minSpreadPct) || 2.0,
    dryRun:       dryRun === true || dryRun === 'true',
  };

  try {
    await tradeBot.start(config);
    saveBotConfig(config);
    const modeLabel = config.dryRun ? '🧪 Simulation' : '💰 Production';
    res.json({
      success: true,
      message: `✅ Bot démarré — ${modeLabel} | ${exchange1.toUpperCase()}: ${config.capital1} USDT | ${exchange2.toUpperCase()}: ${config.capital2} USDT | Spread min: ${config.minSpreadPct}%`
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/bot/stop — arrêter le bot
app.post('/api/bot/stop', requireAdminKey, (req, res) => {
  tradeBot.stop();
  clearBotConfig(); // Supprimer la config — pas de redémarrage automatique
  res.json({ success: true, message: 'Bot arrêté' });
});

// GET /api/bot/trades — historique des trades
app.get('/api/bot/trades', (req, res) => {
  const state = tradeBot.getState();
  res.json({
    trades:        state.tradeHistory,
    totalTrades:   state.totalTrades,
    successTrades: state.successTrades,
    failedTrades:  state.failedTrades,
    totalPnL:      state.totalPnL,
  });
});

// GET /api/bot/balances — balances des exchanges
app.get('/api/bot/balances', async (req, res) => {
  try {
    const balances = await tradeBot.fetchBalances();
    res.json(balances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bot/report — envoyer rapport manuellement
app.post('/api/bot/report', requireAdminKey, async (req, res) => {
  await tradeBot.sendWeeklyReport();
  res.json({ success: true });
});

// POST /api/bot/keepalive — activer/désactiver le ping keep-alive
app.post('/api/bot/keepalive', requireAdminKey, (req, res) => {
  const { action } = req.body;
  if (action === 'on') {
    tgCommander.startKeepAlive(process.env.TELEGRAM_CHAT_ID);
    res.json({ success: true, message: '✅ Keep-alive activé (ping toutes les 13 min)' });
  } else {
    tgCommander.stopKeepAlive();
    res.json({ success: true, message: '⏹ Keep-alive désactivé' });
  }
});

// GET /api/bot/keepalive — statut
app.get('/api/bot/keepalive', (req, res) => {
  res.json({ active: tgCommander.isKeepAliveActive() });
});

// ── WEBHOOK TELEGRAM — COMMANDES BOT ─────────────────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  await tgCommander.processUpdate(req.body, tradeBot, loadBotConfig, saveBotConfig);
});

// ── GESTIONNAIRE D'ERREURS GLOBAL ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('⚠️  Erreur route non gérée:', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || 'Erreur serveur inattendue' });
});

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🟢 ArbiScan Bot running → http://localhost:${PORT}`);
  console.log(`   Exchanges disponibles : ${EXCHANGE_IDS.join(', ')}`);
  if (!ADMIN_KEY) {
    console.warn('⚠️  ADMIN_KEY non définie — les routes de contrôle du bot (start/stop/report) refuseront toutes les requêtes tant que cette variable n\'est pas configurée.');
  }

  // ── REDÉMARRAGE AUTOMATIQUE DU BOT ────────────────────────────────────────
  const savedConfig = loadBotConfig();
  if (savedConfig && savedConfig.autoRestart) {
    console.log('🔄 Redémarrage automatique du bot...');
    try {
      await tradeBot.start(savedConfig);
      console.log(`✅ Bot relancé automatiquement sur ${savedConfig.pair || 'multi-paires'}`);

      await sendTelegram(`🔄 *ArbiScan Bot — Redémarrage automatique*

Le serveur a redémarré et le bot a été relancé automatiquement.

💎 *Paire :* ${savedConfig.pair || 'Multi-paires'}
🏦 *Exchanges :* ${savedConfig.exchange1?.toUpperCase()} ↔ ${savedConfig.exchange2?.toUpperCase()}
🤖 *Mode :* ${savedConfig.dryRun ? '🧪 Simulation' : '💰 Production'}

_Le bot continue de fonctionner en arrière-plan._`);

    } catch(e) {
      console.error('❌ Échec redémarrage automatique:', e.message);
      clearBotConfig();
    }
  } else {
    console.log('ℹ Bot non configuré — en attente de démarrage via le site');
  }

  // Message de démarrage Telegram
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendStartupMessage();
    await tgCommander.setupWebhook(APP_URL);
    tgCommander.startKeepAlive(process.env.TELEGRAM_CHAT_ID);
  }
});
