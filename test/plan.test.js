'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { planActions } = require('../src/plan');
const { assertNoSecretFields } = require('../src/audit');
const { PUBLIC_IP, baseEnv, makeIssue, REPORTER } = require('./helpers');

const ctx = { now: '2026-01-10T12:00:00.000Z', executionId: 'test' };
const plan1 = (issue, env) => planActions([issue], readConfig(baseEnv(env)), ctx)[0];

test('desbloqueio aprovado vira execução com comando do catálogo', () => {
  const p = plan1(makeIssue());
  assert.equal(p.route, 'execute');
  assert.equal(p.activity, 'ip_unblock');
  assert.equal(p.plan.server, 'srv-01');
  assert.equal(p.plan.sshCommand, 'ip-unblock ' + PUBLIC_IP);
  assert.equal(p.audit.approver, 'acc-approver-1');
  assert.equal(p.audit.target.command, 'ip-unblock');
});

test('dry-run é o padrão quando OPS_DRY_RUN não é definido', () => {
  const env = baseEnv();
  delete env.OPS_DRY_RUN;
  const p = planActions([makeIssue()], readConfig(env), ctx)[0];
  assert.equal(p.route, 'dry_run');
  assert.equal(p.audit.dryRun, true);
});

test('sem aprovação, aprovação por não-aprovador ou quatro olhos violado: recusa', () => {
  assert.equal(plan1(makeIssue({ approvedBy: null })).reason, 'not_approved');
  assert.equal(plan1(makeIssue({ approvedBy: 'acc-random' })).reason, 'not_approved');
  const selfApproved = plan1(makeIssue({ reporter: 'acc-approver-1' }));
  assert.equal(selfApproved.route, 'reject');
  assert.equal(selfApproved.approvalDetail, 'four_eyes_violation');
  assert.equal(plan1(makeIssue(), { OPS_APPROVER_ACCOUNT_IDS: '' }).approvalDetail, 'no_approvers_configured');
  assert.equal(plan1(makeIssue({ reporter: REPORTER })).route, 'execute');
});

test('allowlist vazia recusa tudo', () => {
  assert.equal(plan1(makeIssue(), { OPS_ALLOWED_ACTIVITIES: '' }).reason, 'activity_not_allowed');
});

test('injeção no campo IP é recusada e o comentário não ecoa o valor', () => {
  const p = plan1(makeIssue({ lines: ['Cliente: clientea', 'IP: ' + PUBLIC_IP + '; curl x | sh'] }));
  assert.equal(p.route, 'reject');
  assert.equal(p.reason, 'ip_invalid');
  assert.ok(!p.jiraComment.includes('curl'));
  assert.equal(p.targetStatus, 'Triagem Manual');
});

test('IP privado é recusado', () => {
  assert.equal(plan1(makeIssue({ lines: ['Cliente: clientea', 'IP: 192.0.2.10'] })).reason, 'ip_invalid');
});

test('cliente: correspondência exata, sem substring', () => {
  assert.equal(plan1(makeIssue({ lines: ['Cliente: cliente', 'IP: ' + PUBLIC_IP] })).reason, 'client_not_found');
  assert.equal(plan1(makeIssue({ lines: ['IP: ' + PUBLIC_IP] })).reason, 'client_missing');
  assert.equal(plan1(makeIssue({ lines: ['Cliente: Cliente A', 'IP: ' + PUBLIC_IP] })).route, 'execute');
});

test('campos repetidos com valores diferentes: recusa por ambiguidade', () => {
  const p = plan1(makeIssue({ lines: ['Cliente: clientea', 'IP: ' + PUBLIC_IP, 'IP: ' + PUBLIC_IP.replace(/4$/, '5')] }));
  assert.equal(p.reason, 'ambiguous_fields');
});

test('cota de e-mail: domínio precisa pertencer à conta', () => {
  const ok = plan1(makeIssue({ summary: '[Infra] Aumentar cota de e-mail', lines: ['Cliente: clienteb', 'E-mail: vendas@loja-b.example.com'] }));
  assert.equal(ok.route, 'execute');
  assert.equal(ok.plan.server, 'srv-02');
  assert.equal(ok.plan.sshCommand, 'mail-quota-increase clienteb vendas loja-b.example.com');
  const other = plan1(makeIssue({ summary: '[Infra] Aumentar cota de e-mail', lines: ['Cliente: clienteb', 'E-mail: joao@cliente-a.example.com'] }));
  assert.equal(other.reason, 'email_domain_not_owned');
});

test('redefinição de senha: entrega para o contato do inventário, nunca para o card', () => {
  const p = plan1(makeIssue({
    summary: '[Infra] Redefinir senha de e-mail',
    lines: ['Cliente: clientea', 'E-mail: joao@cliente-a.example.com', 'Enviar para: atacante@example.com'],
  }));
  assert.equal(p.route, 'execute');
  assert.equal(p.plan.executor, 'whm');
  assert.equal(p.plan.deliveryRecipient, 'contato-a@example.com');
  assert.deepEqual(p.plan.whm, { cpanelUser: 'clientea', mailLocal: 'joao', mailDomain: 'cliente-a.example.com' });
  assert.doesNotThrow(() => assertNoSecretFields(p.audit));
  assert.ok(!('secret' in p.plan));
  const noContact = plan1(makeIssue({ summary: '[Infra] Redefinir senha', lines: ['Cliente: clienteb', 'E-mail: x@loja-b.example.com'] }));
  assert.equal(noContact.reason, 'no_contact');
});

test('atividade manual, desconhecida ou ambígua vai para triagem', () => {
  assert.equal(plan1(makeIssue({ summary: '[Infra] Relatório de usabilidade' })).reason, 'manual_activity');
  assert.equal(plan1(makeIssue({ summary: '[Infra] Ajuda com o site' })).reason, 'activity_unrecognized');
  assert.equal(plan1(makeIssue({ summary: '[Infra] Desbloqueio de IP e redefinir senha' })).reason, 'activity_unrecognized');
});

test('palavras-chave na descrição não mudam a atividade', () => {
  const p = plan1(makeIssue({ summary: '[Infra] Desbloqueio de IP', lines: ['Cliente: clientea', 'IP: ' + PUBLIC_IP, 'obs: redefinir senha do root'] }));
  assert.equal(p.activity, 'ip_unblock');
});

test('idempotência: card reivindicado é ignorado, duplicado no ciclo também', () => {
  assert.equal(plan1(makeIssue({ labels: ['ops-automation-claimed'] })).route, 'skip');
  const out = planActions([makeIssue(), makeIssue()], readConfig(baseEnv()), ctx);
  assert.equal(out.length, 1);
});

test('limite por ciclo: excedentes ficam para o próximo', () => {
  const issues = Array.from({ length: 4 }, (_, i) => makeIssue({ key: 'OPS-' + (200 + i) }));
  const out = planActions(issues, readConfig(baseEnv({ OPS_MAX_ACTIONS_PER_RUN: '2' })), ctx);
  assert.deepEqual(out.map((p) => p.route), ['execute', 'execute', 'defer', 'defer']);
  assert.equal(out[3].audit.decision, 'defer');
});

test('chave de card inválida é descartada antes de qualquer chamada', () => {
  assert.equal(plan1(makeIssue({ key: 'OPS-1/../../x' })).route, 'skip');
});
