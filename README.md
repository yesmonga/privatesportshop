# PrivateSportShop Stock Monitor

Bot de monitoring de stock pour PrivateSportShop avec notifications Discord et ajout automatique au panier.

## Fonctionnalités

- 🔍 **Recherche de produits** par URL ou ID
- 📦 **Monitoring de stock** en temps réel
- 🛒 **Ajout automatique au panier** quand le stock est disponible
- 📱 **Notifications Discord** avec embed détaillé
- 📋 **Historique des produits** avec quick re-add
- 🎨 **Interface mobile-friendly**

## Installation

```bash
npm install
```

## Configuration

Variables d'environnement (optionnel, configurables via l'interface) :

```bash
# Discord webhook pour les notifications
DISCORD_WEBHOOK=https://discord.com/api/webhooks/...

# Auth Basic (base64 encoded userId:token)
PSS_BASIC_AUTH=MjQ3MDY3ODg6TnJwOHlF...

# Cookies complets
PSS_COOKIES=access_token=...; refresh_token=...; ...

# Port (default: 3000)
PORT=3000
```

## Lancement

```bash
npm start
# ou
node server.js
```

## API Endpoints

### Products

- `GET /api/products` - Liste des produits monitorés
- `POST /api/products/fetch` - Rechercher un produit
- `POST /api/products/add` - Ajouter au monitoring
- `DELETE /api/products/:key` - Supprimer du monitoring
- `POST /api/products/:key/reset` - Reset notifications

### History

- `GET /api/history` - Historique des produits
- `DELETE /api/history` - Effacer l'historique
- `DELETE /api/history/:key` - Supprimer un élément

### Config

- `POST /api/config/auth` - Mettre à jour l'authentification
- `POST /api/config/discord` - Configurer le webhook Discord

### Health

- `GET /health` - Status du serveur
- `GET /ping` - Ping

## Format URL Produit

```
https://www.privatesportshop.fr/catalog/product/view/id/{productId}
```

## Obtenir les tokens

1. Ouvrir l'app iOS PrivateSportShop
2. Utiliser un proxy (Charles/Proxyman) pour capturer les requêtes
3. Récupérer le header `Authorization: Basic ...` et les cookies

## License

MIT
