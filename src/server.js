require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const express    = require('express');
const cors       = require('cors');
const ccxt       = require('ccxt');
const { ALL_PAIRS, TIER1, getPrioritizedPairs, boostPair } = require('./pairs');
const { processAlerts, sendStartupMessage }                 = require('./telegram');
const autoScanner                                           = require('./autoScanner');
const tradeBot                                               = require('./tradeBot');
const tgCommander                                            = require('./telegramBot');

const app  = express();
const PORT    = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://arbiscan-f4fk.onrender.com';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ── FILETS DE SÉCURITÉ GLOBAUX ────────────────────────────────────────────────
// Une exception non gérée (ex: bug dans une lib exchange) tuerait sinon tout
// le process Node — et coupe brutalement toute requête en cours (→ le client
// reçoit une réponse vide, "Unexpected end of JSON input"). On log au lieu de
// planter, pour que le serveur reste debout.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Promise Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err?.message || err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CONFIG ───────────────────────────────────────────────────────────────────
const EXCHANGE_IDS  = [
  'binance', 'bybit', 'okx', 'kraken', 'kucoin',
  'gate', 'mexc', 'bitget', 'htx', 'coinbaseadvanced'
];
const WAVE_SIZE     = 15;
const WAVE_DELAY_MS = 400;

// ── EXCHANGE INSTANCES (scanner public — pas de clés) ─────────────────────────
const exchangeInstances = {};

function getExchange(id) {
  if (!exchangeInstances[id]) {
    try {
      exchangeInstances[id] = new ccxt[id]({ timeout: 10000, enableRateLimit: true });
    } catch { return null; }
  }
  return exchangeInstances[id];
}

// ── FETCH TICKER ──────────────────────────────────────────────────────────────
async function fetchTickerSafe(exchangeId, symbol) {
  try {
    const ex = getExchange(exchangeId);
    if (!ex) return null;
    const ticker = await ex.fetchTicker(symbol);
    if (!ticker || (!ticker.last && !ticker.bid && !ticker.ask)) return null;
    return {
      exchange: exchangeId, symbol,
      bid:    ticker.bid    || ticker.last,
      ask:    ticker.ask    || ticker.last,
      last:   ticker.last,
      volume: ticker.baseVolume || 0,
    };
  } catch { return null; }
}

async function fetchAllExchanges(symbol, exchangeIds) {
  const results = await Promise.allSettled(
    exchangeIds.map(id => fetchTickerSafe(id, symbol))
  );
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

// ── CACHE PRIX ────────────────────────────────────────────────────────────────
const priceCache = new Map();
const CACHE_TTL  = 10_000;

async function getPrices(symbol, exchangeIds) {
  const key = `${symbol}:${[...exchangeIds].sort().join(',')}`;
  const hit  = priceCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const data = await fetchAllExchanges(symbol, exchangeIds);
  if (data.length) priceCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── HISTORIQUE PRIX ───────────────────────────────────────────────────────────
const priceHistory = new Map();
const HISTORY_MAX  = 60;

function recordPrices(symbol, tickers) {
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const hist  = priceHistory.get(symbol);
  const point = { ts: Date.now(), prices: {} };
  for (const t of tickers) point.prices[t.exchange] = t.last || t.bid || t.ask;
  hist.push(point);
  if (hist.length > HISTORY_MAX) hist.shift();
}

// ── CALCUL ARBITRAGE ──────────────────────────────────────────────────────────
function findArbitrageOpportunities(tickers, minSpreadPct = 0.05, capital = 1000) {
  const opportunities = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      if (i === j) continue;
      const buyer    = tickers[i];
      const seller   = tickers[j];
      const buyPrice  = buyer.ask  || buyer.last;
      const sellPrice = seller.bid || seller.last;
      if (!buyPrice || !sellPrice) continue;

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
      if (spreadPct < minSpreadPct) continue;

      const feePct      = 0.2;
      const netSpread   = spreadPct - feePct;
      const units       = capital / buyPrice;
      const grossProfit = units * (sellPrice - buyPrice);
      const fees        = capital * (feePct / 100);
      const netProfit   = grossProfit - fees;

      const minVolume  = Math.min(buyer.volume || 0, seller.volume || 0);
      const volScore   = Math.min(20, minVolume > 0 ? Math.log10(minVolume + 1) * 4 : 0);
      const confidence = Math.min(95, Math.round(45 + Math.min(30, spreadPct * 8) + volScore));
      const windowSec  = Math.max(10, Math.round(90 - spreadPct * 15));
      const risk       = spreadPct > 3 ? 'high' : spreadPct > 1.5 ? 'medium' : 'low';

      boostPair(buyer.symbol, spreadPct);

      opportunities.push({
        symbol: buyer.symbol, buyExchange: buyer.exchange, sellExchange: seller.exchange,
        buyPrice, sellPrice,
        spreadPct:    parseFloat(spreadPct.toFixed(3)),
        netSpreadPct: parseFloat(netSpread.toFixed(3)),
        grossProfit:  parseFloat(grossProfit.toFixed(2)),
        feesUSDT:     parseFloat(fees.toFixed(2)),
        netProfit:    parseFloat(netProfit.toFixed(2)),
        confidence, windowSec, risk, capital, timestamp: Date.now(),
      });
    }
  }
  return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// ── SCAN EN VAGUES ────────────────────────────────────────────────────────────
async function scanInWaves(pairs, exchanges, minSpread, capital) {
  const allOpportunities = [];
  for (let i = 0; i < pairs.length; i += WAVE_SIZE) {
    const wave = pairs.slice(i, i + WAVE_SIZE);
    const results = await Promise.allSettled(
      wave.map(async (symbol) => {
        const tickers = await getPrices(symbol, exchanges);
        if (tickers.length) recordPrices(symbol, tickers);
        return findArbitrageOpportunities(tickers, minSpread, capital);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allOpportunities.push(...r.value);
    }
    if (i + WAVE_SIZE < pairs.length) await new Promise(r => setTimeout(r, WAVE_DELAY_MS));
  }
  return allOpportunities;
}

// ── ROUTES SCANNER ────────────────────────────────────────────────────────────

app.get('/api/exchanges', (req, res) => {
  res.json({ exchanges: EXCHANGE_IDS, totalPairs: ALL_PAIRS.length, tier1Pairs: TIER1 });
});

app.get('/api/ticker', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol requis' });
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers });
});

