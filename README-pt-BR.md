<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-pt-BR-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-pt-BR-light.svg">
    <img src="assets/readme/overview-pt-BR-light.svg" width="100%" alt="Uptime Polaris: monitoramento de disponibilidade de serviços e hosts">
  </picture>
</h1>

<p align="center"><strong>Verificações HTTP/TCP, heartbeats Push, métricas de hosts</strong><br>Executa no Cloudflare Workers ou em um servidor Go auto-hospedado.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <strong>Português (Brasil)</strong> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Executado no Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Frontend em React e TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent em Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#início-rápido">Início rápido</a> ·
  <a href="#implantação-no-cloudflare">Implantação</a> · <a href="#deploy-go">Implantar Go</a> ·
  <a href="#monitoramento-de-hosts">Agent</a> ·
  <a href="#documentação">Documentação</a>
</p>

O Uptime Polaris verifica sites e portas periodicamente, recebe batimentos de tarefas agendadas, coleta métricas de CPU, memória e disco dos servidores e envia uma notificação quando um monitor muda de estado. A página de status pública e o console de administração já vêm incluídos.

## Escolha o backend

Escolha um backend por implantação. Os dois usam a mesma interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Executa em | Cloudflare | Servidor ou contêiner próprio |
| Banco de dados | D1 ou PostgreSQL | SQLite ou PostgreSQL |
| Sondas diretas | HTTP, TCP (UDP e ICMP via Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Intervalo mínimo | 60 segundos | 5 segundos |
| Arquivos de tema | R2 (opcional) | Diretório de dados |

Use o Worker quando não quiser manter um servidor. Escolha Go para sondar a rede interna, usar mais protocolos ou intervalos menores. Veja a [comparação de backends](docs/backends.md).

## Recursos

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="Ícone de verificação de serviço"><br>
  <strong>Verificações de serviço e batimentos</strong><br>
  Verificações HTTP e TCP, com checagens opcionais de resposta, certificado, expiração do domínio e DNS. Monitores Push servem para cron e scripts de backup: sem batimento dentro do prazo, o monitor é marcado como indisponível.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="Ícone de monitoramento de host"><br>
  <strong>Monitoramento de servidores</strong><br>
  O <code>polaris-agent</code> envia métricas de CPU, memória, disco, carga e rede. Ele também pode executar verificações HTTP/TCP a partir do próprio host para alcançar serviços internos.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="Ícone de notificação de status"><br>
  <strong>Página de status e notificações</strong><br>
  A página de status mostra o estado atual e o histórico de eventos, com grupos e janelas de manutenção. As notificações vão para Telegram, Feishu, Slack, Discord, Webhook, Apprise e Server酱, e cada canal pode ser limitado a grupos de monitores.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="Ícone de armazenamento e temas"><br>
  <strong>Armazenamento e temas</strong><br>
  O Worker guarda dados em D1 ou PostgreSQL e temas no R2; o Go usa SQLite ou PostgreSQL e mantém os temas no diretório de dados.
</p>

## Início rápido

1. Implante no [Cloudflare](#implantação-no-cloudflare) ou em [servidor próprio](#deploy-go).
2. Abra `/setup`. O Worker verifica vínculos e segredos primeiro; o Go pede a chave de configuração do log de inicialização.
3. Crie a conta de administrador e adicione monitores em `/admin`.

## Implantação no Cloudflare

1. Faça fork deste repositório.
2. No painel da Cloudflare, abra **Workers & Pages → Create application → GitHub** e selecione seu fork. Defina `npm run build` como comando de build e `npm run deploy` como comando de implantação.
3. Abra o site após a implantação. A página de configuração inicial verifica vínculos e segredos; configure o que ela indicar em **Settings** do Worker:
   - **D1 (opcional)**: para usar D1, adicione um banco em **Bindings** com o nome de variável `DB`. Sem D1, a configuração inicial oferece apenas PostgreSQL.
   - **Chave de configuração**: adicione o segredo `ADMIN_TOKEN` em **Variables and Secrets** com um valor aleatório longo, por exemplo a saída de `openssl rand -hex 32`.
   - **Analytics Engine (obrigatório)**: ative o Analytics Engine no painel e adicione um conjunto de dados em **Bindings** com o nome de vínculo `UPTIME`.
   - **Opcional**: para instalar temas de terceiros, adicione um bucket R2 com o nome de vínculo `THEMES`. Ele pode ser adicionado após a configuração inicial.
4. Na página de configuração inicial, selecione **Re-check**. Após a aprovação dos itens obrigatórios, configure e verifique o banco com `ADMIN_TOKEN` e crie a conta de administrador.

As atualizações usam **Sync fork** no GitHub; o Workers Builds reimplanta automaticamente e mantém os vínculos adicionados no painel.

Também é possível implantar com o botão abaixo. Ele cria um novo repositório na sua conta do GitHub (não é um fork, então não pode ser atualizado com Sync fork); configure o banco e o segredo como a página de configuração inicial indica:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

O [guia de implantação](docs/deployment.md) cobre implantação por linha de comando e PostgreSQL.

<a id="deploy-go"></a>

## Implantar o backend Go

Baixe a versão para o seu sistema em [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), renomeie para `polaris` (`polaris.exe` no Windows) e inicie:

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

O programa escuta em `127.0.0.1:8080` por padrão. Para acesso externo, altere `--addr` ou configure um proxy reverso. Todos os dados ficam em `./data`; mantenha esse diretório persistente, restrinja o acesso e faça backup periodicamente. Veja o [guia do backend Go](backends/go/README.md#install-and-start) para mais configurações.

## Monitoramento de hosts

Adicione uma máquina na página Agent do console, escolha a plataforma e o modo de instalação e execute o comando gerado na máquina de destino. A máquina precisa acessar o GitHub.

Após a instalação, gerencie o serviço com `pa` (forma curta de `polaris-agent`):

```sh
pa status
pa restart
pa logs -f
```

- Os comandos de instalação contêm o endereço do site e o token da máquina. Gere-os no domínio de produção e nunca os publique.
- Adicionar uma máquina não cria um monitor. Para acompanhar o estado online ou os limites de recursos, adicione um monitor do tipo Agent na página de monitores.
- Instalações manuais não têm gerenciador de serviços, então `pa start`, `stop` e `restart` não estão disponíveis.

Veja o [guia do Agent](docs/agents.md) para mais detalhes.

## Uso e informações públicas

A página de status é anônima. Nomes de monitores, caminhos de destino e nomes de host podem aparecer nas páginas e APIs públicas; nunca coloque endereços internos ou segredos neles. Veja [dados públicos](docs/usage.md#公开数据) e o [guia de notificações](docs/notifications.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Comparação de backends](docs/backends.md) | Diferenças entre Worker e Go |
| [Guia de implantação](docs/deployment.md) | Implantação por fork, botão e manual, domínios, PostgreSQL, migração D1 para PostgreSQL |
| [Backend Go](backends/go/README.md) | Opções de inicialização, variáveis de ambiente, migração SQLite para PostgreSQL |
| [Manual de uso](docs/usage.md) | Configuração de monitores, Push, estado e disponibilidade |
| [Guia do Agent](docs/agents.md) | Instalação, gestão, configuração, atualizações, remoção |
| [Guia de notificações](docs/notifications.md) | Configuração de canais, escopo por grupo, histórico de entregas |
| [Guia de temas](docs/themes.md) | Instalação, configuração, prévia |
| [Referência de configuração](docs/configuration.md) | Vínculos, variáveis de ambiente, configurações do console |
| [Referência da API](docs/api.md) | Endpoints, autenticação, exemplos |
| [Guia de operações](docs/operations.md) | Backup, recuperação, atualizações, retenção |
| [Solução de problemas](docs/troubleshooting.md) | Diagnóstico por sintoma |

## Licença

Este projeto usa a [licença MIT](LICENSE).
