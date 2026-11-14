<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-pt-BR-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-pt-BR-light.svg">
  <img src="assets/readme/overview-pt-BR-light.svg" width="100%" alt="Uptime Polaris: monitoramento de disponibilidade de serviços e hosts">
</picture>

<a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <strong>Português (Brasil)</strong> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - página de status e monitoramento auto-hospedados

O Uptime Polaris verifica sites, portas e tarefas agendadas periodicamente, coleta métricas dos servidores e envia uma notificação quando um status muda.<br>
Roda no Cloudflare Workers, sem servidor para manter, ou como backend Go na sua própria máquina.<br>
Inclui uma página de status pública e um console de administração; a interface está traduzida em 9 idiomas.

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Executado no Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Frontend em React e TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent em Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#recursos">Recursos</a> · <a href="#implantação">Implantação</a> · <a href="#início-rápido">Início rápido</a> · <a href="#monitoramento-de-hosts">Agent</a> · <a href="#dados-e-escopo-público">Escopo público</a> · <a href="#perguntas-frequentes">Perguntas frequentes</a> · <a href="#documentação">Documentação</a></p>

</div>

## Por que usar o Uptime Polaris

- **Nenhum servidor para manter**: implantado no Cloudflare Workers, as verificações, as notificações e a página de status rodam lá. Use o backend Go quando precisar sondar uma rede interna ou verificar com mais frequência; os dois usam a mesma interface.
- **Status a partir de resultados reais**: a página mostra apenas o que uma verificação ou um relatório realmente produziu. Dados ausentes aparecem como pendentes, nunca como saudáveis.
- **Tarefas agendadas incluídas**: scripts de backup e tarefas cron enviam um heartbeat no horário, e um heartbeat ausente é reportado como falha.
- **Métricas de servidor**: o `polaris-agent` reporta CPU, memória, disco, carga e rede, e também pode verificar serviços internos a partir da máquina que tem acesso a eles.
- **Duas páginas públicas**: a página de status dos monitores e a das máquinas são separadas e podem ter domínios próprios. Durante a manutenção, ambas mudam para a página de manutenção.
- **Notificações por grupo**: Telegram, Feishu, Slack, Discord, Webhook, Apprise e ServerChan, cada canal limitado aos grupos que deve cobrir.
- **Escolha de banco**: D1 ou PostgreSQL no Worker, SQLite ou PostgreSQL no Go, e os dados existentes podem ser migrados para PostgreSQL.

## Recursos

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> Verificações e heartbeats

- Verificações HTTP conferem o código de status, campos JSON, cabeçalhos de resposta e tempo de resposta. Verificações TCP conferem se a porta abre, e podem enviar conteúdo e comparar a resposta.
- O backend Go também verifica diretamente UDP, ICMP, DNS, TLS e WebSocket. No Worker, as verificações UDP e ICMP passam por um Agent.
- Verificações adicionais cobrem a validade do certificado SSL, a validade do domínio e registros DNS.
- Monitores Push recebem uma URL dedicada; uma tarefa agendada envia um POST para ela e um POST ausente é reportado como falha.
- O intervalo mínimo é de 60 segundos no Worker e 5 segundos no Go. Quando um alvo só é acessível em uma rede interna, escolha um Agent como origem da verificação.

Os tipos de monitor e todos os campos estão no [guia de uso](docs/usage.md).

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> Monitoramento de servidores

- O `polaris-agent` reporta CPU, memória, disco, carga, rede e pontos de montagem no Linux, macOS e Windows; o Docker é suportado no Linux.
- As regras de recurso usam um limite e uma duração, então só leituras sustentadas geram alerta. A recuperação é uma porcentagem do limite, o que estabiliza leituras que oscilam perto dele.
- A página de status das máquinas é opcional, com busca, filtros, visão de mapa e comparação de 2 a 4 máquinas. Fica desligada por padrão e as máquinas permanecem visíveis apenas para a administração até serem publicadas.

Instalação, gerenciamento e atualizações estão no [guia do Agent](docs/agents.md).

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> Páginas de status e notificações

- A página de status mostra o estado atual, a disponibilidade e o histórico de eventos, agrupados como você quiser, com apenas os monitores marcados como públicos.
- As janelas de manutenção podem ser únicas ou semanais. Um aviso aparece no topo da página antes da janela, e as notificações automáticas ficam suspensas durante ela.
- Cada canal tem seu próprio idioma de mensagem e escopo de grupos. O console mantém um registro de entregas que separa envios bem-sucedidos, recusas do provedor e tempos esgotados de rede.

A configuração dos canais e o escopo dos grupos estão no [guia de notificações](docs/notifications.md).

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> Armazenamento e temas

- D1 ou PostgreSQL no Worker, SQLite ou PostgreSQL no Go; os dados de D1 e SQLite podem ser migrados para PostgreSQL.
- Temas de terceiros são instalados nas páginas públicas por upload de ZIP ou URL de download, e podem ser visualizados antes de aplicar. Os temas ficam no R2 no Worker e no diretório de dados no Go.
- Sem um tema, o design integrado é usado. O console de administração sempre usa a interface integrada.

