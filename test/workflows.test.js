'use strict';
// Testes dos workflows gerados: estrutura válida, em dia com src/ e
// execução real do código de alguns nós Code num sandbox (vm) com $input/$env simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { render } = require('../scripts/build-workflows');
const { validateAll } = require('../scripts/validate-workflows');
const { baseEnv, makeIssue, PUBLIC_IP } = require('./helpers');

const DIR = path.resolve(__dirname, '..', 'workflows');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const codeOf = (wf, name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

async function runCode(jsCode, globals) {
  const sandbox = {
    require: (m) => { if (m === 'crypto') return require('crypto'); throw new Error('módulo bloqueado: ' + m); },
    URL,
    ...globals,
  };
  vm.createContext(sandbox);
  const out = await vm.runInContext('(async function(){\n' + jsCode + '\n})()', sandbox);
  return JSON.parse(JSON.stringify(out)); // normaliza objetos criados em outro realm
}

const items = (arr) => ({ all: () => arr.map((json) => ({ json })), first: () => ({ json: arr[0] }) });

test('todos os workflows passam na validação estática', () => {
  const report = validateAll();
  assert.equal(Object.keys(report).length, 4);
  for (const [f, errs] of Object.entries(report)) assert.deepEqual(errs, [], f);
});

test('workflows/ está em dia com src/ (rode npm run build se falhar)', () => {
  for (const [f, content] of Object.entries(render())) {
    assert.equal(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'), content, f);
  }
});

test('nó "Planejar ações" roda isolado e produz o mesmo plano dos módulos', async () => {
  const wf = load('02-infra-ops.json');
  const out = await runCode(codeOf(wf, 'Planejar ações'), {
    $env: baseEnv(),
    $execution: { id: 'exec-1' },
    $input: items([{ lane: 'infra', issue: makeIssue() }, { lane: 'infra', issue: makeIssue({ key: 'OPS-102', lines: ['Cliente: clientea', 'IP: $(id)'] }) }]),
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].json.route, 'execute');
  assert.equal(out[0].json.plan.sshCommand, 'ip-unblock ' + PUBLIC_IP);
  assert.equal(out[1].json.route, 'reject');
  assert.equal(out[1].json.reason, 'ip_invalid');
});

test('nó "Gerar senha" usa crypto e respeita o comprimento configurado', async () => {
  const wf = load('02-infra-ops.json');
  const out = await runCode(codeOf(wf, 'Gerar senha'), { $env: baseEnv({ OPS_PASSWORD_LENGTH: '24' }) });
  assert.equal(out.json.secret.length, 24);
});

test('nó "Separar por fila" do orquestrador separa infra e notícia', async () => {
  const wf = load('01-orquestrador.json');
  const news = makeIssue({ key: 'OPS-300', summary: '[Notícia] Evento' });
  const out = await runCode(codeOf(wf, 'Separar por fila'), { $env: baseEnv(), $input: items([{ issues: [makeIssue(), news] }]) });
  assert.deepEqual(out.map((o) => o.json.lane), ['infra', 'noticia']);
});

test('infra não guarda dados de execução (manipula senha em memória)', () => {
  const s = load('02-infra-ops.json').settings;
  assert.equal(s.saveDataSuccessExecution, 'none');
  assert.equal(s.saveDataErrorExecution, 'none');
});
