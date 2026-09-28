// utils/mailer.js
// メール送信(SMTP)。環境変数が揃っていない場合は isMailConfigured() が false になり、
// 呼び出し側はメール認証をスキップする(未設定のまま登録が全員止まる事故を防ぐ)。
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
// Gmailなら SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, アプリパスワードをSMTP_PASSに。
let transporter = null;

function isMailConfigured() {
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
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const from = process.env.MAIL_FROM || `Bro Chat <${process.env.SMTP_USER}>`;
  await getTransporter().sendMail({ from, to, subject, text });
}

module.exports = { isMailConfigured, sendMail };
