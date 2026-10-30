'use strict';
// Aprovação: quem pode criar card não é quem autoriza a automação.
// O card só é executado se a última transição para a coluna de automação
// foi feita por uma conta da lista de aprovadores (lida do changelog do Jira).

const { normalizeText } = require('./text');

function verifyApproval(issue, options) {
  const { statusName, approverIds = [], requireFourEyes = true } = options || {};
  if (!approverIds.length) return { approved: false, reason: 'no_approvers_configured' };
  const histories = (issue && issue.changelog && issue.changelog.histories) || [];
  const target = normalizeText(statusName);
  const moves = histories
    .filter((h) => (h.items || []).some((it) => it.field === 'status' && normalizeText(it.toString) === target))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  if (!moves.length) return { approved: false, reason: 'no_transition_found' };
  const last = moves[0];
  const approver = last.author && last.author.accountId;
  if (!approver || !approverIds.includes(approver)) return { approved: false, reason: 'transition_by_non_approver' };
  const reporter = issue.fields && issue.fields.reporter && issue.fields.reporter.accountId;
  if (requireFourEyes && reporter && reporter === approver) {
    return { approved: false, reason: 'four_eyes_violation' };
  }
  return { approved: true, approver };
}

module.exports = { verifyApproval };
