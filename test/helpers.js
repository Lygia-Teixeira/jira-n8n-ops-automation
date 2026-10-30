'use strict';
// Fixtures compartilhadas. Endereços públicos de teste são montados a partir
// de octetos para manter o repositório livre de IPs reais em notação pontuada.

const ip4 = (...octets) => octets.join('.');
const PUBLIC_IP = ip4(8, 8, 4, 4);

const INVENTORY = {
  servers: {
    'srv-01': { host: 'srv-01.example.com' },
    'srv-02': { host: 'srv-02.example.com' },
  },
  accounts: {
    clientea: { server: 'srv-01', domains: ['cliente-a.example.com'], aliases: ['Cliente A'], contact: 'contato-a@example.com' },
    clienteb: { server: 'srv-02', domains: ['cliente-b.example.com', 'loja-b.example.com'], aliases: ['Cliente B'] },
  },
};

const APPROVER = 'acc-approver-1';
const REPORTER = 'acc-reporter-1';

function baseEnv(overrides) {
  return {
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_PROJECT_KEYS: 'OPS',
    JIRA_AUTOMATION_STATUS: 'Selecionado para Automação',
    JIRA_STATUS_DONE: 'Conferir e Avisar',
    JIRA_STATUS_TRIAGE: 'Triagem Manual',
    JIRA_CLAIM_LABEL: 'ops-automation-claimed',
    OPS_APPROVER_ACCOUNT_IDS: APPROVER,
    OPS_ALLOWED_ACTIVITIES: 'ip_unblock,mail_quota_increase,mail_password_reset',
    OPS_DRY_RUN: 'false',
    OPS_MAX_ACTIONS_PER_RUN: '5',
    OPS_INVENTORY_JSON: JSON.stringify(INVENTORY),
    ...(overrides || {}),
  };
}

function adf(lines) {
  return {
    type: 'doc',
    version: 1,
    content: lines.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
  };
}

function makeIssue(opts) {
  const o = opts || {};
  const approvedBy = o.approvedBy === undefined ? APPROVER : o.approvedBy;
  const histories = approvedBy
    ? [{
      created: '2026-01-10T10:00:00.000+0000',
      author: { accountId: approvedBy },
      items: [{ field: 'status', fromString: 'Backlog', toString: 'Selecionado para Automação' }],
    }]
    : [];
  return {
    key: o.key || 'OPS-101',
    fields: {
      summary: o.summary || '[Infra] Desbloqueio de IP - Cliente A',
      description: adf(o.lines || ['Cliente: clientea', 'IP: ' + PUBLIC_IP]),
      labels: o.labels || [],
      reporter: { accountId: o.reporter || REPORTER },
      attachment: o.attachment || [],
    },
    changelog: { histories },
  };
}

module.exports = { ip4, PUBLIC_IP, INVENTORY, APPROVER, REPORTER, baseEnv, adf, makeIssue };
