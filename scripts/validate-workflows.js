#!/usr/bin/env node
'use strict';
// Validação estática dos workflows exportados:
//  - JSON faz parse e tem a estrutura mínima de um workflow n8n
//  - nomes e ids de nós únicos; toda conexão aponta para nós existentes
//  - nenhum nó solto (sem entrada e sem saída, exceto gatilhos)
//  - credenciais só por nome (sem id, sem valor) e de uma lista conhecida
//  - código dos nós Code compila
//  - nada que pareça segredo, IP real ou host fora de example.com

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.resolve(__dirname, '..', 'workflows');

const ALLOWED_CREDENTIALS = new Set([
  'Jira API', 'SSH srv-01', 'SSH srv-02', 'WHM API srv-01', 'WHM API srv-02',
  'Secret Delivery API', 'Audit Sink', 'Uptime Kuma Webhook', 'News Publisher API',
]);
const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.webhook', 'n8n-nodes-base.executeWorkflowTrigger',
]);

const DOC_IPV4 = [/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^127\.0\.0\.1$/];

function scanText(text) {
  const problems = [];
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
    if (!DOC_IPV4.some((re) => re.test(m[0]))) problems.push('IPv4 fora das faixas de documentação: ' + m[0]);
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!/(^|\.)example\.com$/i.test(m[1])) problems.push('e-mail fora de example.com');
  }
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    if (!/(^|\.)example\.com$/i.test(m[1]) && m[1] !== 'example.atlassian.net') problems.push('host fora de example.com: ' + m[1]);
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) problems.push('GUID encontrado');
  if (/xox[bpa]-|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|-----BEGIN/.test(text)) problems.push('padrão de token/chave encontrado');
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{40,}/g)) {
    const s = m[0];
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) problems.push('string longa com cara de token');
  }
  if (/"allowUnauthorizedCerts":\s*true/.test(text)) problems.push('allowUnauthorizedCerts ligado');
  return problems;
}

function validateWorkflow(file, text) {
  const errors = [];
  let wf;
  try { wf = JSON.parse(text); } catch (e) { return ['JSON inválido: ' + e.message]; }
  if (typeof wf.name !== 'string' || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object') {
    return ['estrutura mínima ausente (name/nodes/connections)'];
  }
  const names = new Set();
  const ids = new Set();
  for (const n of wf.nodes) {
    if (names.has(n.name)) errors.push('nome de nó duplicado: ' + n.name);
    if (ids.has(n.id)) errors.push('id de nó duplicado: ' + n.id);
    names.add(n.name); ids.add(n.id);
    if (!/^n8n-nodes-base\.[A-Za-z]+$/.test(n.type)) errors.push('tipo de nó inesperado: ' + n.type);
    if (!Array.isArray(n.position) || n.position.length !== 2) errors.push('posição inválida: ' + n.name);
    for (const [type, ref] of Object.entries(n.credentials || {})) {
      const keys = Object.keys(ref || {});
      if (keys.length !== 1 || keys[0] !== 'name') errors.push('credencial deve ser referenciada só por nome: ' + n.name + ' / ' + type);
      if (!ALLOWED_CREDENTIALS.has(ref && ref.name)) errors.push('credencial desconhecida: ' + (ref && ref.name));
    }
    if (n.type === 'n8n-nodes-base.code') {
      try {
        new vm.Script('(async function(){\n' + n.parameters.jsCode + '\n})', { filename: file + ':' + n.name });
      } catch (e) {
        errors.push('código não compila em "' + n.name + '": ' + e.message);
      }
    }
  }
  const hasIn = new Set();
  const hasOut = new Set();
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push('conexão de nó inexistente: ' + from);
    hasOut.add(from);
    for (const outputs of Object.values(conn)) {
      for (const targets of outputs) {
        for (const t of targets || []) {
          if (!names.has(t.node)) errors.push('conexão para nó inexistente: ' + from + ' -> ' + t.node);
          hasIn.add(t.node);
        }
      }
    }
  }
  for (const n of wf.nodes) {
    if (!TRIGGER_TYPES.has(n.type) && !hasIn.has(n.name)) errors.push('nó sem entrada: ' + n.name);
    if (TRIGGER_TYPES.has(n.type) && !hasOut.has(n.name)) errors.push('gatilho sem saída: ' + n.name);
  }
  scanText(text).forEach((p) => errors.push(p));
  return errors;
}

function validateAll() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const report = {};
  for (const f of files) report[f] = validateWorkflow(f, fs.readFileSync(path.join(DIR, f), 'utf8'));
  return report;
}

if (require.main === module) {
  const report = validateAll();
  let failed = 0;
  for (const [f, errs] of Object.entries(report)) {
    const wf = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (errs.length) {
      failed += 1;
      console.error('FALHOU ' + f);
      errs.forEach((e) => console.error('  - ' + e));
    } else {
      console.log('ok     ' + f + ' (' + wf.nodes.length + ' nós, ' + Object.keys(wf.connections).length + ' origens de conexão)');
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { validateWorkflow, validateAll, scanText };
