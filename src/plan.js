'use strict';
// Planejador do workflow de infra: transforma cards em decisões.
//   execute  -> reivindica o card e executa
//   dry_run  -> só registra o que faria (padrão)
//   reject   -> comenta o motivo e move para triagem manual
//   defer    -> excedeu o limite do ciclo; fica para o próximo
//   skip     -> já processado / chave inválida; nada a fazer
// Nenhum valor do card chega a um comando sem passar pelos validadores.

const { isValidIssueKey, normalizePublicIp, parseEmail } = require('./validators');
const { adfToText, parseFields, normalizeKey } = require('./text');
const { resolveAccount, accountOwnsDomain } = require('./inventory');
const { classifyActivity } = require('./classify');
const { verifyApproval } = require('./approval');
const { CATALOG, buildCatalogCommand } = require('./catalog');
const { buildAuditEvent } = require('./audit');

const REJECT_MESSAGES = {
  activity_unrecognized: 'não foi possível identificar a atividade pelo título ou pelo campo "Atividade"',
  activity_not_allowed: 'esta atividade não está habilitada para execução automática',
  manual_activity: 'esta atividade é executada manualmente pela equipe',
  not_approved: 'o card não foi liberado para automação por um aprovador',
  ambiguous_fields: 'há campos repetidos com valores diferentes na descrição',
  client_missing: 'o campo "Cliente" não foi informado',
  client_not_found: 'o cliente informado não consta no inventário',
  client_ambiguous: 'o cliente informado corresponde a mais de uma conta',
  ip_invalid: 'o IP informado é inválido ou pertence a faixa privada/reservada',
  email_invalid: 'o e-mail informado é inválido',
  email_domain_not_owned: 'o domínio do e-mail não pertence à conta do cliente',
  no_contact: 'a conta não tem contato responsável cadastrado para receber a nova senha',
  plan_error: 'não foi possível montar a operação com segurança',
};

function rejectComment(reason) {
  return [
    'Automação: card não executado.',
    'Motivo: ' + (REJECT_MESSAGES[reason] || 'validação falhou') + '.',
    'O card foi encaminhado para triagem manual. Nenhuma alteração foi feita nos servidores.',
  ].join('\n');
}

function resolveTarget(activity, fields, inventory) {
  const acc = resolveAccount(inventory, fields.cliente);
  if (acc.status === 'missing') return { error: 'client_missing' };
  if (acc.status === 'not_found') return { error: 'client_not_found' };
  if (acc.status === 'ambiguous') return { error: 'client_ambiguous' };
  const base = { server: acc.server, host: acc.host, cpanelUser: acc.user };

  if (activity === 'ip_unblock') {
    const ip = normalizePublicIp(fields.ip || '');
    if (!ip) return { error: 'ip_invalid' };
    return { ...base, args: [ip.address] };
  }
  const mail = parseEmail(fields.email || '');
  if (!mail) return { error: 'email_invalid' };
  if (!accountOwnsDomain(acc.account, mail.domain)) return { error: 'email_domain_not_owned' };
  if (activity === 'mail_quota_increase') {
    return { ...base, args: [acc.user, mail.local, mail.domain] };
  }
  if (activity === 'mail_password_reset') {
    if (!acc.account.contact) return { error: 'no_contact' };
    return {
      ...base,
      args: [acc.user, mail.local, mail.domain],
      mailbox: mail.address,
      deliveryRecipient: acc.account.contact,
    };
  }
  return { error: 'plan_error' };
}

function planOne(issue, cfg, ctx) {
  const key = issue && issue.key;
  if (!isValidIssueKey(key)) return { issueKey: null, route: 'skip', reason: 'invalid_issue_key' };
  const f = issue.fields || {};
  const labels = (f.labels || []).map(normalizeKey);
  if (labels.includes(normalizeKey(cfg.claimLabel))) return { issueKey: key, route: 'skip', reason: 'already_claimed' };

  const base = { issueKey: key, now: ctx.now, executionId: ctx.executionId, dryRun: cfg.dryRun };
  const reject = (reason, extra) => {
    const item = { issueKey: key, route: 'reject', reason, ...(extra || {}) };
    item.jiraComment = rejectComment(reason);
    item.targetStatus = cfg.statusTriage;
    item.audit = buildAuditEvent({ ...base, ...item });
    return item;
  };

  // 1. aprovação antes de qualquer outra coisa (não processa card não liberado)
  const approval = verifyApproval(issue, {
    statusName: cfg.automationStatus,
    approverIds: cfg.approverIds,
    requireFourEyes: cfg.requireFourEyes,
  });
  if (!approval.approved) return reject('not_approved', { approvalDetail: approval.reason });

  // 2. atividade e allowlist
  const { fields, ambiguous } = parseFields(adfToText(f.description));
  const activity = classifyActivity(f.summary || '', fields);
  if (activity === 'unknown' || activity === 'ambiguous') return reject('activity_unrecognized', { approver: approval.approver });
  const entry = CATALOG[activity];
  if (entry.executor === 'manual') return reject('manual_activity', { activity, approver: approval.approver });
  if (!cfg.allowedActivities.includes(activity)) return reject('activity_not_allowed', { activity, approver: approval.approver });
  if (ambiguous.length) return reject('ambiguous_fields', { activity, approver: approval.approver });

  // 3. parâmetros validados + inventário
  const target = resolveTarget(activity, fields, cfg.inventory);
  if (target.error) return reject(target.error, { activity, approver: approval.approver });

  // 4. plano de execução a partir do catálogo
  const plan = { executor: entry.executor, server: target.server, host: target.host, args: target.args };
  try {
    if (entry.executor === 'ssh') {
      plan.commandId = entry.command;
      plan.sshCommand = buildCatalogCommand(entry.command, target.args, cfg.sshMode);
    } else if (entry.executor === 'whm') {
      plan.commandId = 'uapi:Email/passwd_pop';
      plan.whm = { cpanelUser: target.args[0], mailLocal: target.args[1], mailDomain: target.args[2] };
      plan.mailbox = target.mailbox;
      plan.deliveryRecipient = target.deliveryRecipient;
    }
  } catch (e) {
    return reject('plan_error', { activity, approver: approval.approver });
  }

  const route = cfg.dryRun ? 'dry_run' : 'execute';
  const item = { issueKey: key, route, activity, approver: approval.approver, plan };
  item.audit = buildAuditEvent({ ...base, ...item, plan: { ...plan, args: plan.args } });
  return item;
}

function planActions(issues, cfg, ctx) {
  const out = [];
  const seen = new Set();
  let budget = cfg.maxActionsPerRun;
  for (const issue of issues || []) {
    const p = planOne(issue, cfg, ctx || {});
    if (p.issueKey && seen.has(p.issueKey)) continue; // idempotência dentro do ciclo
    if (p.issueKey) seen.add(p.issueKey);
    if (p.route === 'execute' || p.route === 'dry_run') {
      if (budget <= 0) {
        p.route = 'defer';
        p.reason = 'run_limit_reached';
        p.audit = { ...p.audit, decision: 'defer', reason: p.reason };
      } else {
        budget -= 1;
      }
    }
    out.push(p);
  }
  return out;
}

module.exports = { planActions, planOne, rejectComment, REJECT_MESSAGES };
