'use strict';
// Extração de texto do card (Atlassian Document Format) e leitura de campos
// estruturados no formato "Chave: valor", um por linha.

const MAX_TEXT_LENGTH = 20000;

function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node.slice(0, MAX_TEXT_LENGTH);
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (n.type === 'hardBreak') out.push('\n');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type)) out.push('\n');
  };
  walk(node);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT_LENGTH);
}

function normalizeKey(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Nome canônico do campo -> variações aceitas no template do card
const FIELD_ALIASES = {
  cliente: ['cliente', 'contacpanel', 'usuariocpanel', 'usuario'],
  ip: ['ip', 'enderecoip', 'ipbloqueado'],
  email: ['email', 'contadeemail', 'caixapostal', 'conta'],
  atividade: ['atividade', 'tipo', 'tipodeatividade'],
  periodo: ['periodo'],
};

const ALIAS_TO_FIELD = Object.entries(FIELD_ALIASES).reduce((acc, [field, aliases]) => {
  aliases.forEach((a) => { acc[a] = field; });
  return acc;
}, {});

/**
 * Lê linhas "Chave: valor". Só campos conhecidos são considerados; um campo
 * repetido com valores diferentes é marcado como ambíguo (o card é recusado).
 */
function parseFields(text) {
  const fields = {};
  const ambiguous = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*[-*]?\s*([^:]{1,40}):\s*(.{1,320}?)\s*$/);
    if (!m) return;
    const field = ALIAS_TO_FIELD[normalizeKey(m[1])];
    if (!field) return;
    const value = m[2].trim();
    if (fields[field] !== undefined && fields[field] !== value) ambiguous.add(field);
    else fields[field] = value;
  });
  return { fields, ambiguous: [...ambiguous] };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

module.exports = { adfToText, normalizeKey, normalizeText, parseFields, FIELD_ALIASES };
