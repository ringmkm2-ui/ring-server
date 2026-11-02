const { test } = require('node:test');
const assert = require('node:assert/strict');
const { knownBase, SITE_HOSTS, SITE_ORIGINS } = require('../utils/siteHosts');
const { isValidIconUrl, baseUrl } = require('../utils/iconStore');

const req = host => ({ get: h => (h === 'host' ? host : undefined), protocol: 'https' });
const ID = '12345678-1234-1234-1234-123456789abc';

test('独自ドメインのホストはそのまま採用し、知らないホストは採用しない', () => {
  assert.equal(knownBase(req('brochat.org')), 'https://brochat.org');
  assert.equal(knownBase(req('BroChat.org')), 'https://brochat.org');
  assert.equal(knownBase(req('ring-server-50sy.onrender.com')), 'https://ring-server-50sy.onrender.com');
  assert.equal(knownBase(req('evil.example.com')), null);
  assert.equal(knownBase(req('brochat.org.evil.com')), null);
  assert.equal(knownBase(req('')), null);
  assert.ok(SITE_HOSTS.includes('www.brochat.org') && SITE_ORIGINS.includes('https://brochat.org'));
});

test('アイコンURL: 独自ドメインから元のURLのアイコンを保存し直せるが、他人のホストは弾く', () => {
  const r = req('brochat.org');
  assert.equal(baseUrl(r), 'https://brochat.org');
  assert.equal(isValidIconUrl(`https://brochat.org/icons/${ID}`, r), true);
  assert.equal(isValidIconUrl(`https://ring-server-50sy.onrender.com/icons/${ID}`, r), true);
  assert.equal(isValidIconUrl(`https://evil.example.com/icons/${ID}`, r), false);
});
