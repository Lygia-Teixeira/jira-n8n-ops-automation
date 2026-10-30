'use strict';
// Helpers de Jira Cloud REST v3: consulta (JQL), comentário em ADF e transição.

const { normalizeText } = require('./text');

function jqlQuote(value) {
  return '"' + String(value).replace(/["\\]/g, '\\$&') + '"';
}

function buildSearchRequest(cfg) {
  const projects = cfg.projectKeys.filter((k) => /^[A-Z][A-Z0-9_]{1,9}$/.test(k));
  if (!projects.length) throw new Error('jira: nenhuma chave de projeto válida');
  const jql = [
    'project IN (' + projects.join(', ') + ')',
    'status = ' + jqlQuote(cfg.automationStatus),
    '(labels IS EMPTY OR labels NOT IN (' + jqlQuote(cfg.claimLabel) + '))',
  ].join(' AND ') + ' ORDER BY created ASC';
  return {
    jql,
    maxResults: cfg.searchMaxResults,
    fields: ['summary', 'description', 'status', 'labels', 'reporter', 'issuetype', 'attachment'],
    expand: 'changelog',
  };
}

/** Texto simples -> documento ADF (um parágrafo por linha; sem marcação vinda de fora). */
function buildAdfDoc(text) {
  const lines = String(text || '').split('\n').slice(0, 50);
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => (line
      ? { type: 'paragraph', content: [{ type: 'text', text: line.slice(0, 1000) }] }
      : { type: 'paragraph', content: [] })),
  };
}

function pickTransition(transitions, targetStatus) {
  const target = normalizeText(targetStatus);
  return (transitions || []).find((t) => normalizeText(t.to && t.to.name) === target) ||
    (transitions || []).find((t) => normalizeText(t.name) === target) ||
    null;
}

/** Normaliza itens vindos do planejador (recusa) ou do resultado da execução. */
function toJiraUpdate(item) {
  return {
    issueKey: item.issueKey,
    adf: buildAdfDoc(item.jiraComment),
    targetStatus: item.targetStatus,
    audit: item.audit,
  };
}

module.exports = { jqlQuote, buildSearchRequest, buildAdfDoc, pickTransition, toJiraUpdate };
