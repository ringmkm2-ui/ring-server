// utils/passwordHash.worker.js
// bcrypt の計算だけを別スレッドで行う(本体は utils/passwordHash.js)。
// ここでは同期版を使う。このスレッドは1件ずつしか受けないので、塞いで困る相手がいない。
const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, op, password, hash, rounds }) => {
  try {
    const result = op === 'hash' ? bcrypt.hashSync(password, rounds) : bcrypt.compareSync(password, hash);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e && e.message ? e.message : 'bcrypt failed' });
  }
});
