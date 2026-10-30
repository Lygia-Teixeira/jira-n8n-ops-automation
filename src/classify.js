'use strict';
// Classificação do card: em qual fila ele entra (orquestrador) e qual
// atividade do catálogo ele pede (workflow de infra).
// A atividade é decidida pelo título ou pelo campo "Atividade", nunca por
// palavras soltas na descrição (que qualquer pessoa pode preencher à vontade).

const { normalizeText, normalizeKey } = require('./text');

const ACTIVITY_RULES = [
  { id: 'ip_unblock', re: /desbloque|ip bloquead|liberar ip|liberacao de ip/ },
  { id: 'mail_quota_increase', re: /(aument|ampli).{0,30}(cota|quota|capacidade|espaco)|caixa (cheia|lotada)|e-?mail cheio/ },
  { id: 'mail_password_reset', re: /(redefin|reset|troc|nova).{0,20}senha/ },
  { id: 'usage_report', re: /relatorio.{0,30}(usabilidade|acesso)|awstats/ },
];

const ACTIVITY_IDS = ACTIVITY_RULES.map((r) => r.id);

function classifyActivity(summary, fields) {
  const explicit = fields && fields.atividade ? normalizeKey(fields.atividade) : '';
  if (explicit) {
    const byId = ACTIVITY_IDS.find((id) => normalizeKey(id) === explicit);
    if (byId) return byId;
  }
  const source = normalizeText(explicit ? fields.atividade : summary);
  const hits = [...new Set(ACTIVITY_RULES.filter((r) => r.re.test(source)).map((r) => r.id))];
  if (hits.length === 1) return hits[0];
  return hits.length === 0 ? 'unknown' : 'ambiguous';
}

/**
 * Fila do orquestrador. Etiqueta (label) tem precedência sobre o prefixo do título.
 * Card que pertence às duas filas é ignorado (decisão humana).
 */
function detectLane(issue, claimLabel) {
  const f = (issue && issue.fields) || {};
  const labels = (f.labels || []).map((l) => normalizeKey(l));
  if (claimLabel && labels.includes(normalizeKey(claimLabel))) return 'ignored';
  const summary = normalizeText(f.summary);
  const infra = labels.includes('infra') || /^\s*\[infra\]/.test(summary);
  const news = labels.includes('noticia') || labels.includes('publicacao') || /^\s*\[(noticia|publicacao)\]/.test(summary);
  if (infra && news) return 'ignored';
  if (infra) return 'infra';
  if (news) return 'noticia';
  return 'ignored';
}

module.exports = { classifyActivity, detectLane, ACTIVITY_IDS };
