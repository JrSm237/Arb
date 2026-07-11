# ArbiScan v2.0 — Plateforme d'Arbitrage Crypto

Scanner d'arbitrage en temps réel sur **6 101 paires USDT**, **10 exchanges**, avec bot de trading automatique, alertes Telegram, et commandes Telegram pour tout contrôler à distance.

## Stack technique
- **Backend** : Node.js + Express + CCXT
- **Frontend** : HTML/CSS/JS vanilla (aucun framework)
- **Alertes & Commandes** : Telegram Bot API (webhook)
- **Déploiement** : Render.com

## Structure du projet
```
arbiscan/
├── package.json
├── .env.example          ← Copier en .env et remplir
├── README.md
├── public/
│   └── index.html        ← Site complet (Signaux + Bot + Alertes)
└── src/
    ├── server.js         ← Serveur Express + toutes les routes API
    ├── tradeBot.js       ← Bot d'exécution d'arbitrage
    ├── telegramBot.js    ← Commandes Telegram + keep-alive
    ├── telegram.js       ← Envoi d'alertes Telegram
    ├── autoScanner.js    ← Scanner automatique en arrière-plan
    └── pairs.js          ← 6 101 paires USDT
```

## Installation locale
```bash
git clone https://github.com/ton-repo/arbiscan.git
cd arbiscan
npm install
cp .env.example .env
# Remplir .env avec tes variables
npm start
# → http://localhost:3000
```

## Déploiement sur Render

1. Push le projet sur GitHub
2. Render → **New Web Service** → connecter le repo
3. **Build command** : `npm install`
4. **Start command** : `npm start`
5. Ajouter les variables d'environnement (voir `.env.example`)
6. **Deploy** → attendre 2-3 minutes

## Variables d'environnement Render (obligatoires)

| Variable | Description |
|---|---|
| `APP_URL` | URL de ton service Render (ex: https://arbiscan-xxxx.onrender.com) |
| `TELEGRAM_BOT_TOKEN` | Token de ton bot Telegram (@BotFather) |
| `TELEGRAM_CHAT_ID` | Ton chat ID Telegram |
| `ADMIN_KEY` | Clé secrète pour les actions admin |

## Fonctionnalités

### ⬡ Scanner de signaux
- 6 101 paires USDT surveillées en permanence
- Scan rapide (Top 30-500 paires) ou scan complet
- Auto-scan toutes les 60s en arrière-plan
- Alertes Telegram automatiques si spread > seuil

### 🤖 Bot de trading
- Configuration directement depuis le site (aucune clé admin nécessaire)
- **Étape 1** : Choisir 2 exchanges parmi 8 disponibles
- **Étape 2** : Entrer ses clés API + test de connexion avec affichage du solde
- **Étape 3** : Choisir la paire, le capital par exchange, le spread min, le mode
- Mode Simulation (🧪) ou Production (💰)
- Config sauvegardée → redémarrage automatique si le serveur reboot
- Notifications Telegram pour chaque trade

### 📱 Commandes Telegram
Contrôle complet du bot depuis Telegram :

| Commande | Action |
|---|---|
| `/help` | Liste des commandes |
| `/status` | État du bot, PnL, balances |
| `/start_bot` | Relancer le bot |
| `/stop_bot` | Arrêter le bot |
| `/rapport` | Rapport complet |
| `/scan` | Scan rapide Top 30 |
| `/ping` | Vérifier que le serveur tourne |
| `/keepalive_on` | Ping auto toutes les 13 min (évite la veille) |
| `/keepalive_off` | Désactiver le ping auto |

### 🔄 Keep-alive automatique
- Le serveur se ping lui-même toutes les **13 minutes**
- Empêche Render (plan gratuit) de mettre le serveur en veille
- Activé automatiquement au démarrage si Telegram est configuré
- Ton téléphone n'a pas besoin d'être connecté

## Sécurité API
⚠️ Pour les clés API des exchanges :
- Activer uniquement : **Read** + **Trade**
- Ne JAMAIS activer : **Withdraw (Retrait)**
- Recommandé : restreindre les clés à l'IP de Render

## Routes API

| Route | Méthode | Description |
|---|---|---|
| `/api/scan` | POST | Scan rapide de signaux |
| `/api/scan/full` | POST | Scan complet |
| `/api/status` | GET | Statut scanner + derniers signaux |
| `/api/bot/start` | POST | Démarrer le bot |
| `/api/bot/stop` | POST | Arrêter le bot |
| `/api/bot/status` | GET | État bot (PnL, trades, balances) |
| `/api/bot/test-connections` | POST | Tester les clés API |
| `/api/bot/keepalive` | GET/POST | Statut et contrôle du keep-alive |
| `/api/bot/report` | POST | Rapport Telegram |
| `/api/alert/test` | POST | Test alerte Telegram |
| `/telegram-webhook` | POST | Webhook pour les commandes Telegram |
