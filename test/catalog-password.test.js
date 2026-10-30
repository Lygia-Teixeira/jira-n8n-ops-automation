'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalogCommand, shQuote } = require('../src/catalog');
const { generatePassword, passwordEntropyBits, PW_ALPHABET, PW_CLASSES, randomId } = require('../src/password');
const { PUBLIC_IP } = require('./helpers');

test('catálogo: monta linha para forced-command e para sudo-wrapper', () => {
  assert.equal(buildCatalogCommand('ip-unblock', [PUBLIC_IP], 'forced-command'), 'ip-unblock ' + PUBLIC_IP);
  assert.equal(
    buildCatalogCommand('mail-quota-increase', ['clientea', 'joao', 'cliente-a.example.com'], 'sudo-wrapper'),
    "sudo -n /usr/local/sbin/ops-catalog 'mail-quota-increase' 'clientea' 'joao' 'cliente-a.example.com'",
  );
});

test('catálogo: comando fora do catálogo é recusado', () => {
  assert.throws(() => buildCatalogCommand('rm', ['-rf', 'x'], 'forced-command'), /desconhecido/);
  assert.throws(() => buildCatalogCommand('ip-unblock', [PUBLIC_IP], 'bash'), /modo/);
});

test('catálogo: argumentos com metacaracteres nunca saem do n8n', () => {
  const payloads = [
    PUBLIC_IP + '; id', '$(id)', '`id`', "a'b", 'a b', 'a\nb', '-rf', '', '|id', 'a&&b', 'a>b', '../etc', '*',
  ];
  for (const p of payloads) {
    assert.throws(() => buildCatalogCommand('ip-unblock', [p], 'forced-command'), /charset/, JSON.stringify(p));
    assert.throws(() => buildCatalogCommand('ip-unblock', [p], 'sudo-wrapper'), /charset/, JSON.stringify(p));
  }
});

test('shQuote: aspas simples escapadas corretamente', () => {
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote('$(id)'), "'$(id)'");
});

test('senha: comprimento, classes e alfabeto', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 20 });
    assert.equal(pw.length, 20);
    assert.ok([...pw].every((c) => PW_ALPHABET.includes(c)));
    assert.ok(PW_CLASSES.every((cls) => [...pw].some((c) => cls.includes(c))));
  }
  assert.throws(() => generatePassword({ length: 8 }));
  assert.ok(passwordEntropyBits(20) >= 120);
});

test('senha: sem repetição e sem padrão fixo', () => {
  const set = new Set(Array.from({ length: 500 }, () => generatePassword({ length: 20 })));
  assert.equal(set.size, 500);
  // nenhuma posição fica constante entre senhas (ex.: sufixo fixo)
  const sample = [...set];
  for (let pos = 0; pos < 20; pos++) {
    const chars = new Set(sample.map((s) => s[pos]));
    assert.ok(chars.size > 10, 'posição ' + pos + ' com pouca variação');
  }
});

test('randomId usa bytes aleatórios em hex', () => {
  assert.match(randomId(8), /^[0-9a-f]{16}$/);
  assert.notEqual(randomId(), randomId());
});
