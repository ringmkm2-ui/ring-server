// deepgramVoice.js
// Deepgram API を使用した高精度音声認識

class DeepgramVoiceRecognizer {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.mediaRecorder = null;
    this.audioContext = null;
    this.stream = null;
    this.isRecording = false;
    this.audioChunks = [];
    this.wsConnection = null;
  }

  async startRecording() {
    try {
      // マイクアクセス取得
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      this.audioChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        await this.sendToDeepgram();
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      console.log('[deepgram] Recording started');
      return true;
    } catch (e) {
      console.error('[deepgram] Recording error:', e);
      return false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      console.log('[deepgram] Recording stopped');
    }
  }

  async sendToDeepgram() {
    if (this.audioChunks.length === 0) return;

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm;codecs=opus' });
    
    try {
      const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=ja', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'audio/webm;codecs=opus'
        },
        body: audioBlob
      });

      if (!response.ok) {
        console.error('[deepgram] API error:', response.status, response.statusText);
        return null;
      }

      const result = await response.json();
      const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      
      console.log('[deepgram] Transcript:', transcript);
      return transcript;
    } catch (e) {
      console.error('[deepgram] Send error:', e);
      return null;
    }
  }

  // リアルタイム WebSocket 接続（ストリーミング用）
  async startRealtimeStream() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=ja&encoding=linear16&sample_rate=16000`;
      this.wsConnection = new WebSocket(wsUrl);

      this.wsConnection.onopen = () => {
        console.log('[deepgram] WebSocket connected');
        // 音声ストリームをWebSocketに送信
        this.streamAudioToWebSocket();
      };

      this.wsConnection.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript || '';
        
        if (transcript) {
          console.log('[deepgram] Live transcript:', transcript);
          // リアルタイム字幕更新
          this.updateLiveCaption(transcript);
        }
      };

      this.wsConnection.onerror = (error) => {
        console.error('[deepgram] WebSocket error:', error);
      };

      this.wsConnection.onclose = () => {
        console.log('[deepgram] WebSocket closed');
      };

      return true;
    } catch (e) {
      console.error('[deepgram] WebSocket stream error:', e);
      return false;
    }
  }

  async streamAudioToWebSocket() {
    if (!this.stream) return;

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(this.stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const audioData = e.inputBuffer.getChannelData(0);
      const pcm = this.floatTo16BitPCM(audioData);
      
      if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
        this.wsConnection.send(pcm);
      }
    };
  }

  floatTo16BitPCM(floatArray) {
    const buffer = new ArrayBuffer(floatArray.length * 2);
    const view = new Int16Array(buffer);
    
    for (let i = 0; i < floatArray.length; i++) {
      const s = Math.max(-1, Math.min(1, floatArray[i]));
      view[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    return buffer;
  }

  updateLiveCaption(text) {
    const captionEl = document.getElementById('liveCaption');
    if (captionEl) {
      captionEl.textContent = text;
      captionEl.style.display = 'block';
    }
  }

  stopStream() {
    if (this.wsConnection) {
      this.wsConnection.close();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }
}

// グローバルインスタンス（admin.html側で `deepgramRecognizer = new DeepgramVoiceRecognizer(...)`
// のように再代入されるため、varではなくwindowプロパティとして直接公開する）
window.deepgramRecognizer = null;
