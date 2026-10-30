'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { planActions } = require('../src/plan');
const { parseCatalogOutput, whmUapiSucceeded, interpretResult } = require('../src/result');
const { buildSearchRequest, buildAdfDoc, pickTransition, jqlQuote } = require('../src/jira');
const { prepareSslJob, classifyAutoSsl, buildTeamsMessage, extractKumaDomain } = require('../src/ssl');
const { routeIssues, buildNewsJob } = require('../src/news');
const { classifyActivity, detectLane } = require('../src/classify');
const { adfToText, parseFields } = require('../src/text');
const { assertNoSecretFields } = require('../src/audit');
const { baseEnv, makeIssue, PUBLIC_IP } = require('./helpers');

const cfg = readConfig(baseEnv());
const ctx = { now: '2026-01-10T12:00:00.000Z', executionId: 'test' };

test('saída do wrapper: última linha JSON vence; lixo é ignorado', () => {
  const r = parseCatalogOutput({ stdout: 'csf: ok\n{"ok":true,"action":"ip-unblock"}\n', code: 0 });
  assert.equal(r.ok, true);
  assert.equal(parseCatalogOutput({ stdout: 'nada' }).error, 'no_result_line');
  assert.equal(parseCatalogOutput({ error: 'connection refused' }).error, 'ssh_failed');
  assert.equal(parseCatalogOutput({ stdout: '{"ok":false,"error":"<script>"}' }).error, 'unknown_error');
});

test('interpretResult: sucesso SSH vai para "Conferir", falha para triagem sem stderr', () => {
  const p = planActions([makeIssue()], cfg, ctx)[0];
  const ok = interpretResult(p, { stdout: '{"ok":true}', code: 0 }, cfg);
  assert.equal(ok.outcome, 'success');
  assert.equal(ok.targetStatus, 'Conferir e Avisar');
  assert.ok(ok.jiraComment.includes(PUBLIC_IP));
  const fail = interpretResult(p, { stdout: '{"ok":false,"error":"csf_failed"}', stderr: 'segredo no stderr', code: 1 }, cfg);
  assert.equal(fail.targetStatus, 'Triagem Manual');
  assert.ok(!fail.jiraComment.includes('segredo'));
  assert.equal(fail.audit.outcome, 'failure');
});

test('interpretResult: redefinição de senha nunca escreve a senha', () => {
  const p = planActions([makeIssue({ summary: '[Infra] Redefinir senha', lines: ['Cliente: clientea', 'E-mail: joao@cliente-a.example.com'] })], cfg, ctx)[0];
  const ok = interpretResult(p, { applied: true, delivered: true }, cfg);
  assert.equal(ok.outcome, 'success');
  assert.match(ok.jiraComment, /link de uso único/);
  const notDelivered = interpretResult(p, { applied: true, delivered: false }, cfg);
  assert.equal(notDelivered.outcome, 'failure');
  assert.match(notDelivered.jiraComment, /secret_delivery_failed/);
  assert.doesNotThrow(() => assertNoSecretFields(ok.audit));
  assert.throws(() => assertNoSecretFields({ a: { password: 'x' } }));
});

test('WHM: sucesso só com metadata.result=1 e data.uapi.status=1', () => {
  assert.ok(whmUapiSucceeded({ metadata: { result: 1 }, data: { uapi: { status: 1 } } }));
  assert.ok(!whmUapiSucceeded({ metadata: { result: 1 }, data: { uapi: { status: 0 } } }));
  assert.ok(!whmUapiSucceeded({ error: 'timeout' }));
});

test('Jira: JQL com aspas escapadas e exclusão do label de reivindicação', () => {
  const req = buildSearchRequest(cfg);
  assert.match(req.jql, /^project IN \(OPS\) AND status = "Selecionado para Automação" AND \(labels IS EMPTY OR labels NOT IN \("ops-automation-claimed"\)\)/);
  assert.equal(req.expand, 'changelog');
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => buildSearchRequest({ ...cfg, projectKeys: ['x) OR 1=1'] }));
});

test('Jira: ADF só com texto e transição por nome do status destino', () => {
  const doc = buildAdfDoc('linha 1\nlinha 2');
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].type, 'text');
  const t = pickTransition([{ id: '11', name: 'Enviar', to: { name: 'Conferir e Avisar' } }, { id: '21', name: 'Triagem Manual', to: { name: 'Triagem Manual' } }], 'conferir e avisar');
  assert.equal(t.id, '11');
  assert.equal(pickTransition([], 'x'), null);
});

