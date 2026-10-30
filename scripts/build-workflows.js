#!/usr/bin/env node
'use strict';
// Gera workflows/*.json a partir das definições abaixo e dos módulos de src/.
// O código dos nós Code é o mesmo código testado em test/: cada nó recebe
// o "bundle" dos módulos de que precisa + uma cola curta específica do nó.
//
//   node scripts/build-workflows.js          # (re)gera os arquivos
//   node scripts/build-workflows.js --check  # falha se os arquivos estiverem desatualizados

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'workflows');

// ---------------------------------------------------------------------------
// Bundle de módulos para nós Code
// ---------------------------------------------------------------------------
const REL_REQUIRE_RE = /^const \{[^}]*\} = require\('\.\/([a-z-]+)'\);\s*$/gm;

function readModule(name) {
  return fs.readFileSync(path.join(SRC, name + '.js'), 'utf8').replace(/\r\n/g, '\n');
}

function moduleDeps(name) {
  const deps = [];
  for (const m of readModule(name).matchAll(REL_REQUIRE_RE)) deps.push(m[1]);
  return deps;
}

function resolveOrder(names) {
  const order = [];
  const visit = (n, stack) => {
    if (order.includes(n)) return;
    if (stack.includes(n)) throw new Error('dependência circular: ' + [...stack, n].join(' -> '));
    moduleDeps(n).forEach((d) => visit(d, [...stack, n]));
    order.push(n);
  };
  names.forEach((n) => visit(n, []));
  return order;
}

function stripModule(source) {
  return source
    .replace(/^'use strict';\s*\n/m, '')
    .replace(REL_REQUIRE_RE, '')
    .replace(/^module\.exports = \{[\s\S]*?\};\s*$/m, '')
    .trim();
}

function bundle(names) {
  return resolveOrder(names)
    .map((n) => '// ---- src/' + n + '.js ----\n' + stripModule(readModule(n)))
    .join('\n\n');
}

const HEADER = '// Gerado por scripts/build-workflows.js a partir de src/. Edite o módulo, não este nó.\n';

// ---------------------------------------------------------------------------
// Helpers de nós
// ---------------------------------------------------------------------------
let seq = 0;
function nid(prefix) {
  seq += 1;
  return prefix + '-' + String(seq).padStart(2, '0');
}

function node(prefix, name, type, typeVersion, position, parameters, extra) {
  return { parameters, id: nid(prefix), name, type, typeVersion, position, ...(extra || {}) };
}

function codeNode(prefix, name, position, modules, glue, perItem) {
  const params = {};
  if (perItem) params.mode = 'runOnceForEachItem';
  params.jsCode = HEADER + (modules.length ? bundle(modules) + '\n\n// ---- cola do nó ----\n' : '') + glue.trim() + '\n';
  return node(prefix, name, 'n8n-nodes-base.code', 2, position, params);
}

const JIRA_CRED = { jiraSoftwareCloudApi: { name: 'Jira API' } };

function jiraHttp(prefix, name, position, method, url, jsonBody) {
  const p = {
    method,
    url,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'jiraSoftwareCloudApi',
  };
  if (jsonBody) Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody });
  p.options = { timeout: 30000 };
  return node(prefix, name, 'n8n-nodes-base.httpRequest', 4.2, position, p, { credentials: JIRA_CRED });
}

function headerAuthHttp(prefix, name, position, credName, url, jsonBody, extra) {
  const p = {
    method: 'POST',
    url,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    options: { timeout: 30000 },
  };
  return node(prefix, name, 'n8n-nodes-base.httpRequest', 4.2, position, p, {
    credentials: { httpHeaderAuth: { name: credName } },
    ...(extra || {}),
  });
}

function rule(leftValue, rightValue, outputKey) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey,
  };
}

function switchNode(prefix, name, position, rules) {
  return node(prefix, name, 'n8n-nodes-base.switch', 3, position, { mode: 'rules', rules: { values: rules }, options: {} });
}

function ifTrue(prefix, name, position, leftValue) {
  return node(prefix, name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ leftValue, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  });
}

function sshNode(prefix, name, position, credName, command) {
  return node(prefix, name, 'n8n-nodes-base.ssh', 1, position, {
    resource: 'command',
    operation: 'execute',
    authentication: 'privateKey',
    command,
    cwd: '/',
  }, {
    credentials: { sshPrivateKey: { name: credName } },
    onError: 'continueRegularOutput',
  });
}

