'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validators');
const { ip4, PUBLIC_IP } = require('./helpers');

test('IPv4 público é aceito e normalizado', () => {
  assert.deepEqual(v.normalizePublicIp(PUBLIC_IP), { version: 4, address: PUBLIC_IP });
  assert.deepEqual(v.normalizePublicIp('  ' + PUBLIC_IP + ' '), { version: 4, address: PUBLIC_IP });
});

test('IPv4 privado, reservado e de documentação é recusado', () => {
  const blocked = [
    ip4(10, 1, 2, 3), ip4(172, 16, 0, 1), ip4(172, 31, 255, 255), ip4(192, 168, 1, 1),
    ip4(127, 0, 0, 1), ip4(0, 0, 0, 0), ip4(169, 254, 1, 1), ip4(100, 64, 0, 1),
    ip4(224, 0, 0, 1), ip4(255, 255, 255, 255), ip4(198, 18, 0, 1),
    '192.0.2.10', '198.51.100.7', '203.0.113.200',
  ];
  for (const ip of blocked) assert.equal(v.normalizePublicIp(ip), null, ip);
  // vizinhos das faixas bloqueadas continuam públicos
  assert.ok(v.isPublicIPv4(ip4(172, 32, 0, 1)));
  assert.ok(v.isPublicIPv4(ip4(100, 128, 0, 1)));
});

test('IPv4 malformado ou com tentativa de injeção é recusado', () => {
  const bad = [
    '', '203.0.113', '203.0.113.4.5', ip4(256, 1, 1, 1), ip4('08', 8, 4, 4), PUBLIC_IP + '/24', ' ' + PUBLIC_IP + ';id',
    PUBLIC_IP + '; rm -rf /', PUBLIC_IP + '$(id)', PUBLIC_IP + '\n' + PUBLIC_IP, '`id`', '0x' + PUBLIC_IP,
  ];
  for (const ip of bad) assert.equal(v.normalizePublicIp(ip), null, JSON.stringify(ip));
});

test('IPv6: só unicast global, forma canônica RFC 5952', () => {
  assert.deepEqual(v.normalizePublicIp('2A00:0000:0000::0001'), { version: 6, address: '2a00::1' });
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:' + PUBLIC_IP, 'fe80::1%eth0', '2a00::1::2', '2a00::g']) {
    assert.equal(v.normalizePublicIp(ip), null, ip);
  }
  assert.equal(v.formatIPv6(v.parseIPv6('2001:db8:0:0:1:0:0:1')), '2001:db8::1:0:0:1');
});

test('e-mail: formato simplificado, minúsculas, sem caracteres de shell', () => {
  assert.deepEqual(v.parseEmail('Joao.Silva@Cliente-A.Example.com'), {
    local: 'joao.silva', domain: 'cliente-a.example.com', address: 'joao.silva@cliente-a.example.com',
  });
  for (const e of ['joao', 'a@b', 'a..b@example.com', ".a@example.com", "x'@example.com", 'x;id@example.com', 'x@example.com;id', 'x y@example.com', 'x@@example.com', '$(id)@example.com']) {
    assert.equal(v.parseEmail(e), null, e);
  }
});

test('usuário cPanel: regex estrita e nomes de sistema recusados', () => {
  assert.ok(v.isValidCpanelUser('clientea'));
  assert.ok(v.isValidCpanelUser('a1234567890bcdef'));
  for (const u of ['root', 'nobody', '1abc', 'Abc', 'a-b', 'a_b', 'abcdefghijklmnopq', '', 'a b', 'a;id']) {
    assert.equal(v.isValidCpanelUser(u), false, u);
  }
});

test('hostname e chave de card', () => {
  assert.ok(v.isValidHostname('cliente-a.example.com'));
  for (const h of ['localhost', '-a.example.com', 'a..example.com', 'EXAMPLE.com', 'a.example.123', 'a_b.example.com']) {
    assert.equal(v.isValidHostname(h), false, h);
  }
  assert.ok(v.isValidIssueKey('OPS-101'));
  for (const k of ['ops-1', 'OPS-0', 'OPS-1/../x', 'OPS-1?x=1', '']) assert.equal(v.isValidIssueKey(k), false, k);
});
