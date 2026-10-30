'use strict';
// Renovação de SSL via AutoSSL disparada por alerta de vencimento do Uptime Kuma.

const { isValidHostname } = require('./validators');
const { findAccountByHostname } = require('./inventory');
const { buildCatalogCommand } = require('./catalog');

function extractKumaDomain(body) {
  const monitor = (body && body.monitor) || {};
  let host = typeof monitor.hostname === 'string' ? monitor.hostname : '';
  if (!host && typeof monitor.url === 'string') {
    try { host = new URL(monitor.url).hostname; } catch (e) { host = ''; }
  }
  host = host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return isValidHostname(host) ? host : null;
}

function isCertExpiryEvent(body) {
  const msg = String((body && body.msg) || '').toLowerCase();
  return /(certificate|certificado)/.test(msg) && /expir/.test(msg);
}

/**
 * Decide se um alerta vira execução.
 * state.seen guarda domínio -> timestamp do último disparo (deduplicação).
 */
function prepareSslJob(body, cfg, state) {
  if (!isCertExpiryEvent(body)) return { status: 'ignore', reason: 'not_cert_expiry_event' };
  const domain = extractKumaDomain(body);
  if (!domain) return { status: 'reject', reason: 'invalid_domain' };
  const owner = findAccountByHostname(cfg.inventory, domain);
  if (!owner) return { status: 'reject', reason: 'domain_not_in_inventory', domain };

  const now = state.now;
  const windowMs = cfg.sslDedupHours * 3600 * 1000;
  const seen = state.seen || {};
  for (const [d, ts] of Object.entries(seen)) if (now - ts > windowMs) delete seen[d];
  if (seen[domain] && now - seen[domain] <= windowMs) return { status: 'ignore', reason: 'duplicate_within_window', domain };
  seen[domain] = now;

  return {
    status: 'run',
    job: {
      domain,
      cpanelUser: owner.user,
      server: owner.server,
      host: owner.host,
      sshCommand: buildCatalogCommand('ssl-autossl', [owner.user, domain], cfg.sshMode),
    },
  };
}

function problemMatchesDomain(problemDomain, domain) {
  const d = String(problemDomain || '').toLowerCase().replace(/^\*\./, '');
  return d === domain || d.endsWith('.' + domain);
}

/**
 * success      -> sem problemas para o domínio
 * dns_manual   -> validação DNS (ex.: wildcard): retry não resolve
 * other_failure-> HTTP DCV, conectividade, erro do wrapper: vale 1 retry
 */
function classifyAutoSsl(parsed, domain, attempt, maxRetries) {
  if (!parsed || !parsed.ok) {
    const status = 'other_failure';
    return { status, problems: [], error: (parsed && parsed.error) || 'unknown_error', attempt, retry: attempt <= maxRetries };
  }
  const all = Array.isArray(parsed.data && parsed.data.problems) ? parsed.data.problems : [];
  const problems = all
    .filter((p) => p && problemMatchesDomain(p.domain, domain))
    .slice(0, 20)
    .map((p) => ({ domain: String(p.domain).slice(0, 253), problem: String(p.problem || '').slice(0, 300) }));
  let status = 'success';
  if (problems.length) status = problems.some((p) => /\bdns\b/i.test(p.problem)) ? 'dns_manual' : 'other_failure';
  return { status, problems, error: null, attempt, retry: status === 'other_failure' && attempt <= maxRetries };
}

const TEAMS_STYLE = {
  success: { title: 'Certificado renovado', color: 'Good' },
  dns_manual: { title: 'Ação manual necessária (validação DNS)', color: 'Warning' },
  other_failure: { title: 'Falha na renovação do certificado', color: 'Attention' },
  rejected: { title: 'Alerta de certificado não processado', color: 'Warning' },
};

/** Payload de Adaptive Card para webhook do Teams (Workflows). Montado como objeto: sem JSON por concatenação. */
function buildTeamsMessage(result) {
  const style = TEAMS_STYLE[result.status] || TEAMS_STYLE.other_failure;
  const facts = [
    { title: 'Domínio', value: result.domain || 'n/d' },
    { title: 'Servidor', value: result.server || 'n/d' },
    { title: 'Tentativas', value: String(result.attempt || 0) },
  ];
  if (result.reason) facts.push({ title: 'Motivo', value: result.reason });
  if (result.error) facts.push({ title: 'Erro', value: result.error });
  const body = [
    { type: 'TextBlock', size: 'Medium', weight: 'Bolder', color: style.color, text: style.title, wrap: true },
    { type: 'FactSet', facts },
  ];
  (result.problems || []).slice(0, 10).forEach((p) => {
    body.push({ type: 'TextBlock', wrap: true, isSubtle: true, text: p.domain + ': ' + p.problem });
  });
  if (result.status === 'dns_manual') {
    body.push({ type: 'TextBlock', wrap: true, text: 'Configure o registro TXT de validação ou remova o wildcard do escopo do AutoSSL.' });
  }
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: { type: 'AdaptiveCard', version: '1.4', body },
    }],
  };
}

module.exports = { extractKumaDomain, isCertExpiryEvent, prepareSslJob, classifyAutoSsl, buildTeamsMessage, problemMatchesDomain };