app.get('/api/prices', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  recordPrices(symbol, tickers);
  res.json({ symbol, tickers, ts: Date.now() });
});

app.get('/api/history', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  if (!priceHistory.has(symbol) || priceHistory.get(symbol).length < 2) {
    const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
    recordPrices(symbol, tickers);
  }
  res.json({ symbol, history: priceHistory.get(symbol) || [] });
});

app.get('/api/pairs', (req, res) => {
  const { tier } = req.query;
  res.json({ total: ALL_PAIRS.length, pairs: tier === '1' ? TIER1 : getPrioritizedPairs() });
});

// GET /api/status — état du scanner automatique
app.get('/api/status', (req, res) => {
  const last = autoScanner.getLastResults();
  res.json({
    autoScanActive:      true,
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL || '60000') / 1000,
    alertThreshold:      parseFloat(process.env.ALERT_SPREAD || '2.0'),
    telegramConfigured:  !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    lastScanTime:        last.lastScanTime,
    lastStats:           last.stats,
    lastTopSignals:      (last.opportunities || []).slice(0, 5),
  });
});

// ── GARDE ANTI-EMPILEMENT ──────────────────────────────────────────────────
// Si un scan manuel est déjà en cours, on refuse le suivant plutôt que de
// laisser plusieurs scans lourds tourner en parallèle (source de crash
// mémoire sur les petites instances).
let manualScanInProgress = false;

