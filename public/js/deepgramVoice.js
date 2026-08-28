// deepgramVoice.js
// -----------------------------------------------------------------------
// Call Assist: リアルタイム字幕・翻訳機能。
// Deepgram APIキーはサーバー側の環境変数にのみ存在し、クライアントは
// Bro Chat本体のWebSocket接続経由で音声を送り、文字起こし結果だけを受け取る。
// -----------------------------------------------------------------------

class DeepgramVoiceRecognizer {
  constructor(wsConnection) {
    this.ws = wsConnection;
    this.audioContext = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.isStreaming = false;
    this.onTranscriptCallback = null;
    this._messageHandler = null;
  }

  async startRealtimeStream(callId, language = 'ja') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[deepgram] WebSocket未接続のため開始できません');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error('[deepgram] マイクアクセスエラー:', e);
      return false;
    }

    this.ws.send(JSON.stringify({ type: 'call_assist_start', callId, language }));

    this._messageHandler = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'call_assist_transcript') {
          if (this.onTranscriptCallback) this.onTranscriptCallback(data.text, data.isFinal);
        } else if (data.type === 'call_assist_error') {
          console.error('[deepgram] サーバーエラー:', data.error);
        }
      } catch (e) { /* 他のJSONメッセージは無視 */ }
    };
    this.ws.addEventListener('message', this._messageHandler);

    this._streamAudioToServer();
    this.isStreaming = true;
    console.log('[deepgram] リアルタイム字幕を開始しました');
    return true;
  }

  _streamAudioToServer() {
    if (!this.stream) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.processor.onaudioprocess = (e) => {
      if (!this.isStreaming) return;
      const audioData = e.inputBuffer.getChannelData(0);
      const pcm = this._floatTo16BitPCM(audioData);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pcm);
      }
    };
  }

  _floatTo16BitPCM(floatArray) {
    const buffer = new ArrayBuffer(floatArray.length * 2);
    const view = new Int16Array(buffer);
    for (let i = 0; i < floatArray.length; i++) {
      const s = Math.max(-1, Math.min(1, floatArray[i]));
      view[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return buffer;
  }

  onTranscript(callback) {
    this.onTranscriptCallback = callback;
  }

  stopStream() {
    this.isStreaming = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'call_assist_stop' }));
    }
    if (this._messageHandler && this.ws) {
      this.ws.removeEventListener('message', this._messageHandler);
      this._messageHandler = null;
    }
    if (this.processor) { try { this.processor.disconnect(); } catch (e) {} this.processor = null; }
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.audioContext) { try { this.audioContext.close(); } catch (e) {} this.audioContext = null; }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    console.log('[deepgram] リアルタイム字幕を終了しました');
  }
}

window.deepgramRecognizer = null;
window.DeepgramVoiceRecognizer = DeepgramVoiceRecognizer;
