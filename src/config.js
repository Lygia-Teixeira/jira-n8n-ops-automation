'use strict';
// Configuração lida de variáveis de ambiente do n8n ($env).
// Só configuração vai aqui; segredos ficam no cofre de credenciais do n8n.
// Padrões seguros: dry-run ligado, allowlist vazia, aprovação obrigatória.

const { parseInventory } = require('./inventory');

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|sim|on)$/i.test(String(value).trim());
}

function parseIntInRange(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const SSH_MODES = ['forced-command', 'sudo-wrapper'];

function readConfig(env) {
  const e = env || {};
  const sshMode = SSH_MODES.includes(e.OPS_SSH_MODE) ? e.OPS_SSH_MODE : 'forced-command';
  return {
    jiraBaseUrl: String(e.JIRA_BASE_URL || 'https://example.atlassian.net').replace(/\/+$/, ''),
    projectKeys: parseList(e.JIRA_PROJECT_KEYS || 'OPS'),
    automationStatus: e.JIRA_AUTOMATION_STATUS || 'Selecionado para Automação',
    statusDone: e.JIRA_STATUS_DONE || 'Conferir e Avisar',
    statusTriage: e.JIRA_STATUS_TRIAGE || 'Triagem Manual',
    claimLabel: e.JIRA_CLAIM_LABEL || 'ops-automation-claimed',
    botAccountId: e.JIRA_BOT_ACCOUNT_ID || '',
    approverIds: parseList(e.OPS_APPROVER_ACCOUNT_IDS),
    requireFourEyes: parseBool(e.OPS_REQUIRE_FOUR_EYES, true),
    dryRun: parseBool(e.OPS_DRY_RUN, true),
    allowedActivities: parseList(e.OPS_ALLOWED_ACTIVITIES),
    maxActionsPerRun: parseIntInRange(e.OPS_MAX_ACTIONS_PER_RUN, 5, 0, 50),
    searchMaxResults: parseIntInRange(e.JIRA_SEARCH_MAX_RESULTS, 25, 1, 100),
    sshMode,
    passwordLength: parseIntInRange(e.OPS_PASSWORD_LENGTH, 20, 16, 64),
    secretTtlHours: parseIntInRange(e.OPS_SECRET_TTL_HOURS, 24, 1, 72),
    sslMaxRetries: parseIntInRange(e.SSL_MAX_RETRIES, 1, 0, 3),
    sslDedupHours: parseIntInRange(e.SSL_DEDUP_HOURS, 12, 0, 168),
    inventory: parseInventory(e.OPS_INVENTORY_JSON || '{"servers":{},"accounts":{}}'),
  };
}

module.exports = { readConfig, parseBool, parseIntInRange, parseList };
