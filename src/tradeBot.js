// ── BOT DE TRADING CROSS-EXCHANGE — GESTION AUTONOME EN USDT ─────────────────
// 2 exchanges au choix (parmi ceux supportés par CCXT) — Spot uniquement
// Tu déposes uniquement de l'USDT des deux côtés. Le bot achète quand un
// exchange est nettement moins cher que l'autre, puis revend sur ce MÊME
// exchange dès que ça devient profitable (ou pour couper une perte). Jamais
// deux ordres simultanés sur deux exchanges différents — donc jamais de
// risque d'exécution partielle (une jambe qui passe, l'autre qui échoue).
// Sécurité : les clés API ne doivent JAMAIS avoir le droit "Withdraw"

require('dotenv').config();
const ccxt = require('ccxt');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '2.0'), // seuil pour ACHETER (écart entre exchanges) ET pour VENDRE (gain net visé)
  STOP_LOSS_PCT:  parseFloat(process.env.STOP_LOSS_PCT  || '5.0'), // coupe la position si elle perd plus que ça
  SELECTED_PAIR:  null,
  EXCHANGE_1:     null,   // ex: 'kucoin' — choisi dynamiquement depuis le site
  EXCHANGE_2:     null,   // ex: 'bybit'
  CAPITAL_1:      parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  CAPITAL_2:      parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  FEE_PCT:        0.1,
  SCAN_INTERVAL:  15000,
  DRY_RUN:        process.env.DRY_RUN !== 'false',
};

// ── EXCHANGES (construits dynamiquement selon la sélection utilisateur) ──────
const publicExchanges  = {}; // instances PUBLIQUES pour fetch des prix (pas besoin de clés)
const privateExchanges = {}; // instances PRIVÉES pour passer les ordres / lire les balances

// Compteur de session : incrémenté à chaque start()/stop(). Toute boucle de
// scan lancée par une session précédente se compare à ce compteur et s'arrête
// d'elle-même dès qu'il change — évite d'avoir plusieurs boucles en parallèle.
let currentSession = 0;

function ensurePublicExchange(id) {
  if (!ccxt[id]) throw new Error(`Exchange "${id}" non supporté par CCXT`);
  if (!publicExchanges[id]) {
    publicExchanges[id] = new ccxt[id]({ timeout: 10000, enableRateLimit: true, options: { defaultType: 'spot' } });
  }
  return publicExchanges[id];
}