// POST /api/scan — scan rapide
app.post('/api/scan', async (req, res) => {
  if (manualScanInProgress) {
    return res.status(429).json({ error: 'Un scan est déjà en cours — réessayez dans quelques secondes' });
  }
  manualScanInProgress = true;
  const { minSpread = 0.05, capital = 1000, pairLimit = 30, exchanges = EXCHANGE_IDS, usePriority = true } = req.body;
  const t0    = Date.now();
  const pairs = usePriority ? getPrioritizedPairs(parseInt(pairLimit)) : TIER1.slice(0, parseInt(pairLimit));

  try {
    const allOpps = await scanInWaves(pairs, exchanges, parseFloat(minSpread), parseFloat(capital));
    allOpps.sort((a, b) => b.netProfit - a.netProfit);

    await processAlerts(allOpps, parseFloat(process.env.ALERT_SPREAD || '2.0'));

    res.json({
      opportunities: allOpps.slice(0, 30),
      stats: {
        scannedPairs: pairs.length, totalPairsAvailable: ALL_PAIRS.length,
        scannedExchanges: exchanges.length, totalSignals: allOpps.length,
        bestSpread: allOpps[0]?.spreadPct ?? 0, bestPair: allOpps[0]?.symbol ?? '—',
        bestRoute: allOpps[0] ? `${allOpps[0].buyExchange} → ${allOpps[0].sellExchange}` : '—',
        totalNetProfit: allOpps.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
        scanDurationMs: Date.now() - t0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    manualScanInProgress = false;
  }
});

// POST /api/scan/full — scan étendu
app.post('/api/scan/full', async (req, res) => {
  if (manualScanInProgress) {
    return res.status(429).json({ error: 'Un scan est déjà en cours — réessayez dans quelques secondes' });
  }
  manualScanInProgress = true;
  const { minSpread = 0.05, capital = 1000, exchanges = EXCHANGE_IDS, maxPairs = 200 } = req.body;
  const t0    = Date.now();
  const pairs = getPrioritizedPairs(parseInt(maxPairs));

  try {
    const allOpps = await scanInWaves(pairs, exchanges, parseFloat(minSpread), parseFloat(capital));
    allOpps.sort((a, b) => b.netProfit - a.netProfit);
    await processAlerts(allOpps, parseFloat(process.env.ALERT_SPREAD || '2.0'));

    res.json({
      opportunities: allOpps.slice(0, 50),
      stats: {
        scannedPairs: pairs.length, totalPairsAvailable: ALL_PAIRS.length,
        scannedExchanges: exchanges.length, totalSignals: allOpps.length,
        bestSpread: allOpps[0]?.spreadPct ?? 0, bestPair: allOpps[0]?.symbol ?? '—',
        totalNetProfit: allOpps.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
        scanDurationMs: Date.now() - t0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    manualScanInProgress = false;
  }
});

// POST /api/alert/test — tester l'alerte Telegram
app.post('/api/alert/test', async (req, res) => {
  const { sendTelegram } = require('./telegram');
  const ok = await sendTelegram(
    `✅ *Test ArbiScan*\n\nVotre bot Telegram est correctement configuré !\n_${new Date().toLocaleString('fr-FR')}_`
  );
  res.json({ success: ok, message: ok ? 'Message envoyé !' : 'Échec — vérifiez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID' });
});

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

// GET /api/bot/status — état du bot (public : lecture seule, aucune donnée sensible)
app.get('/api/bot/status', (req, res) => {
  res.json(tradeBot.getState());
});

// POST /api/bot/test-connections — tester des clés API avant de démarrer le bot
app.post('/api/bot/test-connections', requireAdminKey, async (req, res) => {
  const { exchanges: exIds, apiConfigs } = req.body;
  const results = {};

  for (const id of (exIds || [])) {
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

// POST /api/bot/start — démarrer le bot avec config dynamique (2 exchanges au choix)
app.post('/api/bot/start', requireAdminKey, async (req, res) => {
  const { pair, exchange1, exchange2, apiConfigs, capital1, capital2, minSpreadPct, dryRun } = req.body;

  if (!exchange1 || !exchange2) {
    return res.status(400).json({ error: 'Sélectionnez deux exchanges (exchange1, exchange2)' });
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
// Filet de sécurité final : si une route lève une erreur non interceptée,
// on renvoie du JSON (jamais la page d'erreur HTML par défaut d'Express,
// qui ferait planter le .json() côté navigateur).
app.use((err, req, res, next) => {
  console.error('⚠️  Erreur route non gérée:', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || 'Erreur serveur inattendue' });
});

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🟢 ArbiScan running → http://localhost:${PORT}`);
  console.log(`   Exchanges    : ${EXCHANGE_IDS.length} exchanges`);
  console.log(`   Paires total : ${ALL_PAIRS.length} paires`);
  if (!ADMIN_KEY) {
    console.warn('⚠️  ADMIN_KEY non définie — les routes de contrôle du bot (start/stop/report) refuseront toutes les requêtes tant que cette variable n\'est pas configurée.');
  }

  // Initialiser et démarrer le scanner automatique de signaux
  autoScanner.init(getPrices, findArbitrageOpportunities, EXCHANGE_IDS);
  autoScanner.start();

  // ── REDÉMARRAGE AUTOMATIQUE DU BOT ────────────────────────────────────────
  const savedConfig = loadBotConfig();
  if (savedConfig && savedConfig.autoRestart) {
    console.log('🔄 Redémarrage automatique du bot...');
    try {
      await tradeBot.start(savedConfig);
      console.log(`✅ Bot relancé automatiquement sur ${savedConfig.pair || 'multi-paires'}`);

      const { sendTelegram } = require('./telegram');
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
