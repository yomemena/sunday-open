const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

test('production Pages build requires approval, keeps production storage and isolates test data', () => {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, ['scripts/build-preview.cjs', '--production'], {cwd: root});
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const template = JSON.parse(html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  const preview = JSON.parse(fs.readFileSync(path.join(root, 'preview.json')));
  assert(!html.includes(preview.endpoint));
  assert(!template.includes('ТЕСТОВАЯ ВЕРСИЯ'));
  assert(template.includes('new WorkspaceSync({protocol:4,key:KEY'));
  assert(template.includes("const KEY='sunday-open-workspace-v1'"));
  assert(template.includes('Правки видны команде только после одобрения'));
  const version = html.match(/workspace-sync\.([a-f0-9]{16})\.js/)[1];
  for (const file of [`workspace-sync.${version}.js`, `preview-offline.${version}.js`, 'offline-sw.js']) {
    assert(fs.existsSync(path.join(root, file)));
  }
  const worker = fs.readFileSync(path.join(root, 'offline-sw.js'), 'utf8');
  assert(worker.includes('sunday-open-shell:'));
  assert(worker.includes(`workspace-sync.${version}.js`));
  assert(!worker.includes('__PREVIEW_VERSION__'));
});
