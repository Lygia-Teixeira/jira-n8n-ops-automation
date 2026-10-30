'use strict';
// Interpretação do retorno das execuções e montagem do comentário final.
// O comentário nunca inclui stderr bruto, saída de comando nem segredo.

const { buildAuditEvent } = require('./audit');

const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * O wrapper do servidor imprime uma única linha JSON no fim da saída.
 * Aceita a saída do nó SSH ({ stdout, stderr, code }) ou um erro do nó.
 */
function parseCatalogOutput(sshOutput) {
  const o = sshOutput || {};
  if (o.error && !o.stdout) return { ok: false, error: 'ssh_failed' };
  const lines = String(o.stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const data = JSON.parse(t);
      if (typeof data.ok !== 'boolean') continue;
      const error = data.ok ? null : (ERROR_CODE_RE.test(String(data.error)) ? data.error : 'unknown_error');
      return { ok: data.ok, error, data };
    } catch (e) {
      // linha que parece JSON mas não é: continua procurando
    }
  }
  return { ok: false, error: 'no_result_line' };
}

/** Resposta de WHM json-api/uapi_cpanel: sucesso só se as duas camadas confirmarem. */
function whmUapiSucceeded(resp) {
  const r = resp || {};
  if (r.error) return false;
  const metaOk = r.metadata && Number(r.metadata.result) === 1;
  const uapiOk = r.data && r.data.uapi && Number(r.data.uapi.status) === 1;
  return Boolean(metaOk && uapiOk);
}

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n) : null;
}

function successComment(ctx, parsed) {
  const plan = ctx.plan;
  if (ctx.activity === 'ip_unblock') {
    return [
      'Automação: IP desbloqueado.',
      'IP: ' + plan.args[0],
      'Servidor: ' + plan.server,
      'O IP foi removido das listas de bloqueio do firewall. Nenhuma liberação permanente foi criada.',
    ].join('\n');
  }
  if (ctx.activity === 'mail_quota_increase') {
    const before = safeInt(parsed.data && parsed.data.before_mb);
    const after = safeInt(parsed.data && parsed.data.new_mb);
    return [
      'Automação: cota de e-mail ajustada.',
      'Conta: ' + plan.args[1] + '@' + plan.args[2],
      'Cota anterior: ' + (before === null ? 'n/d' : before + ' MB'),
      'Cota nova: ' + (after === null ? 'n/d' : after + ' MB'),
    ].join('\n');
  }
  if (ctx.activity === 'mail_password_reset') {
    return [
      'Automação: senha de e-mail redefinida.',
      'Conta: ' + plan.mailbox,
      'A nova senha foi enviada ao contato responsável cadastrado, por link de uso único com validade limitada.',
      'A senha não é registrada neste card nem no histórico da automação.',
    ].join('\n');
  }
  return 'Automação: atividade concluída.';
}

function failureComment(ctx, code) {
  const lines = ['Automação: a execução não foi concluída.', 'Código: ' + code];
  if (code === 'secret_delivery_failed') {
    lines.push('A senha foi redefinida, mas o link de entrega não foi gerado. Siga o runbook: redefinir de novo pelo procedimento manual.');
  }
  lines.push('O card foi encaminhado para triagem manual.');
  return lines.join('\n');
}

/**
 * ctx: item do planejador. input: saída do nó anterior.
 * - ssh: { stdout, stderr, code } do nó SSH
 * - whm: { applied, delivered } dos nós "Avaliar ..."
 */
function interpretResult(ctx, input, cfg) {
  let ok;
  let code = null;
  let parsed = { data: {} };
  if (ctx.plan.executor === 'ssh') {
    parsed = parseCatalogOutput(input);
    ok = parsed.ok;
    code = parsed.error;
  } else {
    const i = input || {};
    ok = Boolean(i.applied && i.delivered);
    code = ok ? null : (i.applied ? 'secret_delivery_failed' : 'whm_call_failed');
  }
  const outcome = ok ? 'success' : 'failure';
  return {
    issueKey: ctx.issueKey,
    outcome,
    jiraComment: ok ? successComment(ctx, parsed) : failureComment(ctx, code),
    targetStatus: ok ? cfg.statusDone : cfg.statusTriage,
    audit: buildAuditEvent({
      ...ctx.audit,
      issueKey: ctx.issueKey,
      activity: ctx.activity,
      route: 'execute',
      reason: code,
      outcome,
      approver: ctx.approver,
      plan: ctx.plan,
      now: new Date().toISOString(),
      executionId: ctx.audit && ctx.audit.executionId,
    }),
  };
}

module.exports = { parseCatalogOutput, whmUapiSucceeded, interpretResult };
