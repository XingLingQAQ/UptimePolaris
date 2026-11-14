<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-fr-FR-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-fr-FR-light.svg">
  <img src="assets/readme/overview-fr-FR-light.svg" width="100%" alt="Uptime Polaris : disponibilité des services et surveillance des hôtes">
</picture>

<a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <strong>Français</strong> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - page de statut et supervision auto-hébergées

Uptime Polaris vérifie à intervalle régulier des sites, des ports et des tâches planifiées, collecte les métriques des serveurs et envoie une notification quand un statut change.<br>
Il s'exécute sur Cloudflare Workers sans serveur à maintenir, ou en backend Go sur votre propre machine.<br>
Il comprend une page de statut publique et une console d'administration ; l'interface est traduite en 9 langues.

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Fonctionne sur Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Interface en React et TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent est écrit en Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#fonctionnalités">Fonctionnalités</a> · <a href="#déploiement">Déploiement</a> · <a href="#démarrage-rapide">Démarrage rapide</a> · <a href="#surveillance-des-hôtes">Agent</a> · <a href="#données-et-portée-publique">Portée publique</a> · <a href="#questions-fréquentes">Questions fréquentes</a> · <a href="#documentation">Documentation</a></p>

</div>

## Pourquoi Uptime Polaris

- **Aucun serveur à maintenir** : déployé sur Cloudflare Workers, les vérifications, les notifications et la page de statut y tournent. Passez au backend Go pour sonder un réseau interne ou vérifier plus souvent ; les deux utilisent la même interface.
- **Un statut issu de résultats réels** : la page n'affiche que ce qu'une vérification ou un rapport a réellement produit. Une donnée manquante apparaît en attente, jamais comme saine.
- **Tâches planifiées incluses** : les scripts de sauvegarde et les tâches cron envoient un signal de vie à intervalle régulier, et un signal manquant est signalé comme panne.
- **Métriques serveur** : `polaris-agent` remonte le CPU, la mémoire, le disque, la charge et le réseau, et peut vérifier des services internes depuis la machine qui y a accès.
- **Deux pages publiques** : la page de statut des monitors et celle des machines sont distinctes et peuvent avoir leur propre domaine. Pendant une maintenance, les deux basculent vers la page de maintenance.
- **Notifications par groupe** : Telegram, Feishu, Slack, Discord, Webhook, Apprise et ServerChan, chaque canal limité aux groupes qu'il doit couvrir.
- **Choix de la base** : D1 ou PostgreSQL sur le Worker, SQLite ou PostgreSQL sur Go, et les données existantes peuvent être migrées vers PostgreSQL.

## Fonctionnalités

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> Vérifications et signaux de vie

- Les vérifications HTTP contrôlent le code de statut, les champs JSON, les en-têtes de réponse et le temps de réponse. Les vérifications TCP contrôlent l'ouverture du port, et peuvent envoyer un contenu et comparer la réponse.
- Le backend Go vérifie aussi directement UDP, ICMP, DNS, TLS et WebSocket. Sur le Worker, les vérifications UDP et ICMP passent par un Agent.
- Des vérifications complémentaires couvrent l'expiration du certificat SSL, l'expiration du domaine et les enregistrements DNS.
- Les monitors Push disposent d'une URL dédiée ; une tâche planifiée y envoie un POST et un POST manquant est signalé comme panne.
- L'intervalle minimal est de 60 secondes sur le Worker et de 5 secondes sur Go. Quand une cible n'est joignable que sur un réseau interne, choisissez un Agent comme source de vérification.

