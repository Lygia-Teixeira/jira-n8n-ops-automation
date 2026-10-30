'use strict';
// Fila de notícias: o n8n só encaminha um payload mínimo para um serviço
// externo de publicação, que é responsável por reivindicar e concluir o card.

const { adfToText } = require('./text');
const { isValidIssueKey } = require('./validators');
const { detectLane } = require('./classify');

function routeIssues(issues, cfg) {
  const out = [];
  const seen = new Set();
  for (const issue of issues || []) {
    if (!issue || !isValidIssueKey(issue.key) || seen.has(issue.key)) continue;
    seen.add(issue.key);
    const lane = detectLane(issue, cfg.claimLabel);
    if (lane === 'ignored') continue;
    out.push({ lane, issueKey: issue.key, issue });
  }
  return out;
}

function buildNewsJob(issue, cfg) {
  const f = (issue && issue.fields) || {};
  return {
    issueKey: issue.key,
    idempotencyKey: 'news-' + issue.key,
    dryRun: cfg.dryRun,
    title: String(f.summary || '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 300),
    body: adfToText(f.description).slice(0, 10000),
    attachments: (f.attachment || []).slice(0, 20).map((a) => ({
      id: String(a.id),
      filename: String(a.filename || '').slice(0, 200),
      mimeType: String(a.mimeType || ''),
      size: Number(a.size) || 0,
    })),
  };
}

module.exports = { routeIssues, buildNewsJob };
