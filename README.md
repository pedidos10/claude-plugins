<p align="center">
  <img src="assets/dev10.png" width="220" alt="dev10">
</p>

<h1 align="center">Plugins do Claude Code</h1>

<p align="center">Os plugins da dev10 para o Claude Code.</p>

## megabrain

Trabalhe um card do ClickUp do link à branch provada no sistema rodando.

### Instalar

```
/plugin marketplace add pedidos10/claude-plugins
/plugin install megabrain@dev10
```

Depois `/reload-plugins`. Num projeto novo, rode `/megabrain:init` uma vez.

### Comandos

| Comando | O que faz |
| --- | --- |
| `/megabrain:card <link do card>` | Checkpoint "nas minhas palavras", playbook, implementação, prova dirigindo as superfícies e link de criação do PR. |
| `/megabrain:bug` · `:feature` · `:prototype` · `:multi-pr` · `:map` `<texto livre>` | O mesmo método do `card`, com o playbook escolhido no comando e a entrada em texto livre: sem card. |
| `/megabrain:why <pergunta>` | Por que isso é assim: investiga git, PRs, cards, docs e chat em paralelo e separa fato citado de inferência. Não muda código. |
| `/megabrain:how <pergunta>` | Como isso funciona: o fluxo de ponta a ponta, onde cada coisa mora e o que é fácil errar. Não muda código. |
| `/megabrain:teach <pergunta>` | Explica para você entender e confiar, juntando o `how` e o `why`. Serve também para "por que você fez assim e não X?". |
| `/megabrain:init` | Prepara o projeto: `.megabrain/config.json` e a base vazia. |
| `/megabrain:tech-decisions <link do card>` | Spec de card médio ou grande, escrita pelo dev que vai implementar: fecha as regras duvidosas e as decisões técnicas, anexa o documento ao card e move para AGUARD \| ANÁLISE TÉCNICA. Card pequeno vai direto para o `card`. |
| `/megabrain:help` | Os comandos, os playbooks e os scripts; num projeto com `.megabrain/`, também as superfícies e os comandos de cada uma. |

### Onde fica cada coisa

O método e as ferramentas (`scripts/boot.mjs`, `scripts/control.mjs`, `scripts/blast-radius.mjs`) ficam
neste plugin. Cada projeto guarda a config e o conhecimento em `<repo>/.megabrain/`.

### Atualizar

No terminal (dentro da sessão, `/plugin update` só abre a lista de plugins):

```
claude plugin marketplace update dev10
claude plugin update megabrain@dev10
```

Depois abra uma sessão nova (ou rode `/reload-plugins`).