test('texto: ADF vira texto e campos "Chave: valor" são lidos', () => {
  const issue = makeIssue({ lines: ['Cliente: clientea', 'Endereço IP: 2a00::1', 'Outra: coisa'] });
  const { fields } = parseFields(adfToText(issue.fields.description));
  assert.deepEqual(fields, { cliente: 'clientea', ip: '2a00::1' });
});

test('classificação e fila', () => {
  assert.equal(classifyActivity('[Infra] Caixa cheia', {}), 'mail_quota_increase');
  assert.equal(classifyActivity('qualquer', { atividade: 'ip_unblock' }), 'ip_unblock');
  assert.equal(detectLane({ fields: { summary: '[Notícia] Nova publicação', labels: [] } }, 'x'), 'noticia');
  assert.equal(detectLane({ fields: { summary: '[Infra] x', labels: ['noticia'] } }, 'x'), 'ignored');
  const routed = routeIssues([makeIssue(), makeIssue(), { key: 'bad key', fields: {} }], cfg);
  assert.deepEqual(routed.map((r) => r.lane), ['infra']);
});

test('notícias: payload mínimo com chave de idempotência', () => {
  const job = buildNewsJob(makeIssue({ summary: '[Notícia] Título', attachment: [{ id: 5, filename: 'a.pdf', mimeType: 'application/pdf', size: 10, content: 'https://example.com/x' }] }), cfg);
  assert.equal(job.idempotencyKey, 'news-OPS-101');
  assert.equal(job.title, 'Título');
  assert.deepEqual(Object.keys(job.attachments[0]), ['id', 'filename', 'mimeType', 'size']);
});

test('SSL: domínio do Kuma validado e resolvido pelo inventário com deduplicação', () => {
  const body = { msg: 'Certificate will expire in 5 days', monitor: { url: 'https://www.loja-b.example.com/' } };
  assert.equal(extractKumaDomain(body), 'loja-b.example.com');
  const state = { now: 1000, seen: {} };
  const r = prepareSslJob(body, cfg, state);
  assert.equal(r.status, 'run');
  assert.equal(r.job.server, 'srv-02');
  assert.equal(r.job.sshCommand, 'ssl-autossl clienteb loja-b.example.com');
  assert.equal(prepareSslJob(body, cfg, { now: 2000, seen: state.seen }).reason, 'duplicate_within_window');
  assert.equal(prepareSslJob({ ...body, msg: 'Down' }, cfg, { now: 1, seen: {} }).status, 'ignore');
  assert.equal(prepareSslJob({ msg: 'certificate expiring', monitor: { hostname: 'outro.example.org' } }, cfg, { now: 1, seen: {} }).reason, 'domain_not_in_inventory');
  assert.equal(prepareSslJob({ msg: 'certificate expiring', monitor: { hostname: 'a;id' } }, cfg, { now: 1, seen: {} }).reason, 'invalid_domain');
});

test('SSL: classificação por fronteira de rótulo e retry limitado', () => {
  const domain = 'loja-b.example.com';
  const parsed = (problems) => ({ ok: true, data: { problems } });
  assert.equal(classifyAutoSsl(parsed([]), domain, 1, 1).status, 'success');
  // problema de outro domínio que só contém o nome como substring não conta
  assert.equal(classifyAutoSsl(parsed([{ domain: 'minhaloja-b.example.com', problem: 'HTTP DCV' }]), domain, 1, 1).status, 'success');
  const dns = classifyAutoSsl(parsed([{ domain: '*.loja-b.example.com', problem: 'DNS DCV: no TXT record' }]), domain, 1, 1);
  assert.equal(dns.status, 'dns_manual');
  assert.equal(dns.retry, false);
  const http1 = classifyAutoSsl(parsed([{ domain, problem: 'HTTP DCV: 404' }]), domain, 1, 1);
  assert.deepEqual([http1.status, http1.retry], ['other_failure', true]);
  assert.equal(classifyAutoSsl(parsed([{ domain, problem: 'HTTP DCV: 404' }]), domain, 2, 1).retry, false);
});

test('Teams: payload montado como objeto (aspas no texto não quebram o JSON)', () => {
  const msg = buildTeamsMessage({ status: 'other_failure', domain: 'loja-b.example.com', server: 'srv-02', attempt: 2, problems: [{ domain: 'x', problem: 'erro "com aspas" e \\ barra' }] });
  const round = JSON.parse(JSON.stringify(msg));
  assert.equal(round.attachments[0].content.type, 'AdaptiveCard');
  assert.match(round.attachments[0].content.body[2].text, /"com aspas"/);
});