Les types de monitors et chaque champ sont décrits dans le [guide d'utilisation](docs/usage.md).

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> Surveillance des serveurs

- `polaris-agent` remonte le CPU, la mémoire, le disque, la charge, le réseau et les points de montage sous Linux, macOS et Windows ; Docker est pris en charge sous Linux.
- Les règles de ressources combinent un seuil et une durée, si bien que seules des mesures durables déclenchent une alerte. Le retour à la normale se fait selon un pourcentage du seuil, ce qui stabilise les valeurs proches de la limite.
- La page de statut des machines est facultative, avec recherche, filtres, vue cartographique et comparaison de 2 à 4 machines. Elle est désactivée par défaut et les machines restent réservées à l'administration jusqu'à leur publication.

Installation, gestion et mises à jour sont décrites dans le [guide de l'Agent](docs/agents.md).

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> Pages de statut et notifications

- La page de statut montre l'état courant, la disponibilité et l'historique des événements, regroupés à votre convenance, avec uniquement les monitors marqués publics.
- Les fenêtres de maintenance se programment une fois ou chaque semaine. Une annonce s'affiche en haut de la page avant la fenêtre, et les notifications automatiques sont suspendues pendant celle-ci.
- Chaque canal a sa langue de message et sa portée de groupes. La console conserve un journal de livraison qui distingue les envois réussis, les refus du fournisseur et les délais réseau dépassés.

La configuration des canaux et la portée des groupes sont décrites dans le [guide des notifications](docs/notifications.md).

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> Stockage et thèmes

- D1 ou PostgreSQL sur le Worker, SQLite ou PostgreSQL sur Go ; les données D1 et SQLite peuvent être migrées vers PostgreSQL.
- Les thèmes tiers s'installent sur les pages publiques à partir d'un ZIP ou d'une URL de téléchargement, et peuvent être prévisualisés avant application. Les thèmes résident dans R2 sur le Worker et dans le répertoire de données sur Go.
- Sans thème, le design intégré est utilisé. La console d'administration utilise toujours l'interface intégrée.

L'installation et la création de thèmes sont décrites dans le [guide des thèmes](docs/themes.md).

### Aussi

- **Palette de commandes** : appuyez sur `Ctrl+K` (ou `⌘K` sur macOS) dans la console pour rechercher des pages, des monitors et des Agents.
- **Popover d'état** : l'en-tête de la console résume les monitors en échec et les Agents hors ligne, avec mise en pause, vérification immédiate et copie du résumé.
- **API** : les points de terminaison d'administration acceptent un jeton Bearer, ce qui permet de créer et gérer les monitors depuis des scripts. Voir la [référence de l'API](docs/api.md).
- **Langues de l'interface** : chinois simplifié, chinois traditionnel (Taïwan, Hong Kong), anglais, japonais, coréen, français, portugais et russe.

## Déploiement

Choisissez un backend par déploiement ; les deux utilisent la même interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| S'exécute sur | Cloudflare | Votre serveur ou un conteneur |
| Base de données | D1 ou PostgreSQL | SQLite ou PostgreSQL |
| Vérifications directes | HTTP, TCP (UDP et ICMP nécessitent un Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Intervalle minimal | 60 secondes | 5 secondes |
| Fichiers de thème | R2 (facultatif) | Répertoire de données |

Choisissez le Worker si vous préférez ne pas maintenir de serveur. Choisissez Go si vous devez sonder des services internes, utiliser plus de protocoles ou vérifier plus souvent. La [comparaison des backends](docs/backends.md) donne les détails.

### Déploiement sur Cloudflare

1. Faites un fork de ce dépôt.
2. Dans le tableau de bord Cloudflare, ouvrez **Workers & Pages → Create application → GitHub** et sélectionnez votre fork. Utilisez `npm run build` comme commande de build et `npm run deploy` comme commande de déploiement.
3. Ouvrez le site une fois le déploiement terminé. La page d'installation vérifie d'abord les bindings et les secrets. Configurez ce qui suit dans les **Settings** du Worker, comme la page l'indique :
   - **D1 (facultatif)** : pour utiliser D1, ajoutez une base sous **Bindings** avec le nom de variable `DB`. Sans D1, seule l’option PostgreSQL est proposée.
   - **KV (requis)** : ajoutez un espace de noms KV sous **Bindings** avec le nom de variable `CONFIG`. Il stocke la sélection de base de données et l’URL de connexion chiffrée.
   - **Clé d'initialisation** : ajoutez un secret `ADMIN_TOKEN` sous **Variables and Secrets**, avec une valeur aléatoire longue, par exemple la sortie de `openssl rand -hex 32`.
   - **Analytics Engine (obligatoire)** : activez Analytics Engine dans le tableau de bord et ajoutez le jeu de données sous **Bindings** avec le nom de variable `UPTIME`.
   - **R2 (facultatif)** : nécessaire pour les thèmes tiers. Ajoutez un bucket sous **Bindings** avec le nom de variable `THEMES`, ou ajoutez-le après l'installation.
4. Sur la page d’initialisation, sélectionnez **Re-check**. Une fois les vérifications obligatoires validées, configurez et vérifiez la base avec `ADMIN_TOKEN`, puis créez le compte administrateur.

Un bouton de déploiement est également disponible. Il crée un nouveau dépôt dans votre compte GitHub plutôt qu'un fork, donc Sync fork ne pourra plus le mettre à jour. La base de données et les secrets se configurent de la même manière depuis la page d'installation :

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

Pour les déploiements en ligne de commande et PostgreSQL, voir le [guide de déploiement](docs/deployment.md).

<a id="deploy-go"></a>

### Déploiement du backend Go

Téléchargez la version correspondant à votre système et à votre architecture depuis [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), renommez-la en `polaris` (`polaris.exe` sous Windows) et lancez-la :

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

Il écoute sur `127.0.0.1:8080` par défaut ; modifiez `--addr` ou placez un reverse proxy devant pour l'exposer. Toutes les données résident dans `./data`, qui doit être persistant, à accès restreint et sauvegardé régulièrement. Les options de lancement et les variables d'environnement sont dans le [guide du backend Go](backends/go/README.md#install-and-start).

## Démarrage rapide

1. Ouvrez `/setup` sur votre site. Le Worker vérifie d'abord les bindings et les secrets, puis demande `ADMIN_TOKEN` ; Go demande la clé d'installation affichée dans son journal de démarrage. Créez ensuite le compte administrateur.
2. Rendez-vous sur `/admin` et ajoutez un monitor dans **Monitors**. Par exemple, choisissez HTTP, saisissez `https://example.com/health`, enregistrez, puis sélectionnez « Vérifier maintenant ».
3. Ajoutez un canal dans **Notifications** et envoyez un message de test.
4. Ouvrez la racine du site dans une fenêtre de navigation privée et vérifiez ce qu'affiche la page de statut.

À la première connexion, la vue d'ensemble affiche une liste de démarrage : ajouter un monitor, nommer le site, configurer les notifications, connecter un Agent.

## Surveillance des hôtes

Ajoutez une machine dans **Agent management** de la console, choisissez la plateforme et la méthode d'installation, puis exécutez la commande générée sur la cible. La machine doit pouvoir accéder à GitHub.

Une fois installé, gérez le service avec `pa` (abréviation de `polaris-agent`) :

```sh
pa status
pa restart
pa logs -f
```

- La commande d'installation contient l'URL du site et le jeton de cette machine. Générez-la sur votre domaine réel et ne la publiez pas.
- Ajouter une machine ne crée pas de monitor. Ajoutez un monitor de type **Agent host** dans **Monitors**.
- Le mode d'installation manuel n'a pas de gestionnaire de service, donc `pa start`, `stop` et `restart` sont indisponibles.

Les modes d'installation et les différences entre plateformes sont dans le [guide de l'Agent](docs/agents.md).

## Mise à jour et désinstallation

### Mise à jour

Sauvegardez d'abord la base de données ; la procédure complète est dans le [guide d'exploitation](docs/operations.md#upgrade).

- **Cloudflare** : pour un fork, sélectionnez Sync fork sur GitHub et Workers Builds redéploie automatiquement, en conservant les bindings ajoutés dans le tableau de bord. Une installation par bouton nécessite de fusionner la nouvelle version dans le dépôt généré.
- **Go** : arrêtez le service et sauvegardez le répertoire de données, remplacez le binaire, puis relancez-le avec le même répertoire de données.
- **Agent** : exécutez `pa update` sur la machine. Les installations gérées peuvent aussi activer les mises à jour automatiques dans la console ; c'est désactivé par défaut.

### Désinstallation

- **Cloudflare** : supprimez le Worker dans le tableau de bord. La base D1, le bucket R2 et la base PostgreSQL ne sont pas supprimés avec lui ; supprimez-les séparément si vous n'en avez plus besoin.
- **Go** : arrêtez le service, puis supprimez le binaire et le répertoire de données. Si vous utilisez PostgreSQL, supprimez aussi cette base.
- **Agent** : téléchargez le script d'installation depuis votre site et lancez le désinstalleur :

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Pour Windows, voir le [guide de l'Agent](docs/agents.md#update-rollback-and-uninstall). Désinstaller un Agent ne supprime pas ses monitors de la console.

## Données et portée publique

- Les données restent dans votre propre déploiement : D1 dans votre compte Cloudflare ou votre PostgreSQL pour le Worker, SQLite dans le répertoire de données ou votre PostgreSQL pour Go.
- La page de statut et l'API publique ne demandent pas de connexion. Les noms de monitors, l'hôte et le chemin des cibles HTTP, ainsi que l'hôte et le port des cibles TCP sont publics : n'y mettez pas d'adresses internes ni de secrets.
- Les noms d'utilisateur, mots de passe et chaînes de requête des cibles HTTP sont retirés ; les identifiants et les jetons d'Agent ne sont jamais exposés.
- Le jeton d'une URL Push est l'identifiant de rapport de ce monitor. Gardez-le privé.
- Pour un monitor qui ne doit pas être public, sélectionnez « Masquer de la page de statut » dans la liste des monitors et il reste réservé à l'administration.
- La vérification SSL du Worker interroge les journaux publics de transparence des certificats, et l'Agent recherche la région de l'IP publique de la machine au démarrage et contacte GitHub pour les mises à jour.

Les champs renvoyés par les pages publiques et l'API sont décrits dans [données publiques](docs/usage.md).

## Questions fréquentes

**La page d'installation s'arrête au contrôle de déploiement et ne continue pas.**
Configurez les éléments obligatoires `ADMIN_TOKEN` et `UPTIME` dans les **Settings** du Worker, enregistrez et déployez, puis relancez la vérification. D1 et R2 sont facultatifs ; sans D1, configurez la connexion PostgreSQL à l'étape suivante.

**Ouvrir une URL Push dans un navigateur ne donne aucune donnée.**
Un navigateur envoie un GET et Push n'accepte que POST, donc GET renvoie 405. Utilisez `curl -X POST` ou envoyez le POST depuis la tâche planifiée.

**Un test de notification réussit mais les vraies pannes ne produisent rien.**
Vérifiez que le canal est activé, que sa portée de groupes inclut le monitor et qu'aucune fenêtre de maintenance n'est ouverte. Un canal sans groupe sélectionné reçoit tous les monitors.

**Un Agent apparaît hors ligne.**
Exécutez `pa status` et `pa logs -f` sur la machine et vérifiez que le service tourne et peut joindre le domaine du site. Les rapports partent toutes les 60 secondes par défaut, et environ 3 minutes sans rapport marquent la machine hors ligne.

D'autres cas sont traités dans le [dépannage](docs/troubleshooting.md). Si un problème persiste, ouvrez un [issue](https://github.com/XingLingQAQ/UptimePolaris/issues).

## Documentation

| Document | Contenu |
| --- | --- |
| [Options de backend](docs/backends.md) | Différences entre le Worker et Go |
| [Déploiement](docs/deployment.md) | Déploiement par fork, bouton, manuel, domaines, PostgreSQL, D1 vers PostgreSQL |
| [Backend Go](backends/go/README.md) | Options, variables d'environnement, SQLite vers PostgreSQL |
| [Utilisation](docs/usage.md) | Console, configuration des monitors, Push, page de statut, maintenance, compte et sécurité |
| [Agent](docs/agents.md) | Installation, gestion, configuration, mise à jour, désinstallation |
| [Notifications](docs/notifications.md) | Configuration des canaux, portée des groupes, journal de livraison |
| [Thèmes](docs/themes.md) | Installation, configuration, prévisualisation |
| [Configuration](docs/configuration.md) | Bindings, variables d'environnement, réglages de la console |
| [Référence de l'API](docs/api.md) | Points de terminaison, authentification, exemples |
| [Exploitation](docs/operations.md) | Sauvegarde, restauration, mise à jour, conservation des données |
| [Dépannage](docs/troubleshooting.md) | Diagnostic par symptôme |

## Licence

Uptime Polaris est publié sous [licence MIT](LICENSE).
