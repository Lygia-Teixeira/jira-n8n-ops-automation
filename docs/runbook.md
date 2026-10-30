# Runbook

## Operação normal

| Ação | Como |
|---|---|
| Pausar toda a automação | Desative o workflow `Orquestrador` (o SSL é independente; desative-o também se necessário). |
| Voltar para modo seguro sem parar | `OPS_DRY_RUN=true` e reinicie o n8n. Nada é executado; decisões continuam auditadas. |
| Habilitar uma atividade | Acrescente o id em `OPS_ALLOWED_ACTIVITIES` (`ip_unblock`, `mail_quota_increase`, `mail_password_reset`). |
| Desabilitar uma atividade | Remova da allowlist. Cards dela vão para `Triagem Manual` com motivo `activity_not_allowed`. |
| Ajustar vazão | `OPS_MAX_ACTIONS_PER_RUN` (padrão 5). Excedentes ficam na coluna para o próximo ciclo. |
| Incluir aprovador | Acrescente o `accountId` em `OPS_APPROVER_ACCOUNT_IDS` e no grupo da condição de transição do Jira. |
| Incluir conta/domínio | Atualize o inventário (`OPS_INVENTORY_JSON`). Sem isso, cards e alertas da conta são recusados. |
| Rotacionar credenciais | Troque no cofre do n8n (Jira, tokens WHM, chaves SSH, tokens dos serviços). Para SSH, publique a chave nova no `authorized_keys`, valide e remova a antiga. |

Cada decisão gera um evento `ops-automation.audit.v1` com card, atividade, decisão, motivo, aprovador, servidor, comando do catálogo e argumentos validados. No servidor, o wrapper registra no syslog (`authpriv`, tag `ops-catalog`).

## Diagnóstico por sintoma

### Card não sai da coluna de automação

1. Está com o label de reivindicação? Se sim, foi reivindicado e a execução parou no meio (ver "Card reivindicado e parado").
2. Sem label: confira o evento de auditoria do card. `defer` = limite do ciclo; `dry_run` = modo seguro ligado.
3. Nenhum evento: o orquestrador não encontrou o card. Verifique status exato, projeto em `JIRA_PROJECT_KEYS` e prefixo/label de fila.

### Card reivindicado e parado

O label é aplicado antes da execução, então o card não volta a ser processado sozinho (proteção contra execução dupla).

1. Veja a auditoria e o syslog do servidor (`journalctl -t ops-catalog`) para saber se a operação rodou.
2. Se rodou: comente o resultado manualmente e mova o card.
3. Se não rodou e deve ser refeito: remova o label e mantenha o card na coluna.

### Card foi para `Triagem Manual`

O comentário traz o motivo. Os mais comuns:

| Motivo | Ação |
|---|---|
| `not_approved` | Card movido por quem não é aprovador, ou aprovador é o autor. Um aprovador deve movê-lo de novo. |
| `client_not_found` / `client_ambiguous` | Corrigir o campo `Cliente` ou o inventário. |
| `ip_invalid` | IP malformado, com texto extra ou privado/reservado. Confirmar com o solicitante. |
| `email_domain_not_owned` | O domínio do e-mail não é da conta informada. Possível erro ou tentativa de abuso: confirmar. |
| `no_contact` | Cadastrar o contato responsável da conta no inventário antes de redefinir senha. |
| `secret_delivery_failed` | A senha foi trocada, mas o link não foi gerado. Refaça a redefinição pelo procedimento manual e entregue por canal seguro; a senha gerada pela automação não fica registrada em lugar nenhum. |
| `whm_call_failed` | Token WHM inválido/expirado, conta inexistente ou porta 2087 bloqueada. |
| `ssh_failed` / `no_result_line` | Chave recusada, `from=` não bate com o IP do n8n, ou wrapper ausente. Teste o SSH manual (ver importação). |
| `still_denied` | O IP continua no `csf.deny` (ex.: linha com comentário ou faixa). Tratar manualmente no CSF. |
| `quota_at_limit` | Cota já está no teto `QUOTA_MAX_MB`. Decisão humana. |

### Falhas do Jira

- **401/403**: token da conta de serviço expirado ou sem permissão. Renove no cofre do n8n. A busca falha antes de qualquer execução.
- **Comentário falhou após execução**: a execução para com erro; o card fica reivindicado. Siga "Card reivindicado e parado".
- **Transição não encontrada**: o fluxo do Jira não tem transição do status atual para o destino; evento de auditoria marca `transition_not_found`. Ajuste o workflow do Jira ou mova à mão.

### SSL

| Mensagem no Teams | Ação |
|---|---|
| Certificado renovado | Nenhuma. |
| Ação manual necessária (validação DNS) | Criar o TXT de validação no DNS ou tirar o wildcard do escopo do AutoSSL. Retry automático não resolve. |
| Falha na renovação | Já houve retry. Verificar porta 80, docroot, redirecionamentos e firewall; rodar `ops-catalog ssl-autossl <usuario> <dominio>` no servidor. |
| Alerta não processado (`domain_not_in_inventory`, `invalid_domain`) | Incluir o domínio no inventário ou corrigir o monitor no Kuma. |

Alertas repetidos do mesmo domínio dentro de `SSL_DEDUP_HOURS` são ignorados de propósito.

### Suspeita de abuso

1. Desative o orquestrador.
2. Exporte os eventos de auditoria e o syslog `ops-catalog` do período.
3. Revise cards recusados por `ip_invalid`, `email_domain_not_owned` e `not_approved`: são os sinais típicos de tentativa.
4. Rotacione as credenciais da automação se houver qualquer indício de acesso ao n8n.
