const { spawnSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const roots = ['src', 'scripts', 'test'];
const files = [];

function walk(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })) return;
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(?:c?js|mjs)$/.test(entry)) files.push(full);
  }
}

for (const root of roots) walk(path.join(process.cwd(), root));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax checked: ${files.length} files`);
