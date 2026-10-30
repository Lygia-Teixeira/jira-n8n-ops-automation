'use strict';
// Evento de auditoria: o que foi decidido, por quê, com quais argumentos
// validados e por quem foi aprovado. Nunca carrega segredo.

const FORBIDDEN_KEY_RE = /pass(word)?|senha|secret|token|authorization|cookie/i;

function assertNoSecretFields(obj, path) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEY_RE.test(k)) throw new Error('audit: campo sensível em ' + (path ? path + '.' : '') + k);
    assertNoSecretFields(v, (path ? path + '.' : '') + k);
  }
}

function buildAuditEvent(input) {
  const i = input || {};
  const plan = i.plan || null;
  const event = {
    schema: 'ops-automation.audit.v1',
    at: i.now || new Date().toISOString(),
    executionId: i.executionId || null,
    workflow: i.workflow || 'infra',
    issueKey: i.issueKey || null,
    activity: i.activity || null,
    decision: i.route || null,
    reason: i.reason || null,
    dryRun: Boolean(i.dryRun),
    approver: i.approver || null,
    outcome: i.outcome || null,
    target: plan ? { server: plan.server, executor: plan.executor, command: plan.commandId || null, args: plan.args || [] } : null,
  };
  assertNoSecretFields(event);
  return event;
}

module.exports = { buildAuditEvent, assertNoSecretFields };