function ensurePrivateExchange(id, keys = {}) {
  if (!ccxt[id]) throw new Error(`Exchange "${id}" non supporté par CCXT`);
  privateExchanges[id] = new ccxt[id]({
    apiKey:   keys.apiKey,
    secret:   keys.secret,
    password: keys.passphrase || '',
    timeout:  10000,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
  return privateExchanges[id];
}

function capitalFor(exchangeId) {
  if (exchangeId === CONFIG.EXCHANGE_1) return CONFIG.CAPITAL_1;
  if (exchangeId === CONFIG.EXCHANGE_2) return CONFIG.CAPITAL_2;
  return 10;
}

// ── ÉTAT DU BOT ───────────────────────────────────────────────────────────────
const state = {
  running:       false,
  totalTrades:   0,
  successTrades: 0,
  failedTrades:  0,
  totalPnL:      0,
  balances:      {},
  lastScan:      null,
  activeTrade:   null, // verrou anti-chevauchement pendant qu'un ordre est en vol
  position:      null, // { exchange, quantity, entryPrice, entryCost, entryTime } — null si pas de position ouverte
  tradeHistory:  [],
};

// ── FORMATAGE PRIX (précision dynamique — évite "$0.0000" pour BONK/PEPE...) ──
function fmtPrice(p) {
  if (!p || p === 0) return '0';
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(6);
  return p.toPrecision(4);
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function tg(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TG]', msg.replace(/\*/g, ''));
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('TG error:', e.message);
  }
}

// ── FETCH TICKER ──────────────────────────────────────────────────────────────
async function fetchTicker(exchangeId, symbol) {
  try {
    const ex = ensurePublicExchange(exchangeId);
    const t  = await ex.fetchTicker(symbol);
    if (!t || (!t.bid && !t.ask && !t.last)) return null;
    return {
      exchange: exchangeId,
      symbol,
      bid:    t.bid    || t.last,
      ask:    t.ask    || t.last,
      last:   t.last,
      volume: t.baseVolume || 0,
    };
  } catch(e) {
    console.log(`[fetchTicker] ${exchangeId} ${symbol}: ${e.message}`);
    return null;
  }
}

// ── FETCH BALANCES (USDT + token détenu, sur les 2 exchanges) ───────────────
async function fetchBalances() {
  const ids = [...new Set([CONFIG.EXCHANGE_1, CONFIG.EXCHANGE_2].filter(Boolean))];

  for (const id of ids) {
    try {
      const ex = privateExchanges[id];

      if (!ex) {
        state.balances[id] = {
          USDT:      CONFIG.DRY_RUN ? capitalFor(id) : 0,
          total:     {},
          free:      {},
          simulated: true,
        };
        continue;
      }

      const bal = await Promise.race([
        ex.fetchBalance(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (15s) en attente de ${id}`)), 15000)),
      ]);
      state.balances[id] = {
        USDT:  bal.USDT?.free  || 0,
        total: bal.total || {},
        free:  bal.free  || {},
      };
    } catch (e) {
      console.error(`Balance ${id}:`, e.message);
      state.balances[id] = { USDT: 0, total: {}, free: {}, error: e.message };
    }
  }
  return state.balances;
}

// ── VÉRIFIER LES MINIMUMS D'ORDRE DE L'EXCHANGE ──────────────────────────────
function getOrderMinimum(exchangeId, symbol) {
  try {
    const ex = publicExchanges[exchangeId];
    const market = ex?.markets?.[symbol];
    if (!market) return null;
    return {
      minAmount: market.limits?.amount?.min || 0,
      minCost:   market.limits?.cost?.min   || 0,
    };
  } catch { return null; }
}

function orderMeetsMinimum(exchangeId, symbol, amount, price) {
  const lim = getOrderMinimum(exchangeId, symbol);
  if (!lim) return { ok: true };
  const cost = amount * price;
  if (lim.minAmount && amount < lim.minAmount) {
    return { ok: false, reason: `${exchangeId}: quantité ${amount.toFixed(6)} < minimum ${lim.minAmount}` };
  }
  if (lim.minCost && cost < lim.minCost) {
    return { ok: false, reason: `${exchangeId}: valeur ordre ${cost.toFixed(3)} USDT < minimum ${lim.minCost} USDT` };
  }
  return { ok: true };
}

// ── PLACER UN ORDRE MARKET ────────────────────────────────────────────────────
async function placeMarketOrder(exchangeId, symbol, side, amount) {
  if (CONFIG.DRY_RUN) {
    console.log(`[SIM] ${side.toUpperCase()} ${amount.toFixed(6)} ${symbol} on ${exchangeId}`);
    return { id: 'sim-' + Date.now(), status: 'closed', filled: amount, average: null, simulated: true };
  }
  const ex = privateExchanges[exchangeId];
  if (!ex) throw new Error(`Pas de clé API configurée pour ${exchangeId}`);
  try {
    return await ex.createMarketOrder(symbol, side, amount);
  } catch (e) {
    throw new Error(`Ordre ${side} ${symbol} sur ${exchangeId}: ${e.message}`);
  }
}

// Anti-spam Telegram pour les alertes répétitives (fonds insuffisants, etc.)
let lastFundsAlertTs = 0;
function shouldAlertFunds() {
  const now = Date.now();
  if (now - lastFundsAlertTs > 5 * 60 * 1000) { lastFundsAlertTs = now; return true; }
  return false;
}

// ── ENTRÉE EN POSITION : ACHETER SUR L'EXCHANGE LE MOINS CHER ───────────────
async function evaluateEntry(symbol) {
  const [t1, t2] = await Promise.all([
    fetchTicker(CONFIG.EXCHANGE_1, symbol),
    fetchTicker(CONFIG.EXCHANGE_2, symbol),
  ]);
  if (!t1 || !t2) return;

  const p1 = t1.ask || t1.last;
  const p2 = t2.ask || t2.last;
  if (!p1 || !p2) return;

  // Quel exchange est le moins cher ?
  const cheaper  = p1 <= p2 ? CONFIG.EXCHANGE_1 : CONFIG.EXCHANGE_2;
  const cheapPrice  = Math.min(p1, p2);
  const pricePrice  = Math.max(p1, p2);
  const spreadPct = ((pricePrice - cheapPrice) / cheapPrice) * 100;

  if (spreadPct < CONFIG.MIN_SPREAD_PCT) return; // écart pas assez intéressant pour se positionner

  const capital = capitalFor(cheaper);
  const amount  = capital / cheapPrice;

  const minCheck = orderMeetsMinimum(cheaper, symbol, amount, cheapPrice);
  if (!minCheck.ok) {
    console.log(`⚠ Ordre trop petit: ${minCheck.reason}`);
    return;
  }

  const usdtAvail = state.balances[cheaper]?.USDT || (CONFIG.DRY_RUN ? capital : 0);
  if (usdtAvail < capital) {
    console.log(`💰 Fonds insuffisants sur ${cheaper}: ${usdtAvail.toFixed(2)} USDT dispo, ${capital} requis`);
    if (shouldAlertFunds()) {
      await tg(`💰 *Fonds insuffisants*\n\n\`${cheaper}\` n'a que ${usdtAvail.toFixed(2)} USDT (besoin de ${capital}).\nRecharge cet exchange en USDT pour que le bot puisse continuer.`);
    }
    return;
  }

  if (state.activeTrade) return;
  state.activeTrade = true;

  try {
    console.log(`🎯 Entrée: achat sur ${cheaper} @ ${fmtPrice(cheapPrice)} (écart +${spreadPct.toFixed(2)}%)`);
    const order = await placeMarketOrder(cheaper, symbol, 'buy', amount);
    const filled     = order.filled  || amount;
    const entryPrice = order.average || (order.cost && order.filled ? order.cost / order.filled : cheapPrice);

    state.position = {
      exchange:   cheaper,
      quantity:   filled,
      entryPrice,
      entryCost:  filled * entryPrice,
      entryTime:  Date.now(),
      symbol,
    };
    state.totalTrades++;

    if (CONFIG.DRY_RUN) {
      const base = symbol.split('/')[0];
      if (!state.balances[cheaper]) state.balances[cheaper] = { USDT: capital, free: {} };
      state.balances[cheaper].USDT -= filled * entryPrice;
      state.balances[cheaper].free[base] = (state.balances[cheaper].free[base] || 0) + filled;
    }

    await tg(`🟢 *POSITION OUVERTE*

💎 *Paire :* \`${symbol}\`
🏦 *Achat sur :* \`${cheaper}\`
📈 *Écart détecté :* +${spreadPct.toFixed(2)}% vs l'autre exchange
💵 *Prix d'entrée :* $${fmtPrice(entryPrice)}
📦 *Quantité :* ${filled.toFixed(6)}
💰 *Coût :* ${(filled*entryPrice).toFixed(4)} USDT

_Le bot revendra sur ${cheaper} dès un gain net de +${CONFIG.MIN_SPREAD_PCT}%, ou coupera la position à -${CONFIG.STOP_LOSS_PCT}% (stop-loss)._`);

  } catch (e) {
    state.failedTrades++;
    console.error('Entrée échouée:', e.message);
    await tg(`❌ *Échec d'entrée en position*\n\n\`${symbol}\` sur \`${cheaper}\`\nErreur: ${e.message}`);
  } finally {
    state.activeTrade = null;
    fetchBalances().catch(() => {});
  }
}

// ── SORTIE DE POSITION : REVENDRE SUR LE MÊME EXCHANGE ───────────────────────
async function evaluateExit(symbol) {
  const pos = state.position;
  if (!pos) return;

  const ticker = await fetchTicker(pos.exchange, symbol);
  if (!ticker) return;

  const currentPrice = ticker.bid || ticker.last;
  if (!currentPrice) return;

  const grossGainPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const netGainPct   = grossGainPct - CONFIG.FEE_PCT * 2; // frais achat + vente

  const takeProfit = netGainPct >= CONFIG.MIN_SPREAD_PCT;
  const stopLoss    = netGainPct <= -CONFIG.STOP_LOSS_PCT;

  if (!takeProfit && !stopLoss) return; // on garde la position, rien à faire ce cycle

  await sellPosition(stopLoss ? 'stop-loss' : 'take-profit');
}

// ── VENDRE LA POSITION EN COURS (déclenché auto par evaluateExit, ou manuellement) ──
async function sellPosition(reasonCode = 'manuel') {
  const pos = state.position;
  if (!pos) return { ok: false, reason: 'Aucune position ouverte' };
  if (state.activeTrade) return { ok: false, reason: 'Un ordre est déjà en cours' };

  const symbol = pos.symbol;
  const ticker = await fetchTicker(pos.exchange, symbol);
  const currentPrice = ticker?.bid || ticker?.last;
  if (!currentPrice) return { ok: false, reason: 'Impossible de récupérer le prix actuel' };

  const netGainPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 - CONFIG.FEE_PCT * 2;

  // Le solde réel peut être légèrement inférieur à pos.quantity si l'exchange
  // prélève ses frais directement dans le token acheté (fréquent). On vérifie
  // le solde disponible juste avant de vendre plutôt que de faire confiance
  // aveuglément à la quantité enregistrée à l'achat — sinon l'ordre de vente
  // est rejeté ("Insufficient balance") et la position reste bloquée ouverte.
  let sellAmount = pos.quantity;
  if (!CONFIG.DRY_RUN) {
    await fetchBalances();
    const base = symbol.split('/')[0];
    const available = state.balances[pos.exchange]?.free?.[base] || 0;
    if (available > 0 && available < pos.quantity) {
      console.log(`⚠ Solde réel (${available.toFixed(6)}) < quantité enregistrée (${pos.quantity.toFixed(6)}) — vente ajustée au solde réel`);
      sellAmount = available * 0.999; // petite marge pour l'arrondi/précision de l'exchange
    } else if (available === 0) {
      return { ok: false, reason: `Solde ${base} introuvable sur ${pos.exchange} — vérifie manuellement le compte` };
    }
  }

  const minCheck = orderMeetsMinimum(pos.exchange, symbol, sellAmount, currentPrice);
  if (!minCheck.ok) return { ok: false, reason: minCheck.reason };

  state.activeTrade = true;
  try {
    const stopLoss = reasonCode === 'stop-loss';
    console.log(`${stopLoss ? '🛑' : '🎯'} Sortie (${reasonCode}): vente sur ${pos.exchange} @ ${fmtPrice(currentPrice)} (${netGainPct>=0?'+':''}${netGainPct.toFixed(2)}%)`);

    const order = await placeMarketOrder(pos.exchange, symbol, 'sell', sellAmount);
    const filled   = order.filled  || sellAmount;
    const exitPrice = order.average || (order.cost && order.filled ? order.cost / order.filled : currentPrice);

    const feeCost = pos.entryCost * (CONFIG.FEE_PCT / 100) * 2;
    const realPnL = (exitPrice - pos.entryPrice) * filled - feeCost;

    state.totalPnL += realPnL;
    if (realPnL >= 0) state.successTrades++; else state.failedTrades++;

    if (CONFIG.DRY_RUN) {
      const base = symbol.split('/')[0];
      if (state.balances[pos.exchange]) {
        state.balances[pos.exchange].free[base] = Math.max(0, (state.balances[pos.exchange].free[base] || 0) - filled);
        state.balances[pos.exchange].USDT += filled * exitPrice;
      }
    }

    const trade = {
      id: 'T' + Date.now(), symbol, buyExchange: pos.exchange, sellExchange: pos.exchange,
      buyPrice: pos.entryPrice, sellPrice: exitPrice, amount: filled,
      spreadPct: netGainPct, pnl: realPnL, feeCost,
      duration: Date.now() - pos.entryTime,
      timestamp: new Date().toISOString(),
      status: 'success',
      exitReason: reasonCode,
    };
    state.tradeHistory.unshift(trade);
    if (state.tradeHistory.length > 100) state.tradeHistory.pop();

    state.position = null;

    const titleMap = {
      'stop-loss':   '🛑 *STOP-LOSS DÉCLENCHÉ*',
      'take-profit': '✅ *POSITION CLÔTURÉE — PROFIT*',
      'manuel':      '✋ *POSITION CLÔTURÉE MANUELLEMENT*',
    };

    await tg(`${titleMap[reasonCode] || titleMap.manuel}

💎 *Paire :* \`${symbol}\`
🏦 *Exchange :* \`${pos.exchange}\`
💵 *Entrée :* $${fmtPrice(pos.entryPrice)} → *Sortie :* $${fmtPrice(exitPrice)}
📊 *Variation nette :* ${netGainPct>=0?'+':''}${netGainPct.toFixed(2)}%
💰 *PnL :* ${realPnL>=0?'+':''}${realPnL.toFixed(4)} USDT
📊 *PnL total (session) :* ${state.totalPnL>=0?'+':''}${state.totalPnL.toFixed(4)} USDT
⏱ *Durée détention :* ${Math.round((Date.now()-pos.entryTime)/60000)} min
📋 *Trades :* ${state.successTrades}✅ / ${state.failedTrades}❌`);

    return { ok: true, pnl: realPnL };

  } catch (e) {
    console.error('Sortie échouée:', e.message);
    await tg(`⚠️ *Échec de sortie de position*\n\n\`${symbol}\` sur \`${pos.exchange}\`\nErreur: ${e.message}\n\n_La position reste ouverte, nouvelle tentative au prochain scan._`);
    return { ok: false, reason: e.message };
  } finally {
    state.activeTrade = null;
    fetchBalances().catch(() => {});
  }
}

// ── BOUCLE PRINCIPALE ─────────────────────────────────────────────────────────
async function scanAndTrade() {
  if (state.activeTrade) return;
  if (!CONFIG.EXCHANGE_1 || !CONFIG.EXCHANGE_2) return;
  state.lastScan = new Date();

  const symbol = CONFIG.SELECTED_PAIR || 'BTC/USDT';

  try {
    if (state.position) {
      await evaluateExit(symbol);
    } else {
      await evaluateEntry(symbol);
    }
  } catch (e) {
    console.error('Scan error:', e.message);
  }
}

// ── RAPPORT ────────────────────────────────────────────────────────────────────
async function sendWeeklyReport() {
  const bals = await fetchBalances();
  const ex1 = CONFIG.EXCHANGE_1 || '—';
  const ex2 = CONFIG.EXCHANGE_2 || '—';
  const posInfo = state.position
    ? `🟢 Position ouverte sur \`${state.position.exchange}\` — entrée $${fmtPrice(state.position.entryPrice)}, ${state.position.quantity.toFixed(6)} unités`
    : '⚪ Aucune position ouverte actuellement';

  await tg(`📊 *RAPPORT ArbiScan*

💰 *PnL total :* \`${state.totalPnL>=0?'+':''}${state.totalPnL.toFixed(4)} USDT\`
📋 *Total trades :* ${state.totalTrades}
✅ *Réussis :* ${state.successTrades}
❌ *Échoués :* ${state.failedTrades}
🎯 *Taux réussite :* ${state.totalTrades > 0 ? ((state.successTrades/state.totalTrades)*100).toFixed(1) : 0}%

${posInfo}

*Balances actuelles :*
${ex1.toUpperCase()} : \`${bals[ex1]?.USDT?.toFixed(2) || '—'}\` USDT
${ex2.toUpperCase()} : \`${bals[ex2]?.USDT?.toFixed(2) || '—'}\` USDT`);
}

// ── DÉMARRER LE BOT ───────────────────────────────────────────────────────────
async function start(dynamicConfig = {}) {
  currentSession++;
  const mySession = currentSession;
  state.running = false;
  await new Promise(r => setTimeout(r, 500));

  if (dynamicConfig.resetStats !== false) {
    state.totalPnL      = 0;
    state.totalTrades   = 0;
    state.successTrades = 0;
    state.failedTrades  = 0;
    state.tradeHistory  = [];
    state.position       = dynamicConfig.resetPosition !== false ? null : state.position;
    console.log('🔄 Compteurs remis à zéro pour cette nouvelle session');
  }

  if (!dynamicConfig.exchange1 || !dynamicConfig.exchange2) {
    throw new Error('Deux exchanges doivent être sélectionnés (exchange1 et exchange2)');
  }

  CONFIG.EXCHANGE_1     = dynamicConfig.exchange1;
  CONFIG.EXCHANGE_2     = dynamicConfig.exchange2;
  CONFIG.CAPITAL_1      = dynamicConfig.capital1 != null ? parseFloat(dynamicConfig.capital1) : CONFIG.CAPITAL_1;
  CONFIG.CAPITAL_2      = dynamicConfig.capital2 != null ? parseFloat(dynamicConfig.capital2) : CONFIG.CAPITAL_2;
  CONFIG.MIN_SPREAD_PCT = dynamicConfig.minSpreadPct != null ? parseFloat(dynamicConfig.minSpreadPct) : CONFIG.MIN_SPREAD_PCT;
  CONFIG.STOP_LOSS_PCT  = dynamicConfig.stopLossPct  != null ? parseFloat(dynamicConfig.stopLossPct)  : CONFIG.STOP_LOSS_PCT;
  CONFIG.DRY_RUN        = dynamicConfig.dryRun !== undefined ? !!dynamicConfig.dryRun : CONFIG.DRY_RUN;
  CONFIG.SELECTED_PAIR  = dynamicConfig.pair || null;

  ensurePublicExchange(CONFIG.EXCHANGE_1);
  ensurePublicExchange(CONFIG.EXCHANGE_2);

  if (dynamicConfig.apiConfigs) {
    for (const [id, cfg] of Object.entries(dynamicConfig.apiConfigs)) {
      if (cfg?.apiKey && cfg?.secret) {
        ensurePrivateExchange(id, cfg);
        console.log(`🔑 ${id} configuré avec clés API fournies`);
      }
    }
  }

  if (!CONFIG.DRY_RUN && (!privateExchanges[CONFIG.EXCHANGE_1] || !privateExchanges[CONFIG.EXCHANGE_2])) {
    throw new Error('Mode Production : des clés API valides sont requises pour les deux exchanges');
  }

  state.running = true;

  console.log('\n🤖 ArbiScan Trade Bot démarré');
  console.log(`   Exchanges    : ${CONFIG.EXCHANGE_1.toUpperCase()} + ${CONFIG.EXCHANGE_2.toUpperCase()}`);
  console.log(`   Paire        : ${CONFIG.SELECTED_PAIR || 'BTC/USDT'}`);
  console.log(`   Spread min   : ${CONFIG.MIN_SPREAD_PCT}%`);
  console.log(`   Stop-loss    : -${CONFIG.STOP_LOSS_PCT}%`);
  console.log(`   Capital ${CONFIG.EXCHANGE_1.toUpperCase()}  : ${CONFIG.CAPITAL_1} USDT`);
  console.log(`   Capital ${CONFIG.EXCHANGE_2.toUpperCase()}  : ${CONFIG.CAPITAL_2} USDT`);
  console.log(`   Mode         : ${CONFIG.DRY_RUN ? '🧪 SIMULATION' : '💰 PRODUCTION'}`);
  console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s\n`);

  try {
    await fetchBalances();
    const ex1Label = CONFIG.EXCHANGE_1.toUpperCase();
    const ex2Label = CONFIG.EXCHANGE_2.toUpperCase();
    const ex1USDT  = state.balances[CONFIG.EXCHANGE_1]?.USDT || 0;
    const ex2USDT  = state.balances[CONFIG.EXCHANGE_2]?.USDT || 0;

    await tg(`🚀 *ArbiScan Bot DÉMARRÉ*

🤖 *Mode :* ${CONFIG.DRY_RUN ? '🧪 Simulation' : '💰 Production'}
💎 *Paire :* ${CONFIG.SELECTED_PAIR || 'BTC/USDT'}
🏦 *Exchanges :* ${ex1Label} ↔ ${ex2Label}
📈 *Entrée si écart ≥ :* ${CONFIG.MIN_SPREAD_PCT}%
🎯 *Sortie si gain net ≥ :* ${CONFIG.MIN_SPREAD_PCT}%
🛑 *Stop-loss si perte ≥ :* ${CONFIG.STOP_LOSS_PCT}%
💵 *Capital ${ex1Label} :* ${CONFIG.CAPITAL_1} USDT
💵 *Capital ${ex2Label} :* ${CONFIG.CAPITAL_2} USDT

*Balances USDT :*
${ex1Label} : \`${ex1USDT.toFixed(2)}\`
${ex2Label} : \`${ex2USDT.toFixed(2)}\`

_Dépose uniquement de l'USDT — le bot achète le token lui-même quand une opportunité apparaît, et revend au bon moment. Scan toutes les ${CONFIG.SCAN_INTERVAL/1000}s._`);

  } catch (e) {
    console.error('Erreur démarrage:', e.message);
    await tg(`❌ *Erreur démarrage bot*\n\n\`${e.message}\`\n\nVérifiez les clés API.`);
  }

  if (!global.__arbiscanWeeklyReportTimer) {
    global.__arbiscanWeeklyReportTimer = setInterval(() => {
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 1) {
        sendWeeklyReport();
      }
    }, 60000);
  }

  const loop = async () => {
    if (!state.running || mySession !== currentSession) return;
    try { await scanAndTrade(); } catch (e) { console.error('Loop error:', e.message); }
    if (mySession === currentSession) setTimeout(loop, CONFIG.SCAN_INTERVAL);
  };
  setTimeout(loop, 3000);
}