/** { 'A': [['B'], ['C', 'D']] } -> formato de conexões do n8n */
function connect(map) {
  const out = {};
  for (const [from, outputs] of Object.entries(map)) {
    out[from] = { main: outputs.map((targets) => targets.map((t) => ({ node: t, type: 'main', index: 0 }))) };
  }
  return out;
}

function workflow(name, nodes, connections, settings) {
  return {
    name,
    nodes,
    connections: connect(connections),
    active: false,
    settings: { executionOrder: 'v1', ...(settings || {}) },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

const ENV_JIRA = "{{ $env.JIRA_BASE_URL }}";
const P = "$('Planejar ações').item.json";

// ---------------------------------------------------------------------------
// 01 - Orquestrador
// ---------------------------------------------------------------------------
function buildOrchestrator() {
  seq = 0;
  const nodes = [
    node('orq', 'Agendamento', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
      rule: { interval: [{ field: 'cronExpression', expression: '*/15 8-18 * * 1-5' }] },
    }),
    codeNode('orq', 'Montar consulta Jira', [220, 300], ['config', 'jira'], `
const cfg = readConfig($env);
return [{ json: { searchBody: buildSearchRequest(cfg) } }];
`),
    jiraHttp('orq', 'Jira — Buscar cards', [440, 300], 'POST',
      '=' + ENV_JIRA + '/rest/api/3/search/jql',
      '={{ JSON.stringify($json.searchBody) }}'),
    codeNode('orq', 'Separar por fila', [660, 300], ['config', 'news'], `
const cfg = readConfig($env);
const issues = $input.first().json.issues || [];
return routeIssues(issues, cfg).map((r) => ({ json: r }));
`),
    switchNode('orq', 'Fila', [880, 300], [
      rule('={{ $json.lane }}', 'infra', 'infra'),
      rule('={{ $json.lane }}', 'noticia', 'noticia'),
    ]),
    node('orq', 'Executar — Infra', 'n8n-nodes-base.executeWorkflow', 1.2, [1100, 200], {
      source: 'database',
      workflowId: { __rl: true, value: '={{ $env.WF_INFRA_ID }}', mode: 'id' },
      mode: 'once',
      options: { waitForSubWorkflow: true },
    }),
    node('orq', 'Executar — Notícias', 'n8n-nodes-base.executeWorkflow', 1.2, [1100, 400], {
      source: 'database',
      workflowId: { __rl: true, value: '={{ $env.WF_NEWS_ID }}', mode: 'id' },
      mode: 'once',
      options: { waitForSubWorkflow: true },
    }),
  ];
  return workflow('Ops Automation — Orquestrador', nodes, {
    'Agendamento': [['Montar consulta Jira']],
    'Montar consulta Jira': [['Jira — Buscar cards']],
    'Jira — Buscar cards': [['Separar por fila']],
    'Separar por fila': [['Fila']],
    'Fila': [['Executar — Infra'], ['Executar — Notícias']],
  });
}

// ---------------------------------------------------------------------------
// 02 - Infra (subworkflow)
// ---------------------------------------------------------------------------
function whmNode(server, y) {
  return node('inf', 'WHM ' + server + ' — redefinir senha', 'n8n-nodes-base.httpRequest', 4.2, [1540, y], {
    method: 'POST',
    url: 'https://' + server + '.example.com:2087/json-api/uapi_cpanel',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    contentType: 'form-urlencoded',
    bodyParameters: {
      parameters: [
        { name: 'api.version', value: '1' },
        { name: 'cpanel.user', value: '={{ ' + P + '.plan.whm.cpanelUser }}' },
        { name: 'cpanel.module', value: 'Email' },
        { name: 'cpanel.function', value: 'passwd_pop' },
        { name: 'email', value: '={{ ' + P + '.plan.whm.mailLocal }}' },
        { name: 'domain', value: '={{ ' + P + '.plan.whm.mailDomain }}' },
        { name: 'password', value: "={{ $('Gerar senha').item.json.secret }}" },
      ],
    },
    options: { timeout: 30000 },
  }, {
    credentials: { httpHeaderAuth: { name: 'WHM API ' + server } },
    onError: 'continueRegularOutput',
  });
}

function buildInfra() {
  seq = 0;
  const nodes = [
    node('inf', 'Receber cards', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 400], { inputSource: 'passthrough' }),
    codeNode('inf', 'Planejar ações', [220, 400], ['config', 'plan'], `
const cfg = readConfig($env);
const issues = $input.all().map((i) => i.json.issue).filter(Boolean);
const items = planActions(issues, cfg, { now: new Date().toISOString(), executionId: $execution.id });
return items.map((p) => ({ json: p }));
`),
    switchNode('inf', 'Rota', [440, 400], [
      rule('={{ $json.route }}', 'execute', 'executar'),
      rule('={{ $json.route }}', 'reject', 'recusar'),
      rule('={{ $json.route }}', 'dry_run', 'dry-run'),
    ]),
    jiraHttp('inf', 'Jira — Reivindicar card', [660, 200], 'PUT',
      '=' + ENV_JIRA + '/rest/api/3/issue/{{ $json.issueKey }}',
      "={{ JSON.stringify({ update: { labels: [{ add: $env.JIRA_CLAIM_LABEL || 'ops-automation-claimed' }] }, fields: { assignee: { accountId: $env.JIRA_BOT_ACCOUNT_ID } } }) }}"),
    switchNode('inf', 'Executor', [880, 200], [
      rule('={{ ' + P + '.plan.executor }}', 'ssh', 'ssh'),
      rule('={{ ' + P + '.plan.executor }}', 'whm', 'whm'),
    ]),
    switchNode('inf', 'Servidor SSH', [1100, 100], [
      rule('={{ ' + P + '.plan.server }}', 'srv-01', 'srv-01'),
      rule('={{ ' + P + '.plan.server }}', 'srv-02', 'srv-02'),
    ]),
    sshNode('inf', 'SSH srv-01', [1320, 0], 'SSH srv-01', '={{ ' + P + '.plan.sshCommand }}'),
    sshNode('inf', 'SSH srv-02', [1320, 160], 'SSH srv-02', '={{ ' + P + '.plan.sshCommand }}'),
    codeNode('inf', 'Gerar senha', [1100, 340], ['config', 'password'], `
const cfg = readConfig($env);
return { json: { secret: generatePassword({ length: cfg.passwordLength }) } };
`, true),
    switchNode('inf', 'Servidor WHM', [1320, 340], [
      rule('={{ ' + P + '.plan.server }}', 'srv-01', 'srv-01'),
      rule('={{ ' + P + '.plan.server }}', 'srv-02', 'srv-02'),
    ]),
    whmNode('srv-01', 280),
    whmNode('srv-02', 440),
    codeNode('inf', 'Avaliar WHM', [1760, 360], ['result'], `
return { json: { applied: whmUapiSucceeded($json) } };
`, true),
    ifTrue('inf', 'Senha aplicada?', [1980, 360], '={{ $json.applied }}'),
    headerAuthHttp('inf', 'Entregar segredo', [2200, 280], 'Secret Delivery API',
      '={{ $env.SECRET_DELIVERY_URL }}',
      '={{ JSON.stringify({ recipient: ' + P + '.plan.deliveryRecipient, subject: \'Nova senha da conta \' + ' + P + ".plan.mailbox, secret: $('Gerar senha').item.json.secret, ttlHours: Number($env.OPS_SECRET_TTL_HOURS || 24), maxViews: 1, reference: " + P + '.issueKey }) }}',
      { onError: 'continueRegularOutput' }),
    codeNode('inf', 'Avaliar entrega', [2420, 280], [], `
return { json: { applied: true, delivered: !$json.error && $json.ok === true } };
`, true),
    codeNode('inf', 'Interpretar resultado', [2640, 200], ['config', 'result'], `
const cfg = readConfig($env);
const ctx = $('Planejar ações').item.json;
return { json: interpretResult(ctx, $json, cfg) };
`, true),
    codeNode('inf', 'Preparar atualização Jira', [2860, 400], ['jira'], `
return { json: toJiraUpdate($json) };
`, true),
    jiraHttp('inf', 'Jira — Comentar', [3080, 400], 'POST',
      '=' + ENV_JIRA + '/rest/api/3/issue/{{ $json.issueKey }}/comment',
      '={{ JSON.stringify({ body: $json.adf }) }}'),
    jiraHttp('inf', 'Jira — Buscar transições', [3300, 400], 'GET',
      '=' + ENV_JIRA + "/rest/api/3/issue/{{ $('Preparar atualização Jira').item.json.issueKey }}/transitions"),
    codeNode('inf', 'Escolher transição', [3520, 400], ['jira'], `
const ctx = $('Preparar atualização Jira').item.json;
const t = pickTransition($json.transitions || [], ctx.targetStatus);
return { json: { issueKey: ctx.issueKey, hasTransition: Boolean(t), transitionId: t ? String(t.id) : null, targetStatus: ctx.targetStatus, audit: ctx.audit } };
`, true),
    ifTrue('inf', 'Transição encontrada?', [3740, 400], '={{ $json.hasTransition }}'),
    jiraHttp('inf', 'Jira — Aplicar transição', [3960, 300], 'POST',
      '=' + ENV_JIRA + '/rest/api/3/issue/{{ $json.issueKey }}/transitions',
      '={{ JSON.stringify({ transition: { id: $json.transitionId } }) }}'),
    codeNode('inf', 'Montar evento de auditoria', [4180, 600], [], `
// três origens: dry-run (direto do planejador), transição não encontrada, transição aplicada
let event;
let jira;
if ($json.audit && $json.hasTransition === undefined) {
  event = $json.audit;
  jira = 'not_touched';
} else if ($json.audit) {
  event = $json.audit;
  jira = 'transition_not_found';
} else {
  event = $('Escolher transição').item.json.audit;
  jira = 'transition_applied';
}
return { json: { ...event, jira } };
`, true),
    headerAuthHttp('inf', 'Registrar auditoria', [4400, 600], 'Audit Sink',
      '={{ $env.AUDIT_SINK_URL }}', '={{ JSON.stringify($json) }}', { onError: 'continueRegularOutput' }),
  ];
  return workflow('Ops Automation — Infra (subworkflow)', nodes, {
    'Receber cards': [['Planejar ações']],
    'Planejar ações': [['Rota']],
    'Rota': [['Jira — Reivindicar card'], ['Preparar atualização Jira'], ['Montar evento de auditoria']],
    'Jira — Reivindicar card': [['Executor']],
    'Executor': [['Servidor SSH'], ['Gerar senha']],
    'Servidor SSH': [['SSH srv-01'], ['SSH srv-02']],
    'SSH srv-01': [['Interpretar resultado']],
    'SSH srv-02': [['Interpretar resultado']],
    'Gerar senha': [['Servidor WHM']],
    'Servidor WHM': [['WHM srv-01 — redefinir senha'], ['WHM srv-02 — redefinir senha']],
    'WHM srv-01 — redefinir senha': [['Avaliar WHM']],
    'WHM srv-02 — redefinir senha': [['Avaliar WHM']],
    'Avaliar WHM': [['Senha aplicada?']],
    'Senha aplicada?': [['Entregar segredo'], ['Interpretar resultado']],
    'Entregar segredo': [['Avaliar entrega']],
    'Avaliar entrega': [['Interpretar resultado']],
    'Interpretar resultado': [['Preparar atualização Jira']],
    'Preparar atualização Jira': [['Jira — Comentar']],
    'Jira — Comentar': [['Jira — Buscar transições']],
    'Jira — Buscar transições': [['Escolher transição']],
    'Escolher transição': [['Transição encontrada?']],
    'Transição encontrada?': [['Jira — Aplicar transição'], ['Montar evento de auditoria']],
    'Jira — Aplicar transição': [['Montar evento de auditoria']],
    'Montar evento de auditoria': [['Registrar auditoria']],
  }, {
    // Este workflow manipula senha em memória: não guardar dados de execução.
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'none',
    saveManualExecutions: false,
    saveExecutionProgress: false,
    callerPolicy: 'workflowsFromSameOwner',
  });
}

