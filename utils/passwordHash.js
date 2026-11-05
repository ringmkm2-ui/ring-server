// utils/passwordHash.js
// パスワードの照合・ハッシュ化は、必ずここを通す。
// bcryptjs はJSだけで動くので、async版でもメインスレッドで計算している。
// 間違ったパスワードを60本同時に送られるだけで /health が15秒かかるようになり、全員のチャットが止まっていた。
// ネイティブ依存を増やさずに逃がすため、worker_threads に計算を任せる。
//
// 同時に計算するのは2件まで(無料プランはCPUが小さいので、増やしても速くならない)。
// 待ち行列にも上限を置き、溢れたら 503 にする。上限が無いと待ち行列そのものがメモリを食い、
// クライアントが諦めて帰った後も計算だけが延々と続く。
const path = require('path');
const { Worker } = require('worker_threads');

const POOL_SIZE = 2;
const QUEUE_MAX = Number(process.env.PASSWORD_QUEUE_MAX) || 50;
// これより長く待ったものは計算しない。クライアント側はとっくに諦めている時間で、計算しても無駄になる
const QUEUE_WAIT_MAX_MS = 20000;
// しばらく使わなければスレッドを畳む(1本あたり数MB使う。起動時にも作らない)
const IDLE_SHUTDOWN_MS = 60000;
// 長いパスワードは計算量を増やすだけで、bcryptは72バイトまでしか見ない。登録時の上限(passwordPolicy)と同じ
const MAX_PASSWORD_LENGTH = 128;

const WORKER_FILE = path.join(__dirname, 'passwordHash.worker.js');
const workers = []; // { worker, task }
const queue = [];
let nextId = 1;
let idleTimer = null;

function busyError() {
  const e = new Error('password worker queue is full');
  e.code = 'PASSWORD_BUSY';
  return e;
}

function spawn() {
  const slot = { worker: new Worker(WORKER_FILE), task: null };
  // 待っている計算が無ければプロセスの終了を妨げない
  slot.worker.unref();
  slot.worker.on('message', msg => {
    const task = slot.task;
    slot.task = null;
    if (task && task.id === msg.id) {
      if (msg.error) task.reject(new Error(msg.error));
      else task.resolve(msg.result);
    }
    pump();
  });
  const dead = err => {
    const i = workers.indexOf(slot);
    if (i >= 0) workers.splice(i, 1);
    if (slot.task) { slot.task.reject(err instanceof Error ? err : new Error('password worker exited')); slot.task = null; }
    pump();
  };
  slot.worker.on('error', dead);
  slot.worker.on('exit', dead);
  workers.push(slot);
  return slot;
}

function pump() {
  clearTimeout(idleTimer);
  while (queue.length) {
    let slot = workers.find(w => !w.task);
    if (!slot && workers.length < POOL_SIZE) slot = spawn();
    if (!slot) return;
    const task = queue.shift();
    if (Date.now() - task.queuedAt > QUEUE_WAIT_MAX_MS) { task.reject(busyError()); continue; }
    slot.task = task;
    slot.worker.postMessage(task.payload);
  }
  if (workers.length && workers.every(w => !w.task)) {
    idleTimer = setTimeout(() => { for (const w of workers.slice()) if (!w.task) w.worker.terminate(); }, IDLE_SHUTDOWN_MS);
    idleTimer.unref();
  }
}

function enqueue(payload) {
  return new Promise((resolve, reject) => {
    if (queue.length >= QUEUE_MAX) return reject(busyError());
    const id = nextId++;
    queue.push({ id, resolve, reject, queuedAt: Date.now(), payload: { ...payload, id } });
    pump();
  });
}

// 文字列でない・長すぎる入力は計算せず「違う」と答える(req.body の値がそのまま来るので型は保証されない)
async function compare(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string' || !hash || password.length > MAX_PASSWORD_LENGTH) return false;
  return enqueue({ op: 'compare', password, hash });
}

async function hash(password, rounds = 12) {
  return enqueue({ op: 'hash', password: String(password), rounds });
}

module.exports = { compare, hash };
