// callRecording.js
// 通話の音声録音と履歴管理

class CallRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStartTime = null;
    this.currentCallId = null;
    this.isRecording = false;
  }

  async startRecording(stream, callId, partnerId, partnerName) {
    try {
      // リモート + ローカル音声を混合
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const mediaStreamSource = audioContext.createMediaStreamSource(stream);
      const destination = audioContext.createMediaStreamDestination();
      
      mediaStreamSource.connect(destination);
      
      this.mediaRecorder = new MediaRecorder(destination.stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      this.recordedChunks = [];
      this.recordingStartTime = Date.now();
      this.currentCallId = callId;
      this.partnerInfo = { id: partnerId, name: partnerName };

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.saveRecording();
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      console.log('[callRecorder] Recording started:', callId);
      return true;
    } catch (e) {
      console.error('[callRecorder] Start recording error:', e);
      return false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      console.log('[callRecorder] Recording stopped');
    }
  }

  async saveRecording() {
    if (this.recordedChunks.length === 0) return;

    const duration = Math.round((Date.now() - this.recordingStartTime) / 1000);
    const blob = new Blob(this.recordedChunks, { type: 'audio/webm;codecs=opus' });
    
    // Base64 に変換してキャッシュに保存
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Audio = reader.result;
      
      const callRecord = {
        id: this.currentCallId,
        partnerId: this.partnerInfo.id,
        partnerName: this.partnerInfo.name,
        timestamp: Date.now(),
        duration: duration,
        audioData: base64Audio,
        type: 'call'
      };

      // IndexedDB に保存
      try {
        if (window.cacheManager) {
          await cacheManager.init();
          const tx = cacheManager.db.transaction('callRecordings', 'readwrite');
          const store = tx.objectStore('callRecordings');
          store.add(callRecord);
          console.log('[callRecorder] Recording saved to cache');
        }
      } catch (e) {
        console.error('[callRecorder] Save error:', e);
      }
    };
    reader.readAsDataURL(blob);
  }

  async getCallHistory() {
    try {
      if (!window.cacheManager) return [];
      await cacheManager.init();
      
      return new Promise((resolve, reject) => {
        const tx = cacheManager.db.transaction('callRecordings', 'readonly');
        const store = tx.objectStore('callRecordings');
        const req = store.getAll();
        
        req.onsuccess = () => {
          const records = req.result || [];
          // 最新順でソート
          records.sort((a, b) => b.timestamp - a.timestamp);
          resolve(records);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[callRecorder] Get history error:', e);
      return [];
    }
  }

  async deleteRecording(callId) {
    try {
      if (!window.cacheManager) return false;
      await cacheManager.init();
      
      return new Promise((resolve, reject) => {
        const tx = cacheManager.db.transaction('callRecordings', 'readwrite');
        const store = tx.objectStore('callRecordings');
        const req = store.delete(callId);
        
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[callRecorder] Delete error:', e);
      return false;
    }
  }
}

const callRecorder = new CallRecorder();
window.callRecorder = callRecorder;
