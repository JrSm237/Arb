# ArbiScan — Scanner d'arbitrage crypto + bot de trading

Scanner d'arbitrage en temps réel sur des milliers de paires USDT, 10 exchanges (lecture publique
via CCXT), avec un bot de trading automatique configurable sur **2 exchanges au choix**, des
alertes Telegram, et des commandes Telegram pour tout contrôler à distance.

Ce projet ne contient **aucun système de compte, d'abonnement ou de paiement** : c'est un outil
personnel, à usage privé (le tien).

## Stack technique
- **Backend** : Node.js + Express + CCXT
- **Frontend** : HTML/CSS/JS vanilla (aucun framework)
- **Alertes & Commandes** : Telegram Bot API (webhook)
- **Déploiement** : n'importe quel hébergeur Node (Render, Railway, VPS…)

## Structure du projet
```
arbiscan/
├── package.json
├── .env.example          ← Copier en .env et remplir
├── README.md
├── public/
│   └── index.html        ← Site complet (Signaux + Alertes + Bot)
└── src/
    ├── server.js         ← Serveur Express + routes API
    ├── tradeBot.js        ← Bot d'exécution d'arbitrage (2 exchanges dynamiques)
    ├── telegramBot.js     ← Commandes Telegram + keep-alive
    ├── telegram.js        ← Envoi d'alertes Telegram
    ├── autoScanner.js     ← Scanner automatique en arrière-plan
    └── pairs.js           ← Liste des paires USDT
```

## Installation locale
```bash
git clone <ton-repo>
cd arbiscan
npm install
cp .env.example .env
# Remplir .env — au minimum ADMIN_KEY (et Telegram si tu veux les alertes)
npm start
# → http://localhost:3000
```

## Variables d'environnement (`.env`)

| Variable | Obligatoire | Description |
|---|---|---|
| `ADMIN_KEY` | **Oui** | Protège le démarrage/arrêt du bot (argent réel). Sans elle, ces routes sont bloquées. |
| `APP_URL` | Recommandé | URL publique de ton app (keep-alive + webhook Telegram) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optionnel | Active les alertes et commandes Telegram |
| `ALERT_SPREAD` | Optionnel | Seuil de spread (%) pour déclencher une alerte (défaut 2.0) |
| `SCAN_INTERVAL` | Optionnel | Intervalle du scanner automatique en ms (défaut 60000) |

Les **clés API des exchanges** (pour le bot de trading) ne vont pas dans `.env` : elles se
saisissent directement sur le site, à l'étape 2 du panneau "Bot Trading".

## Fonctionnalités

### ⬡ Scanner de signaux
- Des milliers de paires USDT surveillées sur 10 exchanges
- Scan rapide (Top 30-500 paires) ou scan complet
- Auto-scan toutes les 60s en arrière-plan
- Alertes Telegram automatiques si spread > seuil

### 🤖 Bot de trading
Configuration entièrement depuis le site, en 3 étapes :
1. **Choisir 2 exchanges** parmi 8 disponibles (OKX, HTX, Binance, Bybit, KuCoin, MEXC, Gate.io, Bitget)
2. **Entrer les clés API** de ces 2 exchanges + tester la connexion (solde affiché) — protégé par la
   clé admin (`ADMIN_KEY`)
3. **Choisir la paire, le capital par exchange, le spread minimum, le mode** (Simulation 🧪 ou
   Production 💰) puis démarrer

Le bot achète sur l'exchange le moins cher et vend simultanément sur l'exchange le plus cher dès
qu'un spread net dépasse le seuil configuré. La configuration est sauvegardée côté serveur :
si le serveur redémarre, le bot repart automatiquement avec la même config.

⚠️ **Sécurité** : crée tes clés API avec uniquement les droits **Read + Trade**, jamais
**Withdraw (Retrait)**.

### 📱 Commandes Telegram
| Commande | Action |
|---|---|
| `/help` | Liste des commandes |
| `/status` | État du bot, PnL, balances |
| `/start_bot` | Relancer le bot (dernière config sauvegardée) |
| `/stop_bot` | Arrêter le bot |
| `/rapport` | Rapport complet |
| `/scan` | Scan rapide Top 30 |
| `/ping` | Vérifier que le serveur tourne |
| `/keepalive_on` / `/keepalive_off` | Ping auto toutes les 13 min (utile sur un hébergement gratuit qui met en veille) |

## Routes API

| Route | Méthode | Auth | Description |
|---|---|---|---|
| `/api/scan` | POST | — | Scan rapide de signaux |
| `/api/scan/full` | POST | — | Scan complet |
| `/api/status` | GET | — | Statut scanner + derniers signaux |
| `/api/bot/status` | GET | — | État bot (PnL, trades, balances) — lecture seule |
| `/api/bot/test-connections` | POST | `ADMIN_KEY` | Tester des clés API exchange |
| `/api/bot/start` | POST | `ADMIN_KEY` | Démarrer le bot |
| `/api/bot/stop` | POST | `ADMIN_KEY` | Arrêter le bot |
| `/api/bot/report` | POST | `ADMIN_KEY` | Envoyer un rapport Telegram |
| `/api/bot/keepalive` | GET/POST | `ADMIN_KEY` (POST) | Statut / contrôle du keep-alive |
| `/api/alert/test` | POST | — | Test alerte Telegram |
| `/telegram-webhook` | POST | — | Webhook pour les commandes Telegram |

## ⚠️ Avertissement
Ceci n'est pas un conseil financier. Le trading algorithmique comporte des risques de perte en
capital (slippage, latence, retraits d'ordres, pannes d'exchange...). Teste toujours en mode
**Simulation** avant de passer en **Production**, et ne mets que des montants que tu peux te
permettre de perdre.

## Mémoire / hébergement
Le scanner interroge en parallèle plusieurs exchanges via CCXT, qui garde en mémoire la liste
complète des marchés de chaque exchange (plusieurs Mo chacun). Sur une instance à RAM très limitée
(ex: petits plans gratuits ~512 Mo), le cumul scanner automatique + scan manuel + bot de trading
peut faire planter le process avec une erreur `JavaScript heap out of memory`. Si ça arrive :
- Réduis `AUTO_SCAN_PAIRS` dans `.env` (ex: 15-20)
- Évite de laisser tourner en même temps le scan automatique client ("Auto-scan 30s") ET le
  scanner serveur (déjà actif en permanence) ET le bot de trading
- Si le problème persiste, passe sur un plan avec plus de RAM (1 Go recommandé)