// ---------------------------------------------------------------------------
// 03 - SSL AutoSSL
// ---------------------------------------------------------------------------
function buildSsl() {
  seq = 0;
  const nodes = [
    node('ssl', 'Webhook Uptime Kuma', 'n8n-nodes-base.webhook', 2, [0, 300], {
      httpMethod: 'POST',
      path: 'uptime-cert-expiry',
      authentication: 'headerAuth',
      responseMode: 'onReceived',
      options: {},
    }, { credentials: { httpHeaderAuth: { name: 'Uptime Kuma Webhook' } } }),
    codeNode('ssl', 'Validar alerta', [220, 300], ['config', 'ssl'], `
const cfg = readConfig($env);
const body = $input.first().json.body || {};
const store = $getWorkflowStaticData('global');
store.sslSeen = store.sslSeen || {};
const r = prepareSslJob(body, cfg, { now: Date.now(), seen: store.sslSeen });
if (r.status === 'run') return [{ json: { route: 'run', ...r.job } }];
return [{ json: { route: r.status, status: 'rejected', reason: r.reason, domain: r.domain || null, attempt: 0 } }];
`),
    switchNode('ssl', 'Rota SSL', [440, 300], [
      rule('={{ $json.route }}', 'run', 'executar'),
      rule('={{ $json.route }}', 'reject', 'recusar'),
    ]),
    switchNode('ssl', 'Servidor', [660, 200], [
      rule('={{ $json.server }}', 'srv-01', 'srv-01'),
      rule('={{ $json.server }}', 'srv-02', 'srv-02'),
    ]),
    sshNode('ssl', 'SSH srv-01 — AutoSSL', [880, 100], 'SSH srv-01', '={{ $json.sshCommand }}'),
    sshNode('ssl', 'SSH srv-02 — AutoSSL', [880, 300], 'SSH srv-02', '={{ $json.sshCommand }}'),
    codeNode('ssl', 'Classificar resultado', [1100, 200], ['config', 'result', 'ssl'], `
const cfg = readConfig($env);
const job = $('Validar alerta').first().json;
const parsed = parseCatalogOutput($input.first().json);
const attempt = $runIndex + 1; // $runIndex conta as passagens por este nó (loop de retry)
const r = classifyAutoSsl(parsed, job.domain, attempt, cfg.sslMaxRetries);
return [{ json: { ...job, ...r } }];
`),
    ifTrue('ssl', 'Vale retry?', [1320, 200], '={{ $json.retry }}'),
    node('ssl', 'Aguardar antes do retry', 'n8n-nodes-base.wait', 1.1, [1540, 60], { amount: 120, unit: 'seconds' }),
    codeNode('ssl', 'Montar mensagem Teams', [1540, 400], ['ssl'], `
return [{ json: { payload: buildTeamsMessage($input.first().json) } }];
`),
    node('ssl', 'Postar no Teams', 'n8n-nodes-base.httpRequest', 4.2, [1760, 400], {
      method: 'POST',
      url: '={{ $env.TEAMS_WEBHOOK_URL }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.payload) }}',
      options: { timeout: 30000 },
    }),
  ];
  return workflow('Ops Automation — Renovação SSL (AutoSSL)', nodes, {
    'Webhook Uptime Kuma': [['Validar alerta']],
    'Validar alerta': [['Rota SSL']],
    'Rota SSL': [['Servidor'], ['Montar mensagem Teams']],
    'Servidor': [['SSH srv-01 — AutoSSL'], ['SSH srv-02 — AutoSSL']],
    'SSH srv-01 — AutoSSL': [['Classificar resultado']],
    'SSH srv-02 — AutoSSL': [['Classificar resultado']],
    'Classificar resultado': [['Vale retry?']],
    'Vale retry?': [['Aguardar antes do retry'], ['Montar mensagem Teams']],
    'Aguardar antes do retry': [['Servidor']],
    'Montar mensagem Teams': [['Postar no Teams']],
  });
}