Instalar e criar temas está no [guia de temas](docs/themes.md).

### Mais

- **Paleta de comandos**: pressione `Ctrl+K` (ou `⌘K` no macOS) no console para buscar páginas, monitores e Agents.
- **Popover de status**: o cabeçalho do console resume monitores com falha e Agents offline, com pausar, verificar agora e copiar resumo.
- **API**: os endpoints de administração aceitam um token Bearer, então monitores podem ser criados e gerenciados por scripts. Veja a [referência da API](docs/api.md).
- **Idiomas da interface**: chinês simplificado, chinês tradicional (Taiwan, Hong Kong), inglês, japonês, coreano, francês, português e russo.

## Implantação

Escolha um backend por implantação; os dois usam a mesma interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Executa em | Cloudflare | Seu servidor ou um contêiner |
| Banco de dados | D1 ou PostgreSQL | SQLite ou PostgreSQL |
| Verificações diretas | HTTP, TCP (UDP e ICMP exigem um Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Intervalo mínimo | 60 segundos | 5 segundos |
| Arquivos de tema | R2 (opcional) | Diretório de dados |

Escolha o Worker se preferir não manter um servidor. Escolha o Go quando precisar sondar serviços internos, usar mais protocolos ou verificar com mais frequência. A [comparação de backends](docs/backends.md) traz os detalhes.

### Implantação no Cloudflare

1. Faça um fork deste repositório.
2. No painel da Cloudflare, abra **Workers & Pages → Create application → GitHub** e selecione seu fork. Use `npm run build` como comando de build e `npm run deploy` como comando de implantação.
3. Abra o site quando a implantação terminar. A página de configuração verifica primeiro os bindings e os secrets. Configure o seguinte nas **Settings** do Worker, conforme a página indica:
   - **D1 (opcional)**: para usar D1, adicione um banco em **Bindings** com o nome de variável `DB`. Sem D1, a configuração inicial oferece apenas PostgreSQL.
   - **KV (obrigatório para informar PostgreSQL na página)**: adicione um namespace KV em **Bindings** com o nome de variável `CONFIG` para criptografar as URLs de conexão. Opcional ao usar apenas D1 ou um `DATABASE_URL` definido na implantação.
   - **Chave de configuração**: adicione um secret `ADMIN_TOKEN` em **Variables and Secrets**, com um valor aleatório longo, como a saída de `openssl rand -hex 32`.
   - **Analytics Engine (obrigatório)**: ative o Analytics Engine no painel e adicione o conjunto de dados em **Bindings** com o nome de variável `UPTIME`.
   - **R2 (opcional)**: necessário para temas de terceiros. Adicione um bucket em **Bindings** com o nome de variável `THEMES`, ou adicione depois da configuração.
4. Na página de configuração inicial, selecione **Re-check**. Após a aprovação dos itens obrigatórios, configure e verifique o banco com `ADMIN_TOKEN` e crie a conta de administrador.

Também há um botão de implantação. Ele cria um repositório novo na sua conta do GitHub, e não um fork, então o Sync fork não conseguirá atualizá-lo depois. O banco e os secrets são configurados da mesma forma pela página de configuração:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

Para implantações por linha de comando e PostgreSQL, veja o [guia de implantação](docs/deployment.md).

<a id="deploy-go"></a>

### Implantação do backend Go

Baixe a compilação para seu sistema e arquitetura em [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), renomeie para `polaris` (`polaris.exe` no Windows) e inicie:

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

Ele escuta em `127.0.0.1:8080` por padrão; altere `--addr` ou coloque um proxy reverso na frente para expô-lo. Todos os dados ficam em `./data`, que precisa de armazenamento persistente, permissões restritas e backups regulares. Opções e variáveis de ambiente estão no [guia do backend Go](backends/go/README.md#install-and-start).

## Início rápido

1. Abra `/setup` no seu site. O Worker verifica primeiro bindings e secrets, depois pede `ADMIN_TOKEN`; o Go pede a chave de configuração exibida no log de inicialização. Crie a conta de administrador.
2. Vá para `/admin` e adicione um monitor em **Monitors**. Por exemplo, escolha HTTP, informe `https://example.com/health`, salve e selecione "Verificar agora".
3. Adicione um canal em **Notifications** e envie uma mensagem de teste.
4. Abra a raiz do site em uma janela anônima e confirme o que a página de status mostra.

No primeiro acesso, a visão geral mostra uma lista de primeiros passos: adicionar um monitor, nomear o site, configurar notificações, conectar um Agent.

## Monitoramento de hosts

Adicione uma máquina em **Agent management** no console, escolha a plataforma e o método de instalação, e execute o comando gerado na máquina de destino. A máquina precisa acessar o GitHub.

Depois de instalar, gerencie o serviço com `pa` (abreviação de `polaris-agent`):

```sh
pa status
pa restart
pa logs -f
```

- O comando de instalação contém a URL do site e o token dessa máquina. Gere-o no seu domínio real e não o exponha.
- Adicionar uma máquina não cria um monitor. Adicione um monitor do tipo **Agent host** em **Monitors**.
- O modo de instalação manual não tem gerenciador de serviço, então `pa start`, `stop` e `restart` não estão disponíveis.

Os modos de instalação e as diferenças entre plataformas estão no [guia do Agent](docs/agents.md).

## Atualização e desinstalação

### Atualização

Faça backup do banco primeiro; o procedimento completo está no [guia de operações](docs/operations.md#upgrade).

- **Cloudflare**: em um fork, selecione Sync fork no GitHub e o Workers Builds reimplanta automaticamente, mantendo os bindings adicionados no painel. Uma instalação pelo botão precisa que a nova versão seja mesclada no repositório gerado.
- **Go**: pare o serviço e faça backup do diretório de dados, substitua o binário e inicie com o mesmo diretório de dados.
- **Agent**: execute `pa update` na máquina. Instalações gerenciadas também podem ativar atualizações automáticas no console; isso fica desligado por padrão.

### Desinstalação

- **Cloudflare**: exclua o Worker no painel. O banco D1, o bucket R2 e o banco PostgreSQL não são excluídos com ele; remova-os separadamente se não precisar mais deles.
- **Go**: pare o serviço, depois exclua o binário e o diretório de dados. Se usar PostgreSQL, exclua esse banco também.
- **Agent**: baixe o script de instalação do seu site e execute o desinstalador:

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Para Windows, veja o [guia do Agent](docs/agents.md#update-rollback-and-uninstall). Desinstalar um Agent não remove seus monitores do console.

## Dados e escopo público

- Os dados ficam na sua própria implantação: D1 na sua conta Cloudflare ou seu PostgreSQL para o Worker, SQLite no diretório de dados ou seu PostgreSQL para o Go.
- A página de status e a API pública não exigem login. Nomes de monitores, o host e o caminho de alvos HTTP, e o host e a porta de alvos TCP são públicos, então não coloque endereços internos nem secrets neles.
- Nomes de usuário, senhas e strings de consulta dos alvos HTTP são removidos; credenciais e tokens de Agent nunca são expostos.
- O token de uma URL Push é a credencial de reporte desse monitor. Mantenha-o privado.
- Para um monitor que não deve ser público, selecione "Ocultar da página de status" na lista de monitores e ele fica restrito à administração.
- A verificação SSL do Worker consulta os logs públicos de transparência de certificados, e o Agent consulta a região do IP público da máquina na inicialização e acessa o GitHub nas atualizações.

Os campos retornados pelas páginas públicas e pela API estão em [dados públicos](docs/usage.md).

## Perguntas frequentes

**A página de configuração para na verificação de implantação e não continua.**
Configure os itens obrigatórios `ADMIN_TOKEN` e `UPTIME` nas **Settings** do Worker, salve e implante, depois verifique novamente. D1 e R2 são opcionais; sem D1, configure a conexão PostgreSQL na próxima etapa.

**Abrir uma URL Push no navegador não traz dados.**
O navegador envia GET e o Push aceita apenas POST, então GET retorna 405. Use `curl -X POST` ou envie o POST a partir da tarefa agendada.

**Um teste de notificação funciona, mas as falhas reais não geram nada.**
Verifique se o canal está ativo, se o escopo de grupos inclui o monitor e se não há janela de manutenção aberta. Um canal sem grupos selecionados recebe todos os monitores.

**Um Agent aparece offline.**
Execute `pa status` e `pa logs -f` na máquina e confirme que o serviço está rodando e alcança o domínio do site. Os relatórios saem a cada 60 segundos por padrão, e cerca de 3 minutos sem um deles marcam a máquina como offline.

Mais casos estão na [solução de problemas](docs/troubleshooting.md). Se um problema persistir, abra uma [issue](https://github.com/XingLingQAQ/UptimePolaris/issues).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Opções de backend](docs/backends.md) | Diferenças entre o Worker e o Go |
| [Implantação](docs/deployment.md) | Implantação por fork, botão, manual, domínios, PostgreSQL, D1 para PostgreSQL |
| [Backend Go](backends/go/README.md) | Opções, variáveis de ambiente, SQLite para PostgreSQL |
| [Uso](docs/usage.md) | Console, configuração de monitores, Push, página de status, janelas de manutenção, conta e segurança |
| [Agent](docs/agents.md) | Instalação, gerenciamento, configuração, atualização, desinstalação |
| [Notificações](docs/notifications.md) | Configuração de canais, escopo de grupos, registro de entregas |
| [Temas](docs/themes.md) | Instalação, configuração, visualização |
| [Configuração](docs/configuration.md) | Bindings, variáveis de ambiente, ajustes do console |
| [Referência da API](docs/api.md) | Endpoints, autenticação, exemplos |
| [Operações](docs/operations.md) | Backup, restauração, atualização, retenção de dados |
| [Solução de problemas](docs/troubleshooting.md) | Diagnóstico por sintoma |

## Licença

O Uptime Polaris é distribuído sob a [licença MIT](LICENSE).