function stop() {
  currentSession++;
  state.running = false;
  console.log('Bot arrêté.');
  tg('⏹ *Bot ArbiScan arrêté manuellement*' + (state.position ? `\n\n⚠️ Une position reste ouverte sur \`${state.position.exchange}\` (${state.position.quantity.toFixed(6)} unités) — elle ne sera pas vendue automatiquement tant que le bot est arrêté.` : ''));
}

async function getState() {
  let positionInfo = state.position;
  if (state.position) {
    try {
      const ticker = await fetchTicker(state.position.exchange, state.position.symbol);
      const currentPrice = ticker?.bid || ticker?.last || null;
      if (currentPrice) {
        const grossGainPct = ((currentPrice - state.position.entryPrice) / state.position.entryPrice) * 100;
        const netGainPct   = grossGainPct - CONFIG.FEE_PCT * 2;
        positionInfo = { ...state.position, currentPrice, netGainPct };
      }
    } catch { /* si le fetch échoue, on renvoie la position sans le gain live */ }
  }

  return {
    running:       state.running,
    totalTrades:   state.totalTrades,
    successTrades: state.successTrades,
    failedTrades:  state.failedTrades,
    totalPnL:      state.totalPnL,
    balances:      state.balances,
    position:      positionInfo,
    tradeHistory:  state.tradeHistory,
    config: {
      exchange1:    CONFIG.EXCHANGE_1,
      exchange2:    CONFIG.EXCHANGE_2,
      capital1:     CONFIG.CAPITAL_1,
      capital2:     CONFIG.CAPITAL_2,
      minSpreadPct: CONFIG.MIN_SPREAD_PCT,
      stopLossPct:  CONFIG.STOP_LOSS_PCT,
      dryRun:       CONFIG.DRY_RUN,
      selectedPair: CONFIG.SELECTED_PAIR || 'BTC/USDT',
      scanIntervalSec: CONFIG.SCAN_INTERVAL / 1000,
    }
  };
}

