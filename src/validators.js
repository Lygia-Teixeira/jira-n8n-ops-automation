'use strict';
// Validadores estritos para todo valor que vem do texto de um card.
// Regra geral: se não passar aqui, não vira argumento de comando.

const CPANEL_USER_RE = /^[a-z][a-z0-9]{0,15}$/;
const RESERVED_SYSTEM_USERS = new Set([
  'root', 'admin', 'nobody', 'cpanel', 'cpanelphpmyadmin', 'cpses', 'mail', 'mailman',
  'mysql', 'named', 'system', 'daemon', 'bin', 'sys', 'sshd', 'ftp', 'apache', 'www',
]);

function isValidCpanelUser(value) {
  return typeof value === 'string' && CPANEL_USER_RE.test(value) && !RESERVED_SYSTEM_USERS.has(value);
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,6}$/;

function isValidIssueKey(value) {
  return typeof value === 'string' && ISSUE_KEY_RE.test(value);
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{1,59}$/.test(tld);
}

// ---------------------------------------------------------------------------
// E-mail (RFC simplificado, só o que uma caixa cPanel aceita na prática)
// ---------------------------------------------------------------------------
const MAIL_LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function parseEmail(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v.length > 254) return null;
  const parts = v.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!MAIL_LOCAL_RE.test(local) || local.includes('..')) return null;
  if (!isValidHostname(domain)) return null;
  return { local, domain, address: local + '@' + domain };
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------
function parseIPv4(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const p of parts) {
    // sem zeros à esquerda (evita ambiguidade octal) e só dígitos
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

// Faixas especiais (RFC 6890 e correlatas) escritas como octetos para manter
// o repositório livre de endereços em notação pontuada fora das faixas de documentação.
const IPV4_SPECIAL = [
  { base: [0, 0, 0, 0], bits: 8 },        // "this network"
  { base: [10, 0, 0, 0], bits: 8 },       // RFC 1918
  { base: [100, 64, 0, 0], bits: 10 },    // CGNAT
  { base: [127, 0, 0, 0], bits: 8 },      // loopback
  { base: [169, 254, 0, 0], bits: 16 },   // link-local
  { base: [172, 16, 0, 0], bits: 12 },    // RFC 1918
  { base: [192, 0, 0, 0], bits: 24 },     // IETF protocol assignments
  { base: [192, 0, 2, 0], bits: 24 },     // TEST-NET-1
  { base: [192, 88, 99, 0], bits: 24 },   // 6to4 relay anycast
  { base: [192, 168, 0, 0], bits: 16 },   // RFC 1918
  { base: [198, 18, 0, 0], bits: 15 },    // benchmarking
  { base: [198, 51, 100, 0], bits: 24 },  // TEST-NET-2
  { base: [203, 0, 113, 0], bits: 24 },   // TEST-NET-3
  { base: [224, 0, 0, 0], bits: 4 },      // multicast
  { base: [240, 0, 0, 0], bits: 4 },      // reservado + broadcast
];

function ipv4ToInt(o) {
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function ipv4InRange(octets, range) {
  const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
  return ((ipv4ToInt(octets) & mask) >>> 0) === ((ipv4ToInt(range.base) & mask) >>> 0);
}

function isPublicIPv4(value) {
  const o = parseIPv4(value);
  if (!o) return false;
  return !IPV4_SPECIAL.some((r) => ipv4InRange(o, r));
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------
function parseIPv6(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  let v = value.trim().toLowerCase();
  if (v.includes('%')) return null; // zone id não é aceito
  const lastColon = v.lastIndexOf(':');
  if (lastColon !== -1 && v.slice(lastColon + 1).includes('.')) {
    // IPv4 embutido no fim (ex.: ::ffff:a.b.c.d) vira dois grupos hexadecimais
    const v4 = parseIPv4(v.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    v = v.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const doubleColon = v.split('::');
  if (doubleColon.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const head = toGroups(doubleColon[0]);
  const rest = doubleColon.length === 2 ? toGroups(doubleColon[1]) : [];
  const hexOk = (g) => /^[0-9a-f]{1,4}$/.test(g);
  if (!head.every(hexOk) || !rest.every(hexOk)) return null;
  const explicit = head.length + rest.length;
  let groups;
  if (doubleColon.length === 2) {
    if (explicit > 7) return null;
    groups = [...head, ...Array(8 - explicit).fill('0'), ...rest].map((g) => parseInt(g, 16));
  } else {
    if (explicit !== 8) return null;
    groups = [...head, ...rest].map((g) => parseInt(g, 16));
  }
  return groups.length === 8 ? groups : null;
}

function formatIPv6(groups) {
  // RFC 5952: minúsculas, sem zeros à esquerda, comprime a maior sequência (>=2) de zeros
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return left + '::' + right;
}

const IPV6_SPECIAL = [
  ['2001::', 23],      // IETF protocol assignments (inclui Teredo)
  ['2001:db8::', 32],  // documentação
  ['2002::', 16],      // 6to4
].map(([p, bits]) => ({ groups: parseIPv6(p), bits }));

function ipv6InPrefix(groups, prefix) {
  let bits = prefix.bits;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (prefix.groups[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

function isPublicIPv6(value) {
  const g = parseIPv6(value);
  if (!g) return false;
  // somente unicast global (2000::/3), menos as faixas especiais acima
  if ((g[0] & 0xe000) !== 0x2000) return false;
  return !IPV6_SPECIAL.some((p) => ipv6InPrefix(g, p));
}

/**
 * Normaliza e valida um IP para desbloqueio. Retorna a forma canônica ou null.
 * Só aceita endereços públicos: desbloquear faixa privada/reservada não faz
 * sentido operacional e costuma ser sinal de erro ou abuso.
 */
function normalizePublicIp(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.includes(':')) {
    const g = parseIPv6(v);
    if (!g || !isPublicIPv6(v)) return null;
    return { version: 6, address: formatIPv6(g) };
  }
  if (!isPublicIPv4(v)) return null;
  return { version: 4, address: v };
}

module.exports = {
  isValidCpanelUser,
  isValidIssueKey,
  isValidHostname,
  parseEmail,
  parseIPv4,
  isPublicIPv4,
  parseIPv6,
  formatIPv6,
  isPublicIPv6,
  normalizePublicIp,
};
