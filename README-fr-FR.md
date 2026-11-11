<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-fr-FR-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-fr-FR-light.svg">
    <img src="assets/readme/overview-fr-FR-light.svg" width="100%" alt="Uptime Polaris : disponibilité des services et surveillance des hôtes">
  </picture>
</h1>

<p align="center"><strong>Vérifications HTTP/TCP, signaux de vie Push, métriques des hôtes</strong><br>Sur Cloudflare Worker ou sur un serveur Go auto-hébergé.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <strong>Français</strong> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Fonctionne sur Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Interface en React et TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent est écrit en Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#démarrage-rapide">Démarrage rapide</a> · <a href="#déploiement-sur-cloudflare">Déploiement</a> · <a href="#deploy-go">Déploiement Go</a> ·
  <a href="#surveillance-des-hôtes">Agent</a> ·
  <a href="#documentation">Documentation</a>
</p>

Uptime Polaris vérifie périodiquement des sites et des ports, reçoit les battements de cœur des tâches planifiées, collecte les métriques CPU, mémoire et disque des serveurs, et envoie une notification lorsqu'un moniteur change d'état. La page d'état publique et la console d'administration sont incluses.

## Choisir un backend

Choisissez un seul backend par déploiement. Les deux proposent la même interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Exécution | Cloudflare | Serveur ou conteneur personnel |
| Base de données | D1 ou PostgreSQL | SQLite ou PostgreSQL |
| Sondes directes | HTTP, TCP (UDP et ICMP via un Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Intervalle minimal | 60 secondes | 5 secondes |
| Fichiers de thème | R2 (facultatif) | Répertoire de données |

Utilisez Worker si vous ne souhaitez pas exploiter un serveur. Choisissez Go pour sonder le réseau interne, utiliser plus de protocoles ou réduire l'intervalle. Voir la [comparaison des backends](docs/backends.md).

## Fonctionnalités

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="Icône de vérification de service"><br>
  <strong>Vérifications de service et battements de cœur</strong><br>
  Vérifications HTTP et TCP, avec contrôles facultatifs du contenu, du certificat, de l'expiration du domaine et du DNS. Les moniteurs Push conviennent aux tâches cron et aux scripts de sauvegarde : un battement manqué au-delà du délai marque le moniteur en panne.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="Icône de surveillance d'hôte"><br>
  <strong>Surveillance des serveurs</strong><br>
  <code>polaris-agent</code> remonte les métriques CPU, mémoire, disque, charge et réseau. Il peut aussi lancer des vérifications HTTP/TCP depuis son hôte pour atteindre des services internes.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="Icône de notification d'état"><br>
  <strong>Page d'état et notifications</strong><br>
  La page d'état affiche l'état courant et l'historique des événements, avec des groupes et des fenêtres de maintenance. Les notifications passent par Telegram, Feishu, Slack, Discord, Webhook, Apprise et Server酱, et chaque canal peut être limité à certains groupes de moniteurs.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="Icône de stockage et de thèmes"><br>
  <strong>Stockage et thèmes</strong><br>
  Worker stocke les données dans D1 ou PostgreSQL et les thèmes dans R2 ; Go utilise SQLite ou PostgreSQL et conserve les thèmes dans son répertoire de données.
</p>

## Démarrage rapide

1. Déployez sur [Cloudflare](#déploiement-sur-cloudflare) ou sur [votre propre serveur](#deploy-go).
2. Ouvrez `/setup`. Worker vérifie d'abord les liaisons et les secrets ; Go demande la clé d'initialisation présente dans le journal de démarrage.
3. Créez le compte administrateur, puis ajoutez des moniteurs dans `/admin`.

## Déploiement sur Cloudflare

1. Forkez ce dépôt.
2. Dans le tableau de bord Cloudflare, ouvrez **Workers & Pages → Create application → GitHub** et choisissez votre fork. Indiquez `npm run build` comme commande de build et `npm run deploy` comme commande de déploiement.
3. Ouvrez le site après le déploiement. La page d'initialisation vérifie d'abord les liaisons et les secrets ; configurez ce qu'elle signale dans les **Settings** du Worker :
   - **Bindings** : ajoutez une base D1 avec le nom de variable `DB`. Pour les thèmes tiers, ajoutez un bucket R2 nommé `THEMES` ; pour les observations brutes et le backfill, activez Analytics Engine puis ajoutez un jeu de données nommé `UPTIME`.
   - **Variables and Secrets** : ajoutez le secret `ADMIN_TOKEN` avec une longue valeur aléatoire, par exemple la sortie de `openssl rand -hex 32`.
4. Sélectionnez **Re-check** sur la page d'initialisation, passez à l'étape suivante et saisissez `ADMIN_TOKEN` pour créer le compte administrateur.

Les mises à jour se font avec **Sync fork** sur GitHub ; Workers Builds redéploie automatiquement et conserve les liaisons ajoutées dans le tableau de bord.

Vous pouvez aussi déployer avec le bouton ci-dessous. Il crée un nouveau dépôt dans votre compte GitHub (ce n'est pas un fork, il ne peut donc pas être mis à jour avec Sync fork) ; configurez la base et le secret comme indiqué par la page d'initialisation :

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

Le [guide de déploiement](docs/deployment.md) couvre le déploiement en ligne de commande et PostgreSQL.

<a id="deploy-go"></a>

## Déployer le backend Go

Téléchargez la version adaptée à votre système depuis [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), renommez-la en `polaris` (`polaris.exe` sous Windows) puis lancez-la :

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

Le programme écoute par défaut sur `127.0.0.1:8080`. Pour un accès externe, modifiez `--addr` ou ajoutez un reverse proxy. Toutes les données résident dans `./data` ; gardez ce répertoire persistant, limitez-y l'accès et sauvegardez-le régulièrement. Voir le [guide du backend Go](backends/go/README.md#install-and-start) pour la configuration.

## Surveillance des hôtes

Ajoutez une machine dans la page Agent de la console, choisissez une plateforme et un mode d'installation, puis exécutez la commande générée sur la machine cible. La machine cible doit pouvoir joindre GitHub.

Après l'installation, gérez le service avec `pa` (forme courte de `polaris-agent`) :

```sh
pa status
pa restart
pa logs -f
```

- Les commandes d'installation contiennent l'adresse du site et le token de la machine. Générez-les depuis le domaine de production et ne les publiez jamais.
- Ajouter une machine ne crée pas de moniteur. Pour surveiller l'état en ligne ou les seuils de ressources, ajoutez un moniteur de type Agent dans la page des moniteurs.
- Les installations manuelles n'ont pas de gestionnaire de services : `pa start`, `stop` et `restart` sont indisponibles.

Voir le [guide Agent](docs/agents.md) pour la suite.

## Utilisation et informations publiques

La page d'état est anonyme. Les noms de moniteurs, chemins cibles et noms d'hôte peuvent apparaître sur les pages et API publiques : n'y mettez jamais d'adresses internes ni de secrets. Voir les [données publiques](docs/usage.md#公开数据) et le [guide des notifications](docs/notifications.md).

## Documentation

| Document | Contenu |
| --- | --- |
| [Comparaison des backends](docs/backends.md) | Différences entre Worker et Go |
| [Guide de déploiement](docs/deployment.md) | Déploiement fork, bouton et manuel, domaines, PostgreSQL, migration D1 vers PostgreSQL |
| [Backend Go](backends/go/README.md) | Options de démarrage, variables d'environnement, migration SQLite vers PostgreSQL |
| [Guide d'utilisation](docs/usage.md) | Configuration des moniteurs, Push, état et disponibilité |
| [Guide Agent](docs/agents.md) | Installation, gestion, configuration, mises à jour, désinstallation |
| [Guide des notifications](docs/notifications.md) | Configuration des canaux, portée des groupes, historique de remise |
| [Guide des thèmes](docs/themes.md) | Installation, configuration, prévisualisation |
| [Référence de configuration](docs/configuration.md) | Liaisons, variables d'environnement, réglages de la console |
| [Référence API](docs/api.md) | Points d'accès, authentification, exemples |
| [Guide d'exploitation](docs/operations.md) | Sauvegarde, restauration, mises à niveau, rétention |
| [Dépannage](docs/troubleshooting.md) | Diagnostic par symptôme |

## Licence

Ce projet est distribué sous [licence MIT](LICENSE).
