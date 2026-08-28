// deepgramVoice.js
// -----------------------------------------------------------------------
// Call Assist: リアルタイム字幕・翻訳機能。
// Deepgram APIキーはサーバー側の環境変数にのみ存在し、クライアントは
// Bro Chat本体のWebSocket接続経由で音声を送り、文字起こし結果だけを受け取る。
//
// track: 'mic'(自分のマイク) | 'remote'(相手から受信した音声/remoteAudio)
// 両方を同時に動かせるよう、インスタンスごとに独立したtrackを持つ。
// -----------------------------------------------------------------------

class DeepgramVoiceRecognizer {
  constructor(wsConnection, track = 'mic') {
    this.ws = wsConnection;
    this.track = track === 'remote' ? 'remote' : 'mic';
    this.audioContext = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.isStreaming = false;
    this.onTranscriptCallback = null;
    this._messageHandler = null;
  }

  /**
   * マイク入力から字幕を開始する(自分の発言用)。
   */
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
    return this._startWithStream(callId, language, this.stream);
  }

  /**
   * 既存のMediaStream(例: 相手の音声=remoteAudioのsrcObject)から字幕を開始する。
   * getUserMediaを呼ばないため、相手の受信音声をそのまま渡せる。
   */
  async startFromStream(callId, language, mediaStream) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[deepgram] WebSocket未接続のため開始できません');
      return false;
    }
    if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
      console.error('[deepgram] 音声トラックがないストリームです');
      return false;
    }
    this.stream = mediaStream;
    return this._startWithStream(callId, language, mediaStream);
  }

  _startWithStream(callId, language, mediaStream) {
    this.ws.send(JSON.stringify({ type: 'call_assist_start', callId, language, track: this.track }));

    this._messageHandler = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'call_assist_transcript' && data.track === this.track) {
          if (this.onTranscriptCallback) this.onTranscriptCallback(data.text, data.isFinal);
        } else if (data.type === 'call_assist_error' && data.track === this.track) {
          console.error(`[deepgram:${this.track}] サーバーエラー:`, data.error);
        }
      } catch (e) { /* 他のJSONメッセージは無視 */ }
    };
    this.ws.addEventListener('message', this._messageHandler);

    this._streamAudioToServer(mediaStream);
    this.isStreaming = true;
    console.log(`[deepgram:${this.track}] リアルタイム字幕を開始しました`);
    return true;
  }

  // マイクの音声をPCM16(16kHz)にエンコードし、WSのバイナリフレームとして送信する。
  // フレーム先頭1バイトはtrack識別子(サーバー側がmic/remoteを判別するため)。
  _streamAudioToServer(mediaStream) {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    const trackByte = this.track === 'remote' ? 0x02 : 0x01;

    this.processor.onaudioprocess = (e) => {
      if (!this.isStreaming) return;
      const audioData = e.inputBuffer.getChannelData(0);
      const pcm = this._floatTo16BitPCM(audioData);
      const framed = new Uint8Array(pcm.byteLength + 1);
      framed[0] = trackByte;
      framed.set(new Uint8Array(pcm), 1);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(framed);
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
      this.ws.send(JSON.stringify({ type: 'call_assist_stop', track: this.track }));
    }
    if (this._messageHandler && this.ws) {
      this.ws.removeEventListener('message', this._messageHandler);
      this._messageHandler = null;
    }
    if (this.processor) { try { this.processor.disconnect(); } catch (e) {} this.processor = null; }
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.audioContext) { try { this.audioContext.close(); } catch (e) {} this.audioContext = null; }
    // マイク由来のstreamは自分で止める。相手の音声(remoteAudio由来)は
    // 通話全体で共有されているストリームなので、ここではtrackを止めない。
    if (this.track === 'mic' && this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;
    console.log(`[deepgram:${this.track}] リアルタイム字幕を終了しました`);
  }
}

window.deepgramRecognizer = null;
window.deepgramRemoteRecognizer = null;
window.DeepgramVoiceRecognizer = DeepgramVoiceRecognizer;
