'use strict';
// Gerador de senha com CSPRNG (crypto.randomInt), sem padrão fixo, sem
// nome do cliente e sem ano. No n8n, exige NODE_FUNCTION_ALLOW_BUILTIN=crypto.

const nodeCrypto = require('crypto');

const PW_CLASSES = Object.freeze([
  'abcdefghijkmnopqrstuvwxyz', // sem "l" (confunde com 1)
  'ABCDEFGHJKLMNPQRSTUVWXYZ',  // sem "I" e "O"
  '23456789',                  // sem 0 e 1
  '-_.!*+=%^~',                // símbolos que não exigem escape em formulário
]);
const PW_ALPHABET = PW_CLASSES.join('');

function generatePassword(options) {
  const length = (options && options.length) || 20;
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new Error('password: comprimento deve estar entre 16 e 128');
  }
  // Amostragem uniforme sobre o alfabeto inteiro; se faltar alguma classe,
  // descarta e sorteia de novo (rejeição mantém a distribuição uniforme).
  for (let attempt = 0; attempt < 100; attempt++) {
    let pw = '';
    for (let i = 0; i < length; i++) pw += PW_ALPHABET[nodeCrypto.randomInt(PW_ALPHABET.length)];
    if (PW_CLASSES.every((cls) => [...pw].some((c) => cls.includes(c)))) return pw;
  }
  throw new Error('password: falha ao gerar senha');
}

function passwordEntropyBits(length) {
  return Math.floor(length * Math.log2(PW_ALPHABET.length));
}

/** Identificador opaco (ex.: correlação de auditoria), via randomBytes. */
function randomId(bytes) {
  return nodeCrypto.randomBytes(bytes || 12).toString('hex');
}

module.exports = { generatePassword, passwordEntropyBits, randomId, PW_ALPHABET, PW_CLASSES };
