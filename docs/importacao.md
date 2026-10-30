# Como importar e configurar

Ordem recomendada: servidores → n8n (variáveis e credenciais) → workflows → Jira → Kuma → homologação em dry-run.

## 1. Servidores (cada `srv-0N`)

```bash
# usuário sem senha válida; o shell é irrelevante com forced command, mas não precisa ser útil
useradd --create-home --shell /bin/bash opsbot
passwd -l opsbot

install -o root -g root -m 0750 server/ops-catalog.sh /usr/local/sbin/ops-catalog
install -o root -g root -m 0440 server/sudoers-ops-catalog.example /etc/sudoers.d/ops-catalog
visudo -cf /etc/sudoers.d/ops-catalog
install -o root -g root -m 0600 server/ops-catalog.conf.example /etc/ops-catalog.conf

install -d -o opsbot -g opsbot -m 0700 /home/opsbot/.ssh
# cole a chave pública do n8n no formato de server/authorized_keys.example
install -o opsbot -g opsbot -m 0600 authorized_keys /home/opsbot/.ssh/authorized_keys
```

Teste manual, a partir da máquina do n8n:

```bash
ssh -i n8n_ops_ed25519 opsbot@srv-01.example.com 'ip-unblock 192.0.2.10'
# esperado: {"ok":false,"error":"ip_invalid"}   (faixa de documentação é recusada)
ssh -i n8n_ops_ed25519 opsbot@srv-01.example.com 'id; whoami'
# esperado: {"ok":false,"error":"unsafe_characters"}
```

Libere no firewall do servidor apenas o IP de saída do n8n na porta SSH e, para a redefinição de senha, na porta 2087 do WHM. Crie um token de API do WHM dedicado à automação (WHM → Manage API Tokens), com as ACLs mínimas necessárias para chamar `uapi_cpanel` nas contas — valide em homologação.

> Os nomes de funções de WHM/cPanel usados no wrapper (`autossl_check`, `get_autossl_problems_for_user`, `Email get_pop_quota`/`edit_pop_quota`) devem ser conferidos na documentação da sua versão antes de produção.

## 2. n8n: variáveis de ambiente

Copie `.env.example` para o `.env` do container/serviço do n8n (chmod 600) e ajuste. Pontos obrigatórios:

- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` — os nós leem configuração por `$env`.
- `NODE_FUNCTION_ALLOW_BUILTIN=crypto` — o gerador de senha usa `crypto.randomInt`.
- `OPS_DRY_RUN=true` até o fim da homologação.
- `OPS_APPROVER_ACCOUNT_IDS` e `OPS_ALLOWED_ACTIVITIES` — vazios, nada executa.
- `OPS_INVENTORY_JSON` — uma linha com o conteúdo de `config/inventory.example.json` adaptado. Para frotas grandes, troque por uma consulta a um serviço de inventário interno.

## 3. n8n: credenciais (nomes exatos usados nos workflows)

| Nome | Tipo no n8n | Uso | Observação |
|---|---|---|---|
| `Jira API` | Jira SW Cloud API | buscar, comentar, rotular, transicionar | Conta de serviço com permissão só nos projetos da automação. Em **Allowed domains**, restrinja a `example.atlassian.net`. |
| `SSH srv-01`, `SSH srv-02` | SSH Private Key | catálogo via forced command | Usuário `opsbot`, chave ed25519 dedicada, sem passphrase compartilhada com outros sistemas. |
| `WHM API srv-01`, `WHM API srv-02` | Header Auth | `passwd_pop` | Header `Authorization`, valor `whm <usuario>:<token>`. |
| `Secret Delivery API` | Header Auth | gerar link de uso único | Serviço próprio (ex.: Vaultwarden Send, Yopass, PrivateBin com API) que envia o link ao destinatário. Contrato abaixo. |
| `Audit Sink` | Header Auth | eventos de auditoria | Ex.: endpoint de ingestão do SIEM ou do Loki via gateway. |
| `Uptime Kuma Webhook` | Header Auth | autenticar o webhook de entrada | Ex.: header `X-Webhook-Token` com valor longo e aleatório. |
| `News Publisher API` | Header Auth | stub de notícias | |

Contrato esperado do serviço de entrega de segredo:

```http
POST $SECRET_DELIVERY_URL
{ "recipient": "contato-a@example.com", "subject": "...", "secret": "...",
  "ttlHours": 24, "maxViews": 1, "reference": "OPS-101" }

200 { "ok": true, "id": "<id opaco>" }
```

O serviço guarda o segredo cifrado, envia ao destinatário um link que expira após uma visualização ou `ttlHours`, e nunca devolve o segredo na resposta.

## 4. Importar os workflows

1. *Workflows → Import from file*, nesta ordem: `02-infra-ops.json`, `04-noticias-stub.json`, `03-ssl-autossl.json`, `01-orquestrador.json`.
2. Em cada nó com credencial, selecione a credencial de mesmo nome (o JSON referencia só o nome).
3. Copie os IDs dos subworkflows de infra e notícias para `WF_INFRA_ID` e `WF_NEWS_ID` e reinicie o n8n.
4. Para mais servidores, adicione saídas nos Switch `Servidor SSH`, `Servidor WHM` e `Servidor` e duplique os nós correspondentes com as credenciais do novo servidor.
5. Se alterar a lógica, edite `src/`, rode `npm run build` e reimporte; `npm run check` acusa divergência.

## 5. Jira

- Crie os status `Selecionado para Automação`, `Conferir e Avisar` e `Triagem Manual` (ou ajuste as variáveis).
- **Restrinja a transição para `Selecionado para Automação`** a um grupo de aprovadores (condição de workflow do Jira). A verificação de changelog no n8n é a segunda camada.
- Publique um template de descrição com os campos `Cliente`, `IP`, `E-mail` e, opcionalmente, `Atividade`.
- Crie a conta de serviço do bot e use o `accountId` em `JIRA_BOT_ACCOUNT_ID`.

## 6. Uptime Kuma

1. *Settings → Notifications*: inclua `5` em *TLS Certificate Expiry* (dias de antecedência).
2. Em cada monitor HTTPS: marque a notificação de certificado expirando.
3. Adicione uma notificação do tipo **Webhook** apontando para a URL de produção do nó `Webhook Uptime Kuma`, com o header de autenticação configurado em *Additional Headers*.

## 7. Homologação

1. `OPS_DRY_RUN=true`, `OPS_ALLOWED_ACTIVITIES=ip_unblock`.
2. Crie cards de teste: válido, sem aprovação, com IP privado, com injeção (`IP: 192.0.2.1; id`), cliente inexistente.
3. Confira no coletor de auditoria as decisões (`dry_run`, `reject` com motivo).
4. Rode o wrapper manualmente no servidor de homologação para cada operação.
5. Só então `OPS_DRY_RUN=false`, uma atividade por vez na allowlist.
