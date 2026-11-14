'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['server.js', 'public/index.html', 'public/admin.html'];
let failed = false;
for (const file of files) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf8');
  try {
    if (file.endsWith('.html')) {
      const blocks = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
      for (const block of blocks) new vm.Script(block[1], { filename: file });
      const ids = [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(x => x[1]);
      const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      if (duplicates.length) throw new Error('Duplicate HTML IDs: ' + duplicates.join(', '));
      if (/NEXTBUILD/i.test(source)) throw new Error('Old NEXTBUILD branding remains in ' + file);
    } else {
      new vm.Script(source, { filename: file });
    }
    console.log('PASS', file);
  } catch (err) {
    failed = true;
    console.error('FAIL', file, err.message);
  }
}
if (failed) process.exit(1);
