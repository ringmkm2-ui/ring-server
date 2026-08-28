// routes/callAssist.js
// -----------------------------------------------------------------------
// Call Assist機能: 通話中のリアルタイム翻訳・通話メモ・通話後の要約。
// 翻訳/要約はAnthropic APIを使う(追加の外部サービス契約が不要なため)。
// 音声認識(文字起こし)はDeepgramをWS経由で行う(ws/callAssistProxy.js参照)。
// -----------------------------------------------------------------------
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { sendServerError } = require('../utils/errorResponse');

const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// 1リクエストあたりの文字数上限(通話メモ・字幕ログの異常な巨大化を防ぐ)
const MAX_TEXT_LENGTH = 20000;

async function callAnthropic(systemPrompt, userText) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が未設定です');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic APIエラー (status=${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// --- リアルタイム翻訳 ---
// body: { text, targetLanguage }  targetLanguage例: '英語','日本語','中国語'
router.post('/translate', verifyToken, asyncHandler(async (req, res) => {
  const { text, targetLanguage } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'textが必要です' });
  }
  if (text.length > 1000) {
    return res.status(413).json({ error: '翻訳対象のテキストが長すぎます' });
  }
  const lang = (targetLanguage || '英語').slice(0, 30);

  try {
    const translated = await callAnthropic(
      `あなたは通話字幕のリアルタイム翻訳者です。与えられた発言を${lang}に翻訳してください。` +
      `翻訳結果の文章だけを出力し、説明や前置きは一切付けないでください。`,
      text
    );
    res.json({ translated: translated.trim() });
  } catch (e) {
    sendServerError(res, e, 'callAssist.translate');
  }
}));

// --- 通話メモの保存 ---
// body: { callId, otherId, content }
router.post('/notes', verifyToken, asyncHandler(async (req, res) => {
  const { callId, otherId, content } = req.body;
  if (!callId || typeof content !== 'string') {
    return res.status(400).json({ error: 'callIdとcontentが必要です' });
  }
  if (content.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({ error: 'メモが長すぎます' });
  }

  const existing = await db.get(
    'SELECT id FROM call_notes WHERE call_id = ? AND owner_id = ?',
    [callId, req.user.userId]
  );
  if (existing) {
    await db.run(
      'UPDATE call_notes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [content, existing.id]
    );
  } else {
    await db.run(
      'INSERT INTO call_notes (id, call_id, owner_id, other_id, content) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), callId, req.user.userId, otherId || null, content]
    );
  }
  res.json({ ok: true });
}));

// --- 通話メモの取得 ---
router.get('/notes/:callId', verifyToken, asyncHandler(async (req, res) => {
  const note = await db.get(
    'SELECT content, updated_at FROM call_notes WHERE call_id = ? AND owner_id = ?',
    [req.params.callId, req.user.userId]
  );
  res.json({ content: note ? note.content : '', updatedAt: note ? note.updated_at : null });
}));

// --- 自分の通話メモ一覧(最新順) ---
router.get('/notes', verifyToken, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const notes = await db.all(
    `SELECT cn.call_id, cn.content, cn.updated_at, cn.other_id,
            u.display_name AS other_name, u.profile_pic AS other_pic
     FROM call_notes cn
     LEFT JOIN users u ON u.id = cn.other_id
     WHERE cn.owner_id = ?
     ORDER BY cn.updated_at DESC LIMIT ?`,
    [req.user.userId, limit]
  );
  res.json(notes);
}));

// --- 通話終了後の要約生成 ---
// body: { callId, otherId, transcriptLog }  transcriptLog: 字幕ログの配列 [{speaker, text}]
router.post('/summarize', verifyToken, asyncHandler(async (req, res) => {
  const { callId, otherId, transcriptLog } = req.body;
  if (!callId || !Array.isArray(transcriptLog) || transcriptLog.length === 0) {
    return res.status(400).json({ error: 'callIdとtranscriptLogが必要です' });
  }

  const logText = transcriptLog
    .map((entry) => `${entry.speaker || '不明'}: ${entry.text || ''}`)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);

  try {
    const summary = await callAnthropic(
      'あなたは通話の字幕ログから要約を作るアシスタントです。' +
      '以下の会話ログを読み、要点を3〜6個の箇条書きで日本語にまとめてください。' +
      '雑談的な相槌は除き、決定事項・依頼事項・重要な情報を優先してください。',
      logText
    );

    // 要約はメモと同じテーブルに「要約」として保存しておく(履歴として残す)
    const existing = await db.get(
      'SELECT id FROM call_summaries WHERE call_id = ? AND owner_id = ?',
      [callId, req.user.userId]
    );
    if (existing) {
      await db.run('UPDATE call_summaries SET summary = ? WHERE id = ?', [summary, existing.id]);
    } else {
      await db.run(
        'INSERT INTO call_summaries (id, call_id, owner_id, other_id, summary) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), callId, req.user.userId, otherId || null, summary]
      );
    }

    res.json({ summary: summary.trim() });
  } catch (e) {
    sendServerError(res, e, 'callAssist.summarize');
  }
}));

// --- 通話要約一覧の取得 ---
router.get('/summaries', verifyToken, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const summaries = await db.all(
    `SELECT cs.call_id, cs.summary, cs.created_at, cs.other_id,
            u.display_name AS other_name, u.profile_pic AS other_pic
     FROM call_summaries cs
     LEFT JOIN users u ON u.id = cs.other_id
     WHERE cs.owner_id = ?
     ORDER BY cs.created_at DESC LIMIT ?`,
    [req.user.userId, limit]
  );
  res.json(summaries);
}));

module.exports = router;
