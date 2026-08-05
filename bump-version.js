#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse args: node bump-version.js major|minor|patch|X.Y.Z
const arg = process.argv[2];
if (!arg) {
  console.log('使用: npm run bump -- major|minor|patch|X.Y.Z');
  console.log('  例: npm run bump -- minor  → 1.2.0 → 1.3.0');
  process.exit(1);
}

// Read current version from package.json
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const [major, minor, patch] = current.split('.').map(Number);

let newVersion;
if (arg === 'major') {
  newVersion = `${major + 1}.0.0`;
} else if (arg === 'minor') {
  newVersion = `${major}.${minor + 1}.0`;
} else if (arg === 'patch') {
  newVersion = `${major}.${minor}.${patch + 1}`;
} else if (/^\d+\.\d+\.\d+$/.test(arg)) {
  newVersion = arg;
} else {
  console.error('❌ Invalid version format. Use: major|minor|patch|X.Y.Z');
  process.exit(1);
}

// Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✓ package.json: ${current} → ${newVersion}`);

// Update HTML files
const htmlFiles = [
  'public/admin.html',
  'public/groupchat.html',
  'public/talklist.html'
];

const htmlVersion = `v${newVersion.split('.').slice(0, 2).join('.')} beta`;

htmlFiles.forEach(file => {
  const filePath = path.join(__dirname, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Match: <div class="version-badge">Bro Chat vX.Y beta</div>
  const oldBadge = content.match(/<div class="version-badge">Bro Chat v[\d.]+.*?<\/div>/);
  if (oldBadge) {
    const newBadge = `<div class="version-badge">Bro Chat ${htmlVersion}</div>`;
    content = content.replace(oldBadge[0], newBadge);
    fs.writeFileSync(filePath, content);
    console.log(`✓ ${file}: ${htmlVersion}`);
  } else {
    console.warn(`⚠ Version badge not found in ${file}`);
  }
});

console.log(`\n✅ Version bumped: ${current} → ${newVersion}`);
console.log('Ready to commit & push to GitHub');
