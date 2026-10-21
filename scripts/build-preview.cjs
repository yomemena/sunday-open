// Build isolated preview by default, or the production Pages directory with --production.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json'), 'utf8'));
const production = process.argv.includes('--production');
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
const key = production ? 'sunday-open-workspace-v1' : 'sunday-open-test-' + config.spreadsheetId;
const sync = fs.readFileSync(path.join(root, 'workspace-sync.js'), 'utf8');
const offline = fs.readFileSync(path.join(root, 'preview/offline.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'preview/offline-sw.js'), 'utf8')
  .replace('sunday-open-test-shell:', production ? 'sunday-open-shell:' : 'sunday-open-test-shell:');
template = template.replace(/const KEY='[^']+'/, `const KEY='${key}'`)
  .replace('new WorkspaceSync({key:KEY', 'new WorkspaceSync({protocol:4,key:KEY')
  .replace(/const SYNC_URL='[^']+'/, `const SYNC_URL='${production ? oldUrl : config.endpoint}'`)
  .replace(/<title>([^<]*)<\/title>/, (_, title) => `<title>${production ? title : 'Sunday Open TEST'}</title>`)
  .replace('</head>', '<script src="./preview-offline.__PREVIEW_VERSION__.js"></script></head>')
  .replace('<body>', `<body><div style="${production ? 'background:#eef2f8;color:#2B3A8D;padding:8px 20px;text-align:center;font:13px sans-serif' : 'position:sticky;top:0;z-index:9999;background:#8b2c05;color:white;padding:12px 20px;text-align:center;font:bold 15px sans-serif'}">${production ? '' : 'ТЕСТОВАЯ ВЕРСИЯ · Отдельная копия данных · '}Правки видны команде только после одобрения<br><span id="preview-offline-state" aria-live="polite" style="font-weight:normal;font-size:13px">Подготавливаю доступ без интернета…</span></div>`);
// HTML closes a script element even when </script> occurs inside a JSON string.
const encoded = JSON.stringify(template).replace(/</g, '\\u003c');
let html = source.replace(pattern, (_, start, text, end) => start + encoded + end)
  .replace(/<title>([^<]*)<\/title>/, (_, title) => `<title>${production ? title : 'Sunday Open TEST'}</title>`)
  .replace('./workspace-sync.js', './workspace-sync.__PREVIEW_VERSION__.js');
assert.equal(JSON.parse(html.match(pattern)[2]), template, 'Embedded template must survive HTML parsing');
assert(!html.includes(production ? config.endpoint : oldUrl), 'Site must not include the other environment endpoint');
assert.equal(template.includes("const KEY='sunday-open-workspace-v1'"), production);
assert(template.includes('new WorkspaceSync({protocol:4,key:KEY'), 'Test client must require moderated protocol 4');
const version = createHash('sha256').update(html).update(sync).update(offline).update(worker).digest('hex').slice(0, 16);
html = html.replaceAll('__PREVIEW_VERSION__', version);
const out = path.join(root, production ? 'docs' : '.preview');
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, `workspace-sync.${version}.js`), sync);
fs.writeFileSync(path.join(out, `preview-offline.${version}.js`), offline);
fs.writeFileSync(path.join(out, 'offline-sw.js'), worker.replaceAll('__PREVIEW_VERSION__', version));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(production ? 'Production site built in docs; test endpoint absent, protocol 4 required.' : 'Isolated preview built in .preview; production endpoint absent.');