// ── MODIFIER LA CONFIG À CHAUD (sans redémarrer le bot) ──────────────────────
// Utilisé par les commandes Telegram /spread, /stoploss, /capital, /pair, /mode
function updateConfig(partial = {}) {
  const applied = {};
  if (partial.minSpreadPct != null && !isNaN(partial.minSpreadPct)) {
    CONFIG.MIN_SPREAD_PCT = parseFloat(partial.minSpreadPct);
    applied.minSpreadPct = CONFIG.MIN_SPREAD_PCT;
  }
  if (partial.stopLossPct != null && !isNaN(partial.stopLossPct)) {
    CONFIG.STOP_LOSS_PCT = parseFloat(partial.stopLossPct);
    applied.stopLossPct = CONFIG.STOP_LOSS_PCT;
  }
  if (partial.capital1 != null && !isNaN(partial.capital1)) {
    CONFIG.CAPITAL_1 = parseFloat(partial.capital1);
    applied.capital1 = CONFIG.CAPITAL_1;
  }
  if (partial.capital2 != null && !isNaN(partial.capital2)) {
    CONFIG.CAPITAL_2 = parseFloat(partial.capital2);
    applied.capital2 = CONFIG.CAPITAL_2;
  }
  if (partial.pair) {
    CONFIG.SELECTED_PAIR = partial.pair.toUpperCase();
    applied.pair = CONFIG.SELECTED_PAIR;
  }
  if (partial.dryRun != null) {
    CONFIG.DRY_RUN = !!partial.dryRun;
    applied.dryRun = CONFIG.DRY_RUN;
  }
  return applied;
}

function getConfig() {
  return {
    exchange1: CONFIG.EXCHANGE_1, exchange2: CONFIG.EXCHANGE_2,
    capital1: CONFIG.CAPITAL_1, capital2: CONFIG.CAPITAL_2,
    minSpreadPct: CONFIG.MIN_SPREAD_PCT, stopLossPct: CONFIG.STOP_LOSS_PCT,
    dryRun: CONFIG.DRY_RUN, pair: CONFIG.SELECTED_PAIR,
  };
}

// ── EFFACER LE SUIVI DE POSITION SANS VENDRE (récupération après une vente manuelle) ──
function clearPosition() {
  const had = state.position;
  state.position = null;
  return had;
}

module.exports = { start, stop, getState, sendWeeklyReport, fetchBalances, sellPosition, clearPosition, updateConfig, getConfig };
