'use strict';

// Local fork: no upstream version check and no GitHub request. `--update`
// stays available for a manual `git pull --ff-only` in a git clone.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

function canUpdate() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function update() {
  return new Promise((resolve, reject) => {
    if (!canUpdate()) return reject(new Error(`not a git clone (${ROOT}); reinstall it with git clone to get updates`));
    execFile('git', ['-C', ROOT, 'pull', '--ff-only', '--quiet'], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      resolve(localVersion());
    });
  });
}

module.exports = { localVersion, update, ROOT };
