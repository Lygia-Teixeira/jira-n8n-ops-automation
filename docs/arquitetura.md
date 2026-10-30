# Arquitetura

## Visão geral

```mermaid
flowchart LR
    subgraph JIRA["Jira Cloud (example.atlassian.net)"]
        C["Card na coluna<br/>Selecionado para Automação"]
    end

    subgraph N8N["n8n"]
        O["01 Orquestrador<br/>agenda + JQL + filas"]
        I["02 Infra<br/>planejar → executar → registrar"]
        N["04 Notícias (stub)"]
        S["03 SSL AutoSSL"]
        V[("Cofre de credenciais<br/>do n8n")]
    end

    subgraph SRV["srv-01 / srv-02 (cPanel/WHM)"]
        W["ops-catalog<br/>(forced command, sudo)"]
        WHM["WHM API :2087"]
    end

    K["Uptime Kuma"] -- "webhook com header de autenticação<br/>(5 dias antes do vencimento)" --> S
    O -- "REST v3 (search/jql)" --> C
    O --> I
    O --> N
    I -- "SSH chave dedicada<br/>linha do catálogo" --> W
    I -- "HTTPS form POST<br/>passwd_pop" --> WHM
    I -- "segredo + destinatário<br/>do inventário" --> SD["Serviço de entrega<br/>de segredo (link único)"]
    I -- "evento JSON" --> AU["Coletor de auditoria"]
    I -- "comentário + transição" --> C
    S -- "SSH: ssl-autossl" --> W
    S -- "Adaptive Card" --> T["Teams (webhook)"]
    N -- "payload mínimo<br/>Idempotency-Key" --> NP["Serviço de publicação"]
    V -.-> I
    V -.-> S
    V -.-> O
```

## Componentes

| Componente | Papel | Onde está |
|---|---|---|
| Orquestrador | A cada 15 min (dias úteis, horário comercial) busca cards na coluna de automação, sem o label de reivindicação, e separa em filas `infra` e `noticia`. | `workflows/01-orquestrador.json` |
| Infra | Planeja (classifica, valida, verifica aprovação e allowlist, aplica limite por ciclo), reivindica o card, executa via catálogo, comenta, move e audita. | `workflows/02-infra-ops.json` |
| SSL AutoSSL | Recebe alerta do Uptime Kuma, resolve domínio → conta → servidor pelo inventário, dispara AutoSSL via catálogo, classifica e notifica no Teams. | `workflows/03-ssl-autossl.json` |
| Notícias | Stub: monta payload mínimo e entrega a um serviço externo idempotente. | `workflows/04-noticias-stub.json` |
| Lógica dos nós Code | Módulos JS puros, testados com `node:test` e embutidos nos nós pelo build. | `src/`, `scripts/build-workflows.js` |
| Wrapper de servidor | Único ponto de entrada da automação no servidor. Revalida tudo e só executa operações do catálogo. | `server/ops-catalog.sh` |
| Inventário | Fonte da verdade: contas, servidor, domínios, contato responsável. | `OPS_INVENTORY_JSON` (`config/inventory.example.json`) |

## Fronteiras de confiança

```mermaid
flowchart TB
    subgraph U["Não confiável"]
        A["Texto do card<br/>(título, descrição, anexos)"]
        B["Payload do webhook do Kuma"]
        C2["stdout/stderr dos servidores<br/>e respostas de API"]
    end
    subgraph P["Validação (src/)"]
        V1["validators.js<br/>IP público, e-mail, usuário, hostname, chave"]
        V2["inventory.js<br/>conta existe? domínio é dela? servidor?"]
        V3["approval.js<br/>quem moveu o card é aprovador?"]
        V4["catalog.js<br/>comando do catálogo + charset seguro"]
    end
    subgraph X["Execução privilegiada"]
        E["ops-catalog (root)<br/>revalida e executa"]
    end
    A --> V3 --> V1 --> V2 --> V4 --> E
    B --> V1
    C2 --> R["result.js<br/>só uma linha JSON com códigos fixos"]
```

Princípios:

1. **Dado do card nunca é código.** Todo valor passa por validador estrito e vira argumento de uma entrada fixa do catálogo. Não existe nó que monte shell a partir de texto.
2. **O inventário decide, o card só pede.** Servidor, dono do domínio e destinatário de senha vêm do inventário, nunca do texto.
3. **Quem cria card não autoriza execução.** A automação confere no changelog quem moveu o card para a coluna de automação.
4. **Falhar fechado.** Sem aprovadores configurados, sem allowlist ou com qualquer ambiguidade, o card vai para triagem manual.
5. **Menor privilégio por canal.** SSH com chave dedicada, `restrict` + `command=` + `from=`, usuário sem shell útil; WHM com token dedicado por servidor; credenciais Jira só da conta de serviço.
6. **Nada sensível em histórico.** O workflow de infra não salva dados de execução, comentários não trazem segredos nem saída bruta, auditoria tem verificação de campos proibidos.

## Por que o código dos nós é gerado

Os nós Code do n8n não importam módulos locais. Em vez de duplicar a lógica no JSON, `scripts/build-workflows.js` concatena os módulos de `src/` necessários a cada nó e acrescenta uma cola curta. Assim:

- o que roda no n8n é exatamente o que foi testado;
- `npm run check` falha se alguém editar `src/` e esquecer de regenerar `workflows/`;
- os testes executam o código de nós reais num sandbox (`vm`) com `$input`/`$env` simulados.