// ---------------------------------------------------------------------------
// 04 - Notícias (stub)
// ---------------------------------------------------------------------------
function buildNews() {
  seq = 0;
  const nodes = [
    node('news', 'Receber cards', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 300], { inputSource: 'passthrough' }),
    codeNode('news', 'Montar payload', [220, 300], ['config', 'news'], `
const cfg = readConfig($env);
return $input.all().map((i) => ({ json: buildNewsJob(i.json.issue, cfg) }));
`),
    ifTrue('news', 'Dry-run?', [440, 300], '={{ $json.dryRun }}'),
    node('news', 'Somente registrar (dry-run)', 'n8n-nodes-base.noOp', 1, [660, 200], {}),
    headerAuthHttp('news', 'Enviar ao serviço de publicação', [660, 400], 'News Publisher API',
      '={{ $env.NEWS_PUBLISHER_URL }}', '={{ JSON.stringify($json) }}'),
  ];
  const sender = nodes[nodes.length - 1];
  sender.parameters.sendHeaders = true;
  sender.parameters.headerParameters = { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}' }] };
  return workflow('Ops Automation — Notícias (stub)', nodes, {
    'Receber cards': [['Montar payload']],
    'Montar payload': [['Dry-run?']],
    'Dry-run?': [['Somente registrar (dry-run)'], ['Enviar ao serviço de publicação']],
  }, { callerPolicy: 'workflowsFromSameOwner' });
}

// ---------------------------------------------------------------------------
const BUILDERS = {
  '01-orquestrador.json': buildOrchestrator,
  '02-infra-ops.json': buildInfra,
  '03-ssl-autossl.json': buildSsl,
  '04-noticias-stub.json': buildNews,
};

function render() {
  const files = {};
  for (const [file, build] of Object.entries(BUILDERS)) files[file] = JSON.stringify(build(), null, 2) + '\n';
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = render();
  let stale = 0;
  if (!check) fs.mkdirSync(OUT, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(OUT, file);
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
      if (current !== content) { console.error('desatualizado: workflows/' + file); stale += 1; }
    } else {
      fs.writeFileSync(target, content);
      console.log('gerado: workflows/' + file);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('workflows/ em dia com src/');
}

if (require.main === module) main();

module.exports = { render, bundle, resolveOrder };
