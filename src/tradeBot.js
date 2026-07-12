// ── BOT D'EXÉCUTION AUTOMATIQUE D'ARBITRAGE ──────────────────────────────────
// 2 exchanges au choix (parmi ceux supportés par CCXT) — Spot uniquement
// Sécurité : les clés API ne doivent JAMAIS avoir le droit "Withdraw"

require('dotenv').config();
const ccxt = require('ccxt');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '2.0'),
  SELECTED_PAIR:  null,
  EXCHANGE_1:     null,   // ex: 'okx'   — choisi dynamiquement depuis le site
  EXCHANGE_2:     null,   // ex: 'htx'
  CAPITAL_1:      parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  CAPITAL_2:      parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  FEE_PCT:        0.1,
  SCAN_INTERVAL:  15000,
  ORDER_TIMEOUT:  10000,
  MAX_SLIPPAGE:   0.3,
  DRY_RUN:        process.env.DRY_RUN !== 'false',
  AUTO_REBALANCE: false, // conversion locale USDT<->token sur l'exchange à sec, avant le trade
};

// ── EXCHANGES (construits dynamiquement selon la sélection utilisateur) ──────
// Instances PUBLIQUES pour fetch des prix (pas besoin de clés)
const publicExchanges = {};
// Instances PRIVÉES pour passer les ordres / lire les balances (clés requises)
const privateExchanges = {};

// Compteur de session : incrémenté à chaque start()/stop(). Toute boucle de
// scan lancée par une session précédente se compare à ce compteur et s'arrête
// d'elle-même dès qu'il change — ça évite d'avoir plusieurs boucles de scan
// qui tournent en parallèle si le bot est redémarré plusieurs fois.
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

// ── PAIRES PRIORITAIRES (celles qui ont montré des spreads) ───────────────────
const PRIORITY_PAIRS = [
  'BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT',
  'DOGE/USDT','ADA/USDT','AVAX/USDT','LINK/USDT','DOT/USDT',
  'MATIC/USDT','LTC/USDT','UNI/USDT','ATOM/USDT','BCH/USDT',
  'GMX/USDT','RUNE/USDT','INJ/USDT','WIF/USDT','PEPE/USDT',
  'BONK/USDT','ARB/USDT','OP/USDT','TIA/USDT','SUI/USDT',
  'SEI/USDT','FTM/USDT','NEAR/USDT','APT/USDT','TON/USDT',
];

// ── ÉTAT DU BOT ───────────────────────────────────────────────────────────────
const state = {
  running:       false,
  totalTrades:   0,
  successTrades: 0,
  failedTrades:  0,
  totalPnL:      0,
  balances:      {},
  lastScan:      null,
  activeTrade:   null,
  tradeHistory:  [],
};

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

