const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {server, clone} = require('./apps-script-fixture.cjs');
const seed = {steps: [{_id: 'steps-0', _o: 0, name: 'first'}, {_id: 'steps-1', _o: 1, name: 'second'}], briefs: []};
function operation(b, changes = {}) { return {protocol: 3, table: 'steps', id: 'steps-0', mutationId: randomUUID(),
  baseVersion: b.version('steps', 'steps-0'), del: false, row: {...b.row('steps', 'steps-0'), name: 'edited'}, ...changes}; }

test('migration imports legacy arrays, tombstones removed seeds and preserves original sheets', () => {
  const legacy = [['tab_id', 'tab_name', 'content_json'], ['tab_general', 'Overview', '{}'], ['steps', JSON.stringify([{name: 'real team change'}])]];
  const b = server(seed, legacy), oldHistory = clone(b.sheets.get('History').rows);
  b.setup(); assert.equal(b.row('steps', 'steps-0').name, 'real team change');
  assert.deepEqual(b.get().data.steps.deleted, ['steps-1']);
  assert.deepEqual(b.sheets.get('SharedTabs').rows, legacy); assert.deepEqual(b.sheets.get('History').rows, oldHistory);
  const count = b.sheets.get('SundayHistory').rows.length; b.setup();
  assert.equal(b.sheets.get('SundayHistory').rows.length, count);
});

test('empty legacy table stays empty after migration', () => {
  const b = server(seed, [['tab_id', 'tab_name'], ['steps', '[]']]); b.setup();
  assert.equal(b.rows('steps').length, 0); assert.equal(b.get().data.steps.deleted.length, 2);
});

test('conflicts and protocol mismatches never modify stored data', () => {
  const b = server(seed); b.setup(); const op = operation(b);
  assert.equal(b.post(op).ok, true); const count = b.sheets.get('SundayHistory').rows.length;
  const conflict = b.post({...op, mutationId: randomUUID(), row: {...op.row, name: 'stale'}});
  assert.equal(conflict.error, 'conflict'); assert.equal(b.row('steps', 'steps-0').name, 'edited');
  assert.equal(b.post({table: 'steps', rows: []}).error, 'upgrade_required');
  assert.equal(b.post({ops: []}).error, 'upgrade_required');
  assert.equal(b.sheets.get('SundayHistory').rows.length, count);
});

test('persistent receipts recognize replay even after later edits', () => {
  const b = server(seed); b.setup(); const op = operation(b), first = b.post(op);
  b.change('steps', 'steps-0', r => ({...r, name: 'later'}));
  assert.deepEqual(b.post(op), first); assert.equal(b.row('steps', 'steps-0').name, 'later');
  assert.equal(b.post({...op, row: {...op.row, name: 'tampered'}}).ok, false);
});

test('journal repairs interrupted Data write before acknowledging replay', () => {
  const b = server(seed); b.setup(); const op = operation(b), count = b.sheets.get('SundayHistory').rows.length;
  b.failProjection = true; assert.equal(b.post(op).ok, false);
  assert.equal(b.row('steps', 'steps-0').name, 'edited');
  assert.equal(b.post(op).ok, true); assert.equal(b.version('steps', 'steps-0'), 2);
  assert.equal(b.sheets.get('SundayHistory').rows.length, count + 1);
});

test('interrupted setup resumes without duplicating or dropping rows', () => {
  const b = server(seed, [['tab_id', 'tab_name'], ['steps', JSON.stringify([{name: 'legacy'}])]]);
  b.failProjection = true; assert.throws(() => b.setup()); assert.notEqual(b.properties.get('SUNDAY_READY'), '3');
  b.setup(); assert.equal(b.row('steps', 'steps-0').name, 'legacy'); assert.equal(b.rows('steps').length, 1);
  const ids = b.sheets.get('SundayHistory').rows.slice(1).map(r => r[0]); assert.equal(new Set(ids).size, ids.length);
});

test('invalid rows, IDs, versions and tables are rejected', () => {
  const b = server(seed); b.setup(); const op = operation(b), count = b.sheets.get('SundayHistory').rows.length;
  for (const change of [{table: 'calc'}, {id: '__proto__'}, {baseVersion: -1}, {row: {...op.row, _id: 'wrong'}}, {row: {...op.row, _o: null}}]) {
    assert.equal(b.post({...op, ...change}).ok, false);
  }
  assert.equal(b.sheets.get('SundayHistory').rows.length, count);
});

test('schema mismatch fails without replacing an existing sheet', () => {
  const b = server(seed); b.sheet('Data', [['unrelated', 'headers'], ['keep', 'me']]);
  assert.throws(() => b.setup(), /Unexpected headers/); assert.deepEqual(b.sheets.get('Data').rows[1], ['keep', 'me']);
});

test('migration refuses a changed legacy source after an interruption', () => {
  const b = server(seed, [['tab_id', 'tab_name'], ['steps', JSON.stringify([{name: 'original'}])]]);
  b.failProjection = true; assert.throws(() => b.setup());
  b.sheets.get('SharedTabs').rows[1][1] = JSON.stringify([{name: 'different source'}]);
  assert.throws(() => b.setup(), /Legacy source changed/);
  assert.notEqual(b.properties.get('SUNDAY_READY'), '3');
});

test('duplicate legacy tables are rejected before importing any rows', () => {
  const b = server(seed, [['tab_id', 'tab_name'], ['steps', '[]'], ['steps', JSON.stringify([{name: 'other'}])]]);
  assert.throws(() => b.setup(), /Duplicate legacy table/);
  assert.equal(b.sheets.get('SundayHistory').rows.length, 1);
});
