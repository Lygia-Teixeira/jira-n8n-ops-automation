'use strict';
// Inventório: fonte da verdade sobre quais contas existem, em qual servidor
// estão, quais domínios pertencem a cada conta e quem é o contato responsável.
// O texto do card nunca decide servidor nem dono de domínio: só o inventário.

const { isValidCpanelUser, isValidHostname, parseEmail } = require('./validators');
const { normalizeKey } = require('./text');

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parseInventory(raw) {
  let inv = raw;
  if (typeof raw === 'string') {
    try { inv = JSON.parse(raw); } catch (e) { throw new Error('inventory: JSON inválido'); }
  }
  if (!inv || typeof inv !== 'object') throw new Error('inventory: objeto ausente');
  const servers = inv.servers || {};
  const accounts = inv.accounts || {};
  for (const [name, srv] of Object.entries(servers)) {
    if (!SERVER_NAME_RE.test(name)) throw new Error('inventory: nome de servidor inválido');
    if (!srv || !isValidHostname(srv.host)) throw new Error('inventory: host inválido em ' + name);
  }
  const aliasIndex = new Map();
  for (const [user, acc] of Object.entries(accounts)) {
    if (!isValidCpanelUser(user)) throw new Error('inventory: usuário cPanel inválido');
    if (!acc || !servers[acc.server]) throw new Error('inventory: servidor desconhecido para ' + user);
    if (!Array.isArray(acc.domains) || !acc.domains.every(isValidHostname)) {
      throw new Error('inventory: domínios inválidos para ' + user);
    }
    if (acc.contact !== undefined && !parseEmail(acc.contact)) {
      throw new Error('inventory: contato inválido para ' + user);
    }
    for (const alias of [user, ...(acc.aliases || [])]) {
      const k = normalizeKey(alias);
      if (!k) continue;
      if (!aliasIndex.has(k)) aliasIndex.set(k, new Set());
      aliasIndex.get(k).add(user);
    }
  }
  return { servers, accounts, aliasIndex };
}

/**
 * Resolve o campo "Cliente" do card para uma conta do inventário.
 * Correspondência exata (usuário ou alias normalizado). Sem busca por
 * substring: "ana" nunca deve casar com "mariana".
 */
function resolveAccount(inventory, value) {
  const k = normalizeKey(value || '');
  if (!k) return { status: 'missing' };
  const users = inventory.aliasIndex.get(k);
  if (!users || users.size === 0) return { status: 'not_found' };
  if (users.size > 1) return { status: 'ambiguous' };
  const user = [...users][0];
  const account = inventory.accounts[user];
  return { status: 'ok', user, account, server: account.server, host: inventory.servers[account.server].host };
}

function accountOwnsDomain(account, domain) {
  return Array.isArray(account.domains) && account.domains.includes(domain);
}

/** Domínio (ou subdomínio) -> conta dona, pelo sufixo mais longo em fronteira de rótulo. */
function findAccountByHostname(inventory, hostname) {
  let best = null;
  for (const [user, acc] of Object.entries(inventory.accounts)) {
    for (const d of acc.domains) {
      if (hostname === d || hostname.endsWith('.' + d)) {
        if (!best || d.length > best.domain.length) best = { user, domain: d, server: acc.server };
      }
    }
  }
  if (!best) return null;
  return { ...best, host: inventory.servers[best.server].host };
}

module.exports = { parseInventory, resolveAccount, accountOwnsDomain, findAccountByHostname };
