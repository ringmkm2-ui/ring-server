// テスト用の小道具: 届いたメールを覚えておくだけのSMTPサーバー(外には送らない)。
// メール認証やパスワード再設定のコードを、テストの中で受け取るために使う。
const net = require('net');

function startSmtpSink() {
  const mails = [];
  const server = net.createServer(sock => {
    let buf = '';
    let inData = false;
    let cur = { to: [], body: '' };
    const say = l => sock.write(l + '\r\n');
    say('220 sink ESMTP');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push(cur);
            cur = { to: [], body: '' };
            say('250 ok');
          } else {
            cur.body += line.replace(/^\.\./, '.') + '\n';
          }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { sock.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
        else if (up.startsWith('HELO')) say('250 sink');
        else if (up.startsWith('AUTH PLAIN')) say('235 ok');
        else if (up.startsWith('AUTH LOGIN')) { say('334 VXNlcm5hbWU6'); sock.once('data', () => { say('334 UGFzc3dvcmQ6'); sock.once('data', () => say('235 ok')); }); }
        else if (up.startsWith('MAIL FROM')) say('250 ok');
        else if (up.startsWith('RCPT TO')) { cur.to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, '$1')); say('250 ok'); }
        else if (up === 'DATA') { inData = true; say('354 go'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else if (up === 'RSET' || up === 'NOOP') say('250 ok');
        else if (line) say('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // 本文はquoted-printable/base64のことがあるので、6桁の数字を両方の形から探す
      const decode = body => {
        let out = body;
        const b64 = body.split('\n').filter(l => /^[A-Za-z0-9+/=]{16,}$/.test(l)).join('');
        if (b64) { try { out += '\n' + Buffer.from(b64, 'base64').toString('utf8'); } catch (_) {} }
        return out.replace(/=\r?\n/g, '');
      };
      const lastCode = to => {
        for (let k = mails.length - 1; k >= 0; k--) {
          if (mails[k].to.includes(to)) {
            const m = /\b(\d{6})\b/.exec(decode(mails[k].body));
            if (m) return m[1];
          }
        }
        return null;
      };
      resolve({
        port,
        mails,
        lastCode,
        env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'sink', SMTP_PASS: 'sink', MAIL_FROM: 'Bro Chat <sink@example.com>' },
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

module.exports = { startSmtpSink };
