'use strict';
// Catálogo fixo de operações. A automação nunca monta shell livre: ela
// escolhe uma entrada daqui e passa argumentos já validados. No servidor,
// o wrapper server/ops-catalog.sh valida tudo de novo (defesa em profundidade).

const CATALOG = Object.freeze({
  ip_unblock: Object.freeze({
    executor: 'ssh',
    command: 'ip-unblock',
    label: 'Desbloqueio de IP no firewall',
  }),
  mail_quota_increase: Object.freeze({
    executor: 'ssh',
    command: 'mail-quota-increase',
    label: 'Aumento de cota de e-mail',
  }),
  mail_password_reset: Object.freeze({
    executor: 'whm',
    label: 'Redefinição de senha de e-mail',
    deliversSecret: true,
  }),
  usage_report: Object.freeze({
    executor: 'manual',
    label: 'Relatório de usabilidade',
  }),
});

// Comandos internos (não acionáveis por card), usados por outros workflows
const INTERNAL_COMMANDS = Object.freeze(['ssl-autossl']);

const SAFE_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const WRAPPER_PATH = '/usr/local/sbin/ops-catalog';

/** Quoting POSIX: tudo entre aspas simples; aspas simples internas viram '\'' */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function knownCommand(commandId) {
  return INTERNAL_COMMANDS.includes(commandId) ||
    Object.values(CATALOG).some((e) => e.command === commandId);
}

/**
 * Monta a linha enviada pelo nó SSH.
 * - forced-command: a chave SSH do bot só executa o wrapper (authorized_keys
 *   command=...), que recebe a linha em SSH_ORIGINAL_COMMAND. Os argumentos
 *   precisam ser de um charset seguro, sem espaço nem aspas.
 * - sudo-wrapper: chama o wrapper via sudo, com cada argumento entre aspas.
 * Nos dois modos, argumento fora do charset seguro é recusado antes de sair do n8n.
 */
function buildCatalogCommand(commandId, args, mode) {
  if (!knownCommand(commandId)) throw new Error('catalog: comando desconhecido');
  if (!Array.isArray(args)) throw new Error('catalog: argumentos inválidos');
  for (const a of args) {
    if (typeof a !== 'string' || !SAFE_ARG_RE.test(a)) throw new Error('catalog: argumento fora do charset seguro');
  }
  const argv = [commandId, ...args];
  if (mode === 'forced-command') return argv.join(' ');
  if (mode === 'sudo-wrapper') return ['sudo', '-n', WRAPPER_PATH, ...argv.map(shQuote)].join(' ');
  throw new Error('catalog: modo SSH desconhecido');
}

module.exports = { CATALOG, INTERNAL_COMMANDS, SAFE_ARG_RE, shQuote, buildCatalogCommand };
