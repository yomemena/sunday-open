const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));

function server(seed, legacy) {
  const sheets = new Map(), properties = new Map(), posts = [];
  let locked = false;
  const backend = {posts, sheets, properties, failProjection: false};
  function sheet(name, rows = []) {
    const value = {name, rows: clone(rows), setFrozenRows() {}, getLastRow() { return this.rows.length; },
      appendRow(row) {
        if (!locked) throw new Error('Write without lock');
        if (name === 'Data' && this.rows.length && backend.failProjection) { backend.failProjection = false; throw new Error('projection interrupted'); }
        this.rows.push(clone(row));
      },
      getDataRange() { return {getValues: () => clone(this.rows)}; },
      getRange(r, c, height, width) { return {
        getValues: () => Array.from({length: height}, (_, i) => Array.from({length: width}, (_, j) => this.rows[r+i-1]?.[c+j-1] ?? '')),
        setValues: values => {
          if (!locked) throw new Error('Write without lock');
          if (name === 'Data' && backend.failProjection) { backend.failProjection = false; throw new Error('projection interrupted'); }
          values.forEach((row, i) => row.forEach((cell, j) => { this.rows[r+i-1] ||= []; this.rows[r+i-1][c+j-1] = clone(cell); }));
        }
      }; }
    };
    sheets.set(name, value);
    return value;
  }
  if (legacy) sheet('SharedTabs', legacy);
  sheet('History', [['log_id', 'timestamp', 'user_id', 'action', 'entity_type', 'details'], ['old-log', '', '', '', '', 'preserve me']]);
  const spreadsheet = {getSheetByName: name => sheets.get(name), insertSheet: name => sheet(name)};
  const context = vm.createContext({Date, JSON, Object, Number, Error,
    SpreadsheetApp: {openById: () => spreadsheet, flush() {}},
    LockService: {getScriptLock: () => ({
      tryLock() { if (locked) return false; locked = true; return true; },
      waitLock() { if (locked) throw new Error('busy'); locked = true; }, releaseLock() { locked = false; }
    })},
    PropertiesService: {getScriptProperties: () => ({getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value)})},
    Utilities: {DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, text) => [...createHash('sha256').update(text).digest()]},
    ContentService: {MimeType: {JSON: 'application/json'}, createTextOutput: text => ({text, setMimeType() { return this; }})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script.gs'), 'utf8'), context);
  if (seed) context.SUNDAY_SEED = clone(seed);
  const decode = result => JSON.parse(result.text);
  Object.assign(backend, {context, sheet, setup: () => context.setupSundayOpen(),
    get: () => decode(context.doGet()), post: op => decode(context.doPost({postData: {contents: JSON.stringify(op)}})),
    response: json => ({ok: true, json: async () => clone(json)}),
    rows: t => Object.values(backend.get().data[t].rows).map(x => x.row),
    row: (t, id) => backend.get().data[t].rows[id]?.row,
    version: (t, id) => backend.get().data[t].rows[id]?.v || backend.get().data[t].deletedVersions[id],
    change: (t, id, fn) => {
      const row = backend.row(t, id);
      return backend.post({protocol: 3, table: t, id, row: fn(clone(row)), del: false,
        baseVersion: backend.version(t, id), mutationId: randomUUID()});
    },
    fetch: async (_, options) => {
      if (options?.method !== 'POST') return backend.response(backend.get());
      const request = JSON.parse(options.body); posts.push(request);
      return backend.response(backend.post(request));
    }
  });
  return backend;
}

module.exports = {server, clone};
