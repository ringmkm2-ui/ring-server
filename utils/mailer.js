// utils/mailer.js
// メール送信。送り方は2通りで、環境変数が揃っていない場合は isMailConfigured() が false になり、
// 呼び出し側はメール認証をスキップする(未設定のまま登録が全員止まる事故を防ぐ)。
//
// 1) Resend(HTTPS)  ← Render の無料プランはSMTPのポートを塞いでいるので、本番はこちら
//      RESEND_API_KEY / MAIL_FROM (例: "Bro Chat <noreply@brochat.org>"。brochat.org をResendで認証しておく)
// 2) SMTP(有料プランやローカル用)
//      SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
//      Gmailなら SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, アプリパスワードをSMTP_PASSに。
// RESEND_API_KEY があればそちらを使う。
let transporter = null;

const SEND_TIMEOUT_MS = 10000;

function useResend() { return !!process.env.RESEND_API_KEY; }

function isMailConfigured() {
  if (useResend()) return !!process.env.MAIL_FROM;          // 送り元が無いとResendは必ず断るので、揃うまでは「未設定」扱い
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS * 2,
  });
  return transporter;
}

async function sendViaResend({ to, subject, text }) {
  const url = process.env.RESEND_API_URL || 'https://api.resend.com/emails';   // RESEND_API_URL はテスト用
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error('メール送信に失敗(' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network') + ')');
  } finally { clearTimeout(tm); }
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = (j && (j.message || j.name)) || ''; } catch (_) {}
    throw new Error('メール送信に失敗(Resend ' + r.status + (msg ? ': ' + String(msg).slice(0, 160) : '') + ')');
  }
}

async function sendMail({ to, subject, text }) {
  if (useResend()) return sendViaResend({ to, subject, text });
  const from = process.env.MAIL_FROM || `Bro Chat <${process.env.SMTP_USER}>`;
  await getTransporter().sendMail({ from, to, subject, text });
}

module.exports = { isMailConfigured, sendMail };
