// Generates a separate test site; never changes index.html or production settings.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pattern = /(<script type="__bundler\/template">)\s*([\s\S]*?)\s*(<\/script>)/;
let template = JSON.parse(source.match(pattern)[2]);
const oldUrl = template.match(/const SYNC_URL='([^']+)'/)[1];
const oldSheet = fs.readFileSync(path.join(root, 'apps-script.gs'), 'utf8')
  .match(/var SUNDAY_SPREADSHEET_ID = '([^']+)'/)[1];
assert.match(config.endpoint, /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/);
assert.notEqual(config.endpoint, oldUrl, 'Preview must use a separate Apps Script deployment');
assert.notEqual(config.spreadsheetId, oldSheet, 'Preview must use a separate spreadsheet');
assert.match(config.spreadsheetId, /^[\w-]{20,}$/);
const key = 'sunday-open-test-' + config.spreadsheetId;
template = template.replace(/const KEY='[^']+'/, `const KEY='${key}'`)
  .replace(/const SYNC_URL='[^']+'/, `const SYNC_URL='${config.endpoint}'`)
  .replace(/<title>[^<]*<\/title>/, '<title>Sunday Open TEST</title>')
  .replace('<body>', '<body><div style="position:sticky;top:0;z-index:9999;background:#8b2c05;color:white;padding:12px 20px;text-align:center;font:bold 15px sans-serif">ТЕСТОВАЯ ВЕРСИЯ · Отдельная копия данных · Здесь можно проверять сохранения и конфликты</div>');
const html = source.replace(pattern, (_, start, text, end) => start + JSON.stringify(template) + end)
  .replace(/<title>[^<]*<\/title>/, '<title>Sunday Open TEST</title>');
assert(!html.includes(oldUrl), 'Production endpoint must be absent from the test site');
assert(!template.includes("const KEY='sunday-open-workspace-v1'"));
const out = path.join(root, '.preview');
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'workspace-sync.js'), path.join(out, 'workspace-sync.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Isolated preview built in .preview; production endpoint absent.');
