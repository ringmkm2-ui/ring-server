const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function withEnv(env, fn) {
  const keys = ['RESEND_API_KEY', 'RESEND_API_URL', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  const saved = {}; keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  const restore = () => keys.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  return Promise.resolve().then(fn).finally(restore);
}
function stub(status, body) {
  return new Promise(res => {
    const got = [];
    const srv = http.createServer((req, rs) => {
      let b = ''; req.on('data', c => b += c);
      req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); rs.writeHead(status, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(body)); });
    }).listen(0, '127.0.0.1', () => res({ srv, got, url: 'http://127.0.0.1:' + srv.address().port + '/emails' }));
  });
}
const fresh = () => { delete require.cache[require.resolve('../utils/mailer')]; return require('../utils/mailer'); };

test('Resend: キーと送り元が揃えば設定済み。送り元が無ければ未設定扱い', async () => {
  await withEnv({ RESEND_API_KEY: 'k' }, () => assert.equal(fresh().isMailConfigured(), false));
  await withEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'Bro Chat <noreply@brochat.org>' }, () => assert.equal(fresh().isMailConfigured(), true));
  await withEnv({}, () => assert.equal(fresh().isMailConfigured(), false));
  await withEnv({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }, () => assert.equal(fresh().isMailConfigured(), true));
});

test('Resend: APIに正しい形で送る', async () => {
  const s = await stub(200, { id: 'x' });
  try {
    await withEnv({ RESEND_API_KEY: 'sekret', MAIL_FROM: 'Bro Chat <noreply@brochat.org>', RESEND_API_URL: s.url }, async () => {
      await fresh().sendMail({ to: 'a@example.com', subject: '件名', text: '本文 123456' });
    });
    assert.equal(s.got.length, 1);
    assert.equal(s.got[0].auth, 'Bearer sekret');
    assert.deepEqual(s.got[0].body, { from: 'Bro Chat <noreply@brochat.org>', to: ['a@example.com'], subject: '件名', text: '本文 123456' });
  } finally { s.srv.close(); }
});

test('Resend: 断られたら例外。メッセージにAPIキーは入らない', async () => {
  const s = await stub(403, { name: 'validation_error', message: 'The brochat.org domain is not verified' });
  try {
    await withEnv({ RESEND_API_KEY: 'sekret', MAIL_FROM: 'x@brochat.org', RESEND_API_URL: s.url }, async () => {
      await assert.rejects(fresh().sendMail({ to: 'a@example.com', subject: 's', text: 't' }), e => /Resend 403/.test(e.message) && /not verified/.test(e.message) && !/sekret/.test(e.message));
    });
  } finally { s.srv.close(); }
});

test('Resend: 繋がらなくても例外(握りつぶさない)', async () => {
  await withEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'x@brochat.org', RESEND_API_URL: 'http://127.0.0.1:1/emails' }, async () => {
    await assert.rejects(fresh().sendMail({ to: 'a@example.com', subject: 's', text: 't' }), /メール送信に失敗/);
  });
});
