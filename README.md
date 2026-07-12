# ArbiScan Bot — Bot de trading d'arbitrage crypto

Bot de trading automatique configurable sur **2 exchanges au choix parmi 4** (Bybit, MEXC, HTX,
KuCoin), avec alertes Telegram et commandes Telegram pour tout contrôler à distance.

Version allégée : la partie "scanner de signaux" a été retirée pour ne garder que le bot de
trading — plus léger en RAM, plus stable, et c'est la seule partie qui compte vraiment.

Ce projet ne contient **aucun système de compte, d'abonnement ou de paiement** : c'est un outil
personnel, à usage privé (le tien).

## Stack technique
- **Backend** : Node.js + Express + CCXT
- **Frontend** : HTML/CSS/JS vanilla (aucun framework)
- **Alertes & Commandes** : Telegram Bot API (webhook)
- **Déploiement** : n'importe quel hébergeur Node (Render, AWS Lightsail, VPS…)

## Structure du projet
```
arbiscan/
├── package.json
├── .env.example          ← Copier en .env et remplir
├── README.md
├── deploy/
│   └── lightsail-setup.sh ← Script de déploiement AWS Lightsail
├── public/
│   └── index.html         ← Site (uniquement le panneau Bot Trading)
└── src/
    ├── server.js          ← Serveur Express + routes API bot
    ├── tradeBot.js         ← Bot d'exécution d'arbitrage (2 exchanges dynamiques)
    ├── telegramBot.js      ← Commandes Telegram + keep-alive
    └── telegram.js         ← Envoi de messages Telegram
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

Les **clés API des exchanges** (pour le bot de trading) ne vont pas dans `.env` : elles se
saisissent directement sur le site, à l'étape 2 du panneau bot.

## Fonctionnalités

### 🤖 Bot de trading
Configuration entièrement depuis le site, en 3 étapes :
1. **Choisir 2 exchanges** parmi 4 disponibles (Bybit, MEXC, HTX, KuCoin)
2. **Entrer les clés API** de ces 2 exchanges + tester la connexion (solde affiché) — protégé par
   la clé admin (`ADMIN_KEY`)
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
| `/ping` | Vérifier que le serveur tourne |
| `/keepalive_on` / `/keepalive_off` | Ping auto toutes les 13 min (utile sur un hébergement gratuit qui met en veille) |

## Routes API

| Route | Méthode | Auth | Description |
|---|---|---|---|
| `/api/exchanges` | GET | — | Liste des 4 exchanges supportés |
| `/api/bot/status` | GET | — | État bot (PnL, trades, balances) — lecture seule |
| `/api/bot/test-connections` | POST | `ADMIN_KEY` | Tester des clés API exchange |
| `/api/bot/start` | POST | `ADMIN_KEY` | Démarrer le bot |
| `/api/bot/stop` | POST | `ADMIN_KEY` | Arrêter le bot |
| `/api/bot/report` | POST | `ADMIN_KEY` | Envoyer un rapport Telegram |
| `/api/bot/keepalive` | GET/POST | `ADMIN_KEY` (POST) | Statut / contrôle du keep-alive |
| `/telegram-webhook` | POST | — | Webhook pour les commandes Telegram |

## ⚠️ Avertissement
Ceci n'est pas un conseil financier. Le trading algorithmique comporte des risques de perte en
capital (slippage, latence, retraits d'ordres, pannes d'exchange...). Teste toujours en mode
**Simulation** avant de passer en **Production**, et ne mets que des montants que tu peux te
permettre de perdre.

## Déploiement sur AWS Lightsail
Un script prêt à l'emploi est fourni dans `deploy/lightsail-setup.sh` : installation de Node.js,
PM2 (garde le process actif + redémarre automatiquement s'il dépasse 900 Mo de RAM ou après un
reboot), installation des dépendances et démarrage. Envoie d'abord le dossier du projet sur le
serveur via WinSCP (SFTP, port 22), puis en SSH :
```bash
chmod +x deploy/lightsail-setup.sh
./deploy/lightsail-setup.sh
```