// ── FETCH BALANCES ────────────────────────────────────────────────────────────
async function fetchBalances() {
  const ids = [...new Set([CONFIG.EXCHANGE_1, CONFIG.EXCHANGE_2].filter(Boolean))];

  for (const id of ids) {
    try {
      const ex = privateExchanges[id];

      if (!ex) {
        // Pas de clés API configurées : balances simulées (mode simulation)
        state.balances[id] = {
          USDT:      CONFIG.DRY_RUN ? capitalFor(id) : 0,
          total:     {},
          free:      {},
          simulated: true,
        };
        continue;
      }

      // Timeout dur (15s) en plus du timeout interne de ccxt : évite qu'un
      // exchange qui ne répond pas bloque indéfiniment le démarrage du bot.
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

// ── RÉÉQUILIBRAGE LOCAL (USDT <-> TOKEN, SUR LE MÊME EXCHANGE) ───────────────
// Si l'exchange d'achat manque d'USDT, ou l'exchange de vente manque du token
// à vendre, on tente une conversion LOCALE (un ordre de marché sur ce même
// exchange, pas de transfert entre exchanges) en utilisant l'autre actif déjà
// présent là-bas. Ne change rien si AUTO_REBALANCE est désactivé.
async function rebalanceIfNeeded(buyExchange, sellExchange, symbol, buyPrice) {
  if (!CONFIG.AUTO_REBALANCE || CONFIG.DRY_RUN) return { ok: true }; // en simulation, hasEnoughFunds() valide déjà tout

  const base         = symbol.split('/')[0];
  const buyerCapital = capitalFor(buyExchange);
  const neededToken  = buyerCapital / buyPrice;

  const buyerUSDT   = state.balances[buyExchange]?.USDT || 0;
  const sellerToken = state.balances[sellExchange]?.free?.[base] || 0;

  // 1) L'exchange d'ACHAT manque d'USDT → vendre un peu de son stock de `base` pour en récupérer
  if (buyerUSDT < buyerCapital) {
    const shortfallUSDT = buyerCapital - buyerUSDT;
    const buyerToken    = state.balances[buyExchange]?.free?.[base] || 0;
    const tokenToSell   = (shortfallUSDT / buyPrice) * 1.02; // +2% marge pour frais/slippage
    if (buyerToken < tokenToSell) {
      return { ok: false, reason: `${buyExchange}: pas assez de ${base} pour se reconvertir en USDT (besoin ${tokenToSell.toFixed(6)}, dispo ${buyerToken.toFixed(6)})` };
    }
    try {
      console.log(`🔁 Rééquilibrage ${buyExchange}: vente de ${tokenToSell.toFixed(6)} ${base} → USDT`);
      await placeMarketOrder(buyExchange, symbol, 'sell', tokenToSell);
      await tg(`🔁 *Rééquilibrage local* sur \`${buyExchange}\`\nVente de ${tokenToSell.toFixed(6)} ${base} → USDT (avant trade d'arbitrage)`);
    } catch (e) {
      return { ok: false, reason: `Rééquilibrage ${buyExchange} échoué: ${e.message}` };
    }
  }

  // 2) L'exchange de VENTE manque du token `base` → acheter le manque avec son stock d'USDT
  if (sellerToken < neededToken) {
    const shortfallToken = neededToken - sellerToken;
    const sellerUSDT      = state.balances[sellExchange]?.USDT || 0;
    const usdtNeeded       = (shortfallToken * buyPrice) * 1.02; // +2% marge
    if (sellerUSDT < usdtNeeded) {
      return { ok: false, reason: `${sellExchange}: pas assez d'USDT pour racheter du ${base} (besoin ${usdtNeeded.toFixed(2)}, dispo ${sellerUSDT.toFixed(2)})` };
    }
    try {
      console.log(`🔁 Rééquilibrage ${sellExchange}: achat de ${shortfallToken.toFixed(6)} ${base} avec USDT`);
      await placeMarketOrder(sellExchange, symbol, 'buy', shortfallToken * 1.02);
      await tg(`🔁 *Rééquilibrage local* sur \`${sellExchange}\`\nAchat de ${(shortfallToken*1.02).toFixed(6)} ${base} avec USDT (avant trade d'arbitrage)`);
    } catch (e) {
      return { ok: false, reason: `Rééquilibrage ${sellExchange} échoué: ${e.message}` };
    }
  }

  // Rafraîchir les balances après conversion, avant de lancer le vrai trade d'arbitrage
  await fetchBalances();
  return { ok: true };
}

// ── VÉRIFIER LES MINIMUMS D'ORDRE DE L'EXCHANGE ──────────────────────────────
// Chaque exchange refuse les ordres trop petits (valeur ou quantité en dessous
// d'un seuil). On vérifie AVANT d'envoyer l'ordre pour éviter un rejet en
// pleine exécution (dangereux si l'autre jambe, elle, est déjà passée).
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
  if (!lim) return { ok: true }; // marché pas encore chargé — on ne bloque pas, l'exchange validera lui-même
  const cost = amount * price;
  if (lim.minAmount && amount < lim.minAmount) {
    return { ok: false, reason: `${exchangeId}: quantité ${amount.toFixed(6)} < minimum ${lim.minAmount}` };
  }
  if (lim.minCost && cost < lim.minCost) {
    return { ok: false, reason: `${exchangeId}: valeur ordre ${cost.toFixed(3)} USDT < minimum ${lim.minCost} USDT` };
  }
  return { ok: true };
}

// ── VÉRIFIER QU'ON A ASSEZ DE FONDS ──────────────────────────────────────────
function hasEnoughFunds(buyExchange, sellExchange, symbol, buyPrice) {
  // En simulation : toujours autoriser le trade
  if (CONFIG.DRY_RUN) {
    return { ok: true, simulated: true };
  }

  const base         = symbol.split('/')[0];
  const buyerCapital = capitalFor(buyExchange);
  const buyerUSDT    = state.balances[buyExchange]?.USDT || 0;
  const sellerToken  = state.balances[sellExchange]?.free?.[base] || 0;
  const neededToken  = buyerCapital / buyPrice;

  if (buyerUSDT < buyerCapital) {
    return { ok: false, reason: `${buyExchange}: USDT insuffisant (${buyerUSDT.toFixed(2)} < ${buyerCapital})` };
  }
  if (sellerToken < neededToken) {
    return { ok: false, reason: `${sellExchange}: ${base} insuffisant (${sellerToken.toFixed(6)} < ${neededToken.toFixed(6)})` };
  }
  return { ok: true };
}

// ── PLACER UN ORDRE MARKET ────────────────────────────────────────────────────
async function placeMarketOrder(exchangeId, symbol, side, amount) {
  if (CONFIG.DRY_RUN) {
    console.log(`[SIM] ${side.toUpperCase()} ${amount.toFixed(6)} ${symbol} on ${exchangeId}`);
    return {
      id:        'sim-' + Date.now(),
      status:    'closed',
      filled:    amount,
      average:   0, // remplacé par buyPrice/sellPrice réels dans executeTrade
      simulated: true,
    };
  }

  const ex = privateExchanges[exchangeId];
  if (!ex) throw new Error(`Pas de clé API configurée pour ${exchangeId}`);

  try {
    return await ex.createMarketOrder(symbol, side, amount);
  } catch (e) {
    throw new Error(`Ordre ${side} ${symbol} sur ${exchangeId}: ${e.message}`);
  }
}

// ── EXÉCUTER UN TRADE D'ARBITRAGE ────────────────────────────────────────────
async function executeTrade(opp) {
  if (state.activeTrade) {
    console.log('Trade déjà en cours, on attend...');
    return;
  }

  state.activeTrade = opp;
  state.totalTrades++;

  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPct } = opp;
  const base     = symbol.split('/')[0];
  const capital  = capitalFor(buyExchange);
  const amount   = capital / buyPrice;
  const feeCost  = capital * (CONFIG.FEE_PCT / 100) * 2; // 2 legs
  const grossPnL = amount * (sellPrice - buyPrice);
  const netPnL   = grossPnL - feeCost;

  const tradeId   = `T${Date.now()}`;
  const startTime = Date.now();

  await tg(`🔄 *TRADE EN COURS* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
📈 *Spread :* \`+${spreadPct.toFixed(2)}%\`
💰 *PnL estimé :* \`+${netPnL.toFixed(3)} USDT\`

🔽 *Achat :* \`${buyExchange}\` @ $${buyPrice.toFixed(4)}
🔼 *Vente :* \`${sellExchange}\` @ $${sellPrice.toFixed(4)}
📦 *Quantité :* \`${amount.toFixed(6)} ${base}\`
${CONFIG.DRY_RUN ? '\n⚠️ _MODE SIMULATION — pas de vrai trade_' : ''}`);

  try {
    const [buyResult, sellResult] = await Promise.allSettled([
      placeMarketOrder(buyExchange,  symbol, 'buy',  amount),
      placeMarketOrder(sellExchange, symbol, 'sell', amount),
    ]);

    const buyOk  = buyResult.status  === 'fulfilled';
    const sellOk = sellResult.status === 'fulfilled';

    // ── CAS 1 : LES DEUX JAMBES ONT RÉUSSI ──────────────────────────────────
    if (buyOk && sellOk) {
      const buyOrder  = buyResult.value;
      const sellOrder = sellResult.value;
      const elapsed = Date.now() - startTime;

      const realBuyPrice  = buyOrder.average  || buyPrice;
      const realSellPrice = sellOrder.average || sellPrice;
      const realPnL = (realSellPrice - realBuyPrice) * amount - feeCost;

      if (CONFIG.DRY_RUN) {
        const b = symbol.split('/')[0];
        if (!state.balances[buyExchange])  state.balances[buyExchange]  = { USDT: capitalFor(buyExchange),  free: {} };
        if (!state.balances[sellExchange]) state.balances[sellExchange] = { USDT: capitalFor(sellExchange), free: {} };
        state.balances[buyExchange].USDT -= capital;
        state.balances[buyExchange].free[b] = (state.balances[buyExchange].free[b] || 0) + amount;
        state.balances[sellExchange].free[b] = Math.max(0, (state.balances[sellExchange].free[b] || 0) - amount);
        state.balances[sellExchange].USDT += (amount * realSellPrice) - feeCost / 2;
      }

      state.totalPnL += realPnL;
      state.successTrades++;

      const trade = {
        id: tradeId, symbol, buyExchange, sellExchange,
        buyPrice: realBuyPrice, sellPrice: realSellPrice, amount, spreadPct,
        pnl: realPnL, feeCost,
        buyOrderId:  buyOrder.id,
        sellOrderId: sellOrder.id,
        duration:    elapsed,
        timestamp:   new Date().toISOString(),
        status:      'success',
      };
      state.tradeHistory.unshift(trade);
      if (state.tradeHistory.length > 100) state.tradeHistory.pop();

      await tg(`✅ *TRADE RÉUSSI* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
💰 *PnL net :* \`+${realPnL.toFixed(4)} USDT\`
📊 *PnL total :* \`+${state.totalPnL.toFixed(4)} USDT\`
⏱ *Durée :* \`${elapsed}ms\`

🔽 *Acheté :* ${amount.toFixed(6)} @ $${realBuyPrice.toFixed(4)} sur \`${buyExchange}\`
🔼 *Vendu :* ${amount.toFixed(6)} @ $${realSellPrice.toFixed(4)} sur \`${sellExchange}\`
📋 *Trades :* ${state.successTrades}✅ / ${state.failedTrades}❌`);

      return trade;
    }

    // ── CAS 2 : EXÉCUTION PARTIELLE — UNE SEULE JAMBE EST PASSÉE ────────────
    // C'est la situation la plus dangereuse : de l'argent/des tokens ont
    // réellement bougé sur UN exchange, mais pas sur l'autre. Le bot n'a
    // aucun moyen d'annuler un ordre au marché déjà exécuté. On arrête le
    // bot automatiquement plutôt que de répéter l'erreur en boucle, et on
    // alerte immédiatement pour une intervention manuelle.
    if (buyOk !== sellOk) {
      state.failedTrades++;
      const filledSide = buyOk ? 'ACHAT' : 'VENTE';
      const filledEx   = buyOk ? buyExchange : sellExchange;
      const failedEx   = buyOk ? sellExchange : buyExchange;
      const filledOrder = buyOk ? buyResult.value : sellResult.value;
      const failReason  = (buyOk ? sellResult.reason : buyResult.reason)?.message || 'Erreur inconnue';

      state.running = false; // pause automatique du bot

      const trade = {
        id: tradeId, symbol, buyExchange, sellExchange, spreadPct,
        pnl: 0, status: 'partial',
        error: `Exécution partielle : ${filledSide} exécuté sur ${filledEx} (${(filledOrder?.filled||amount).toFixed(6)} ${base}), échec sur ${failedEx} : ${failReason}`,
        timestamp: new Date().toISOString(),
      };
      state.tradeHistory.unshift(trade);
      if (state.tradeHistory.length > 100) state.tradeHistory.pop();

      await tg(`🚨🚨 *EXÉCUTION PARTIELLE — BOT MIS EN PAUSE* \`${tradeId}\` 🚨🚨

⚠️ Une seule des deux jambes du trade a été exécutée !

💎 *Paire :* \`${symbol}\`
✅ *${filledSide} exécuté sur* \`${filledEx}\` — ${(filledOrder?.filled||amount).toFixed(6)} ${base}
❌ *Échec sur* \`${failedEx}\` : ${failReason}

🛑 *Le bot est automatiquement arrêté* pour éviter que ça se reproduise en boucle.

⚠️ *ACTION REQUISE* :
1. Vérifie tes balances réelles sur ${filledEx} et ${failedEx}
2. Rééquilibre manuellement si besoin (tu as maintenant plus ou moins de ${base}/USDT que prévu sur ${filledEx})
3. Relance le bot depuis le site une fois vérifié`);

      await fetchBalances();
      return trade;
    }

    // ── CAS 3 : LES DEUX JAMBES ONT ÉCHOUÉ — AUCUNE POSITION OUVERTE ────────
    throw new Error(`Achat: ${buyResult.reason?.message || 'ok'} | Vente: ${sellResult.reason?.message || 'ok'}`);

  } catch (e) {
    state.failedTrades++;

    const trade = {
      id: tradeId, symbol, buyExchange, sellExchange, spreadPct,
      pnl: 0, error: e.message,
      timestamp: new Date().toISOString(),
      status:    'failed',
    };
    state.tradeHistory.unshift(trade);

    await tg(`❌ *TRADE ÉCHOUÉ* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
⚠️ *Erreur :* \`${e.message}\`
📋 *Trades :* ${state.successTrades}✅ / ${state.failedTrades}❌

_Aucune position ouverte — les deux jambes ont échoué, rien n'a bougé._`);

    console.error('Trade failed:', e.message);
    return trade;

  } finally {
    state.activeTrade = null;
    // Rafraîchit toujours les balances après une tentative de trade (succès,
    // échec ou partiel) — sans ça, les vérifications de fonds du prochain
    // scan travaillent sur des données périmées.
    fetchBalances().catch(() => {});
  }
}

// Anti-spam : n'alerte sur Telegram qu'une fois toutes les 5 minutes max
// pour les échecs de rééquilibrage (sinon un scan toutes les 15s peut spammer).
let lastFundsAlertTs = 0;
function shouldAlertFunds() {
  const now = Date.now();
  if (now - lastFundsAlertTs > 5 * 60 * 1000) { lastFundsAlertTs = now; return true; }
  return false;
}

// ── SCAN ET DÉTECTION D'OPPORTUNITÉS ─────────────────────────────────────────
async function scanAndTrade() {
  if (state.activeTrade) return;
  if (!CONFIG.EXCHANGE_1 || !CONFIG.EXCHANGE_2) return;
  state.lastScan = new Date();

  const pairsToScan = CONFIG.SELECTED_PAIR ? [CONFIG.SELECTED_PAIR] : PRIORITY_PAIRS;
  const ex1 = CONFIG.EXCHANGE_1;
  const ex2 = CONFIG.EXCHANGE_2;
  console.log(`🔍 Scan — ${pairsToScan.length} paire(s) sur ${ex1}↔${ex2} — spread min: ${CONFIG.MIN_SPREAD_PCT}% [${CONFIG.DRY_RUN?'SIM':'LIVE'}]`);
  let signalsFound = 0;

  for (const symbol of pairsToScan) {
    if (state.activeTrade) break;

    try {
      const [ex1Ticker, ex2Ticker] = await Promise.all([
        fetchTicker(ex1, symbol),
        fetchTicker(ex2, symbol),
      ]);

      if (!ex1Ticker || !ex2Ticker) continue;

      const opportunities = [
        { buyExchange: ex1, buyPrice: ex1Ticker.ask || ex1Ticker.last, sellExchange: ex2, sellPrice: ex2Ticker.bid || ex2Ticker.last },
        { buyExchange: ex2, buyPrice: ex2Ticker.ask || ex2Ticker.last, sellExchange: ex1, sellPrice: ex1Ticker.bid || ex1Ticker.last },
      ];

      for (const opp of opportunities) {
        if (!opp.buyPrice || !opp.sellPrice) continue;

        const spreadPct = ((opp.sellPrice - opp.buyPrice) / opp.buyPrice) * 100;
        const netSpread = spreadPct - CONFIG.FEE_PCT * 2;

        if (netSpread < CONFIG.MIN_SPREAD_PCT) continue;

        const amount = capitalFor(opp.buyExchange) / opp.buyPrice;
        const minCheckBuy  = orderMeetsMinimum(opp.buyExchange,  symbol, amount, opp.buyPrice);
        const minCheckSell = orderMeetsMinimum(opp.sellExchange, symbol, amount, opp.sellPrice);
        if (!minCheckBuy.ok)  { console.log(`⚠ Ordre trop petit: ${minCheckBuy.reason}`);  continue; }
        if (!minCheckSell.ok) { console.log(`⚠ Ordre trop petit: ${minCheckSell.reason}`); continue; }

        const fundsCheck = hasEnoughFunds(opp.buyExchange, opp.sellExchange, symbol, opp.buyPrice);
        if (!fundsCheck.ok) {
          if (CONFIG.AUTO_REBALANCE) {
            const rebalanced = await rebalanceIfNeeded(opp.buyExchange, opp.sellExchange, symbol, opp.buyPrice);
            if (!rebalanced.ok) {
              console.log(`💰 Fonds insuffisants (rééquilibrage impossible): ${rebalanced.reason}`);
              if (shouldAlertFunds()) await tg(`💰 *Rééquilibrage impossible*\n\n\`${rebalanced.reason}\`\n\nAucun trade tenté sur ${symbol} (${opp.buyExchange}→${opp.sellExchange}).\n\n_Cette alerte ne sera renvoyée qu'après 5 min, même si ça continue d'échouer._`);
              continue;
            }
            console.log(`✅ Rééquilibré — trade peut continuer`);
          } else {
            console.log(`💰 Fonds insuffisants: ${fundsCheck.reason}`);
            continue;
          }
        }

        signalsFound++;
        console.log(`🎯 Signal: ${symbol} +${netSpread.toFixed(2)}% net — ${opp.buyExchange}→${opp.sellExchange} [${CONFIG.DRY_RUN ? 'SIM' : 'LIVE'}]`);
        await executeTrade({ symbol, spreadPct: netSpread, ...opp });
        break;
      }
    } catch (e) {
      console.error(`Scan ${symbol}:`, e.message);
    }
  }

  if (signalsFound === 0) {
    console.log(`📭 Aucun signal trouvé (spread < ${CONFIG.MIN_SPREAD_PCT}% sur ${pairsToScan.join(', ')})`);
  }
}

// ── RAPPORT HEBDOMADAIRE ──────────────────────────────────────────────────────
async function sendWeeklyReport() {
  const bals = await fetchBalances();
  const ex1 = CONFIG.EXCHANGE_1 || '—';
  const ex2 = CONFIG.EXCHANGE_2 || '—';
  await tg(`📊 *RAPPORT ArbiScan*

💰 *PnL total :* \`+${state.totalPnL.toFixed(4)} USDT\`
📋 *Total trades :* ${state.totalTrades}
✅ *Réussis :* ${state.successTrades}
❌ *Échoués :* ${state.failedTrades}
🎯 *Taux réussite :* ${state.totalTrades > 0 ? ((state.successTrades/state.totalTrades)*100).toFixed(1) : 0}%

*Balances actuelles :*
${ex1.toUpperCase()} USDT : \`${bals[ex1]?.USDT?.toFixed(2) || '—'}\`
${ex2.toUpperCase()} USDT : \`${bals[ex2]?.USDT?.toFixed(2) || '—'}\`

_Vous pouvez retirer les bénéfices et maintenir le ratio 50/50_`);
}

// ── DÉMARRER LE BOT ───────────────────────────────────────────────────────────
async function start(dynamicConfig = {}) {
  // Invalider immédiatement toute session précédente : dès que son numéro de
  // session ne correspond plus à currentSession, sa boucle de scan s'arrête
  // d'elle-même au prochain tick (voir loop() plus bas).
  currentSession++;
  const mySession = currentSession;
  state.running = false;
  await new Promise(r => setTimeout(r, 500)); // laisse le temps à une éventuelle boucle en cours de voir le changement

  if (!dynamicConfig.exchange1 || !dynamicConfig.exchange2) {
    throw new Error('Deux exchanges doivent être sélectionnés (exchange1 et exchange2)');
  }

  CONFIG.EXCHANGE_1     = dynamicConfig.exchange1;
  CONFIG.EXCHANGE_2     = dynamicConfig.exchange2;
  CONFIG.CAPITAL_1      = dynamicConfig.capital1 != null ? parseFloat(dynamicConfig.capital1) : CONFIG.CAPITAL_1;
  CONFIG.CAPITAL_2      = dynamicConfig.capital2 != null ? parseFloat(dynamicConfig.capital2) : CONFIG.CAPITAL_2;
  CONFIG.MIN_SPREAD_PCT = dynamicConfig.minSpreadPct != null ? parseFloat(dynamicConfig.minSpreadPct) : CONFIG.MIN_SPREAD_PCT;
  CONFIG.DRY_RUN        = dynamicConfig.dryRun !== undefined ? !!dynamicConfig.dryRun : CONFIG.DRY_RUN;
  CONFIG.AUTO_REBALANCE = !!dynamicConfig.autoRebalance;
  CONFIG.SELECTED_PAIR  = dynamicConfig.pair || null;

  // Instances publiques (prix) — toujours nécessaires
  ensurePublicExchange(CONFIG.EXCHANGE_1);
  ensurePublicExchange(CONFIG.EXCHANGE_2);

  // Instances privées (ordres + balances réelles) — si des clés sont fournies
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
  console.log(`   Paire        : ${CONFIG.SELECTED_PAIR || 'Multi-paires'}`);
  console.log(`   Spread min   : ${CONFIG.MIN_SPREAD_PCT}%`);
  console.log(`   Capital ${CONFIG.EXCHANGE_1.toUpperCase()}  : ${CONFIG.CAPITAL_1} USDT`);
  console.log(`   Capital ${CONFIG.EXCHANGE_2.toUpperCase()}  : ${CONFIG.CAPITAL_2} USDT`);
  console.log(`   Mode         : ${CONFIG.DRY_RUN ? '🧪 SIMULATION' : '💰 PRODUCTION'}`);
  console.log(`   Rééquilibrage: ${CONFIG.AUTO_REBALANCE ? '🔁 Activé' : '⏸ Désactivé'}`);
  console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s\n`);

  try {
    await fetchBalances();
    const ex1Label = CONFIG.EXCHANGE_1.toUpperCase();
    const ex2Label = CONFIG.EXCHANGE_2.toUpperCase();
    const ex1USDT  = state.balances[CONFIG.EXCHANGE_1]?.USDT || 0;
    const ex2USDT  = state.balances[CONFIG.EXCHANGE_2]?.USDT || 0;

    await tg(`🚀 *ArbiScan Bot DÉMARRÉ*

🤖 *Mode :* ${CONFIG.DRY_RUN ? '🧪 Simulation' : '💰 Production'}
💎 *Paire :* ${CONFIG.SELECTED_PAIR || 'Multi-paires (top 30)'}
🏦 *Exchanges :* ${ex1Label} ↔ ${ex2Label}
📈 *Spread min :* ${CONFIG.MIN_SPREAD_PCT}%
💵 *Capital ${ex1Label} :* ${CONFIG.CAPITAL_1} USDT
💵 *Capital ${ex2Label} :* ${CONFIG.CAPITAL_2} USDT

*Balances :*
${ex1Label} USDT : \`${ex1USDT.toFixed(2)}\`
${ex2Label} USDT : \`${ex2USDT.toFixed(2)}\`

_Scan toutes les ${CONFIG.SCAN_INTERVAL / 1000}s — Trade si spread > ${CONFIG.MIN_SPREAD_PCT}%_`);

  } catch (e) {
    console.error('Erreur démarrage:', e.message);
    await tg(`❌ *Erreur démarrage bot*\n\n\`${e.message}\`\n\nVérifiez les clés API.`);
  }

  // Rapport hebdomadaire automatique (chaque dimanche à 20h)
  if (!global.__arbiscanWeeklyReportTimer) {
    global.__arbiscanWeeklyReportTimer = setInterval(() => {
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 1) {
        sendWeeklyReport();
      }
    }, 60000);
  }

  const loop = async () => {
    if (!state.running || mySession !== currentSession) return; // session périmée → on arrête cette boucle définitivement
    try { await scanAndTrade(); } catch (e) { console.error('Loop error:', e.message); }
    if (mySession === currentSession) setTimeout(loop, CONFIG.SCAN_INTERVAL);
  };
  setTimeout(loop, 3000);
}

function stop() {
  currentSession++; // invalide toute boucle de scan en cours, ancienne ou actuelle
  state.running = false;
  console.log('Bot arrêté.');
  tg('⏹ *Bot ArbiScan arrêté manuellement*');
}

function getState() {
  return {
    running:       state.running,
    totalTrades:   state.totalTrades,
    successTrades: state.successTrades,
    failedTrades:  state.failedTrades,
    totalPnL:      state.totalPnL,
    balances:      state.balances,
    tradeHistory:  state.tradeHistory,
    config: {
      exchange1:    CONFIG.EXCHANGE_1,
      exchange2:    CONFIG.EXCHANGE_2,
      capital1:     CONFIG.CAPITAL_1,
      capital2:     CONFIG.CAPITAL_2,
      minSpreadPct: CONFIG.MIN_SPREAD_PCT,
      dryRun:       CONFIG.DRY_RUN,
      autoRebalance: CONFIG.AUTO_REBALANCE,
      selectedPair: CONFIG.SELECTED_PAIR || 'Multi-paires',
      scanIntervalSec: CONFIG.SCAN_INTERVAL / 1000,
    }
  };
}

module.exports = { start, stop, getState, sendWeeklyReport, fetchBalances };
