// ビルド前の簡易チェック: 構文、CSP、絵文字、インラインscript、動的innerHTML
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = [path.join(root, 'main.js'), path.join(root, 'preload.js'), ...walk(path.join(root, 'renderer'))];

for (const f of files) {
  const rel = path.relative(root, f);
  if (f.endsWith('.js')) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(rel + ': 構文エラー\n' + r.stderr);
  }
  if (/\.(js|html|css)$/.test(f)) {
    const s = fs.readFileSync(f, 'utf8');
    if (/\p{Extended_Pictographic}/u.test(s.replace(/[←-⇿•©®]/g, ''))) problems.push(rel + ': 絵文字が含まれている(本物のSVGを使う)');
    if (/\bhttps?:\/\/[^\s"'`)]*\b(cdn|googleapis|gstatic|unpkg|jsdelivr)\b/i.test(s)) problems.push(rel + ': 外部CDN・外部フォントは使わない');
  }
  if (f.endsWith('.html')) {
    const s = fs.readFileSync(f, 'utf8');
    if (!/Content-Security-Policy/i.test(s)) problems.push(rel + ': CSPが無い');
    if (/unsafe-inline|unsafe-eval/.test(s)) problems.push(rel + ': CSPに unsafe-inline/unsafe-eval がある');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(s)) problems.push(rel + ': インラインscriptがある');
    if (/\son[a-z]+\s*=/i.test(s)) problems.push(rel + ': インラインイベント属性がある');
  }
}

if (problems.length) {
  console.error('チェック失敗:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('OK: ' + files.length + ' ファイル');
