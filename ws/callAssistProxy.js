// ws/callAssistProxy.js
// -----------------------------------------------------------------------
// Call Assist機能(リアルタイム字幕・翻訳)のためのDeepgram中継プロキシ。
//
// 以前はクライアント側(public/js/deepgramVoice.js)にDeepgram APIキーを
// 直接渡し、ブラウザから直接 wss://api.deepgram.com に接続していた。
// これは (1) APIキーがクライアントJSに露出する重大な機密情報漏洩、
// (2) 実際には認証ヘッダーが未設定でWS接続自体が機能していなかった、
// という2つの問題を抱えていた。
//
// このモジュールはBro ChatのWSサーバーに相乗りする形で、クライアントの
// 音声チャンクをサーバー側でDeepgramへ中継し、文字起こし結果だけを
// クライアントへ返す。DeepgramのAPIキーはサーバーの環境変数にのみ存在し、
// クライアントには一切渡らない。
// -----------------------------------------------------------------------
const WebSocket = require('ws');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

function isDeepgramConfigured() {
  return !!DEEPGRAM_API_KEY;
}

// クライアントごとのDeepgram WS接続を管理する。
// key: クライアント接続を識別するための任意のID(通話ID等)
const activeSessions = new Map();
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;
// 1人が同時に持てる字幕セッション(自分の声+相手の声で2本)。以前は端末を8台つなげば16本開けた
const MAX_SESSIONS_PER_USER = 2;
// 音声は実時間ぶん(16kHz・16bit = 32KB/秒)より速くは流させない。速く送れば実時間より速く課金されるため
const AUDIO_BYTES_PER_SEC = 32000;
const AUDIO_BURST_BYTES = 128 * 1024;
const sessionMeta = new Map(); // sessionId -> { owner, tokens, last }
function sessionsOf(owner) {
  let n = 0;
  for (const [id, m] of sessionMeta) if (m.owner === owner && activeSessions.has(id)) n++;
  return n;
}

/**
 * クライアントの音声ストリーミングセッションを開始する。
 * onTranscript(text, isFinal) が呼ばれるたびに文字起こし結果を通知する。
 */
function startSession(sessionId, { language = 'ja', onTranscript, onError, onClose, owner } = {}) {
  if (!isDeepgramConfigured()) {
    if (onError) onError(new Error('DEEPGRAM_API_KEY が未設定です'));
    return null;
  }
  if (activeSessions.has(sessionId)) {
    stopSession(sessionId);
  }
  owner = owner || String(sessionId).split(':')[0];
  if (sessionsOf(owner) >= MAX_SESSIONS_PER_USER) {
    if (onError) onError(new Error('字幕は同時に2つまでです'));
    return null;
  }
  sessionMeta.set(sessionId, { owner, tokens: AUDIO_BURST_BYTES, last: Date.now() });

  const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${encodeURIComponent(language)}&encoding=linear16&sample_rate=16000&interim_results=true`;
  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgWs.on('open', () => {
    console.log(`[callAssist] Deepgramセッション開始: ${sessionId}`);
  });

  dgWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      const isFinal = !!data.is_final;
      if (transcript && onTranscript) {
        onTranscript(transcript, isFinal);
      }
    } catch (e) {
      console.error('[callAssist] Deepgramレスポンス解析エラー:', e.message);
    }
  });

  dgWs.on('error', (err) => {
    console.error(`[callAssist] Deepgram WSエラー (${sessionId}):`, err.message);
    if (onError) onError(err);
  });

  dgWs.on('close', () => {
    console.log(`[callAssist] Deepgramセッション終了: ${sessionId}`);
    // 同じIDで作り直された新しいセッションを、古い方のcloseで消さない
    if (activeSessions.get(sessionId) === dgWs) { activeSessions.delete(sessionId); sessionMeta.delete(sessionId); }
    if (onClose) onClose();
  });

  // 切り忘れ・悪用で音声を流しっぱなしにされても、課金が際限なく増えないよう2時間で必ず止める
  const maxTimer = setTimeout(() => stopSession(sessionId), MAX_SESSION_MS);
  maxTimer.unref();
  dgWs.on('close', () => clearTimeout(maxTimer));

  activeSessions.set(sessionId, dgWs);
  return dgWs;
}

/**
 * クライアントから受け取った音声チャンク(PCM16 buffer)をDeepgramへ転送する。
 */
function sendAudioChunk(sessionId, audioBuffer) {
  const dgWs = activeSessions.get(sessionId);
  const meta = sessionMeta.get(sessionId);
  if (!dgWs || dgWs.readyState !== WebSocket.OPEN || !meta) return false;
  const now = Date.now();
  meta.tokens = Math.min(AUDIO_BURST_BYTES, meta.tokens + (now - meta.last) * AUDIO_BYTES_PER_SEC / 1000);
  meta.last = now;
  if (audioBuffer.length > meta.tokens) return false; // 実時間より速い分は捨てる
  meta.tokens -= audioBuffer.length;
  dgWs.send(audioBuffer);
  return true;
}

function stopSession(sessionId) {
  const dgWs = activeSessions.get(sessionId);
  if (dgWs) {
    try { dgWs.close(); } catch (e) {}
    activeSessions.delete(sessionId);
  }
  sessionMeta.delete(sessionId);
}

module.exports = { startSession, sendAudioChunk, stopSession, isDeepgramConfigured };
