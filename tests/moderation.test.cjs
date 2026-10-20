const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const {server} = require('./apps-script-fixture.cjs');
const seed = {steps: [{_id: 'steps-0', _o: 0, name: 'published'}, {_id: 'steps-1', _o: 1, name: 'second'}], calc: []};
function backend() { const b = server(seed); b.enableModeration(); return b; }
function operation(b, id = 'steps-0', name = 'proposal') {
  return {protocol: 4, table: 'steps', id, baseVersion: b.version('steps', id), mutationId: randomUUID(), del: false,
    row: {...b.row('steps', id), name}};
}

test('unapproved public writes cannot change published rows, including forged moderator fields', () => {
  const b = backend(), op = operation(b);
  assert.equal(b.get().protocol, 4);
  assert.equal(b.post({...op, approved: true, reviewedBy: 'moderator@example.com', action: 'approve'}).status, 'pending');
  assert.equal(b.row('steps', op.id).name, 'published');
  assert.equal(b.post({...op, protocol: 3}).error, 'upgrade_required');
  assert.equal(b.sheets.get('SundayProposals').rows.length, 2);
  assert.equal(b.post(op).status, 'pending'); assert.equal(b.sheets.get('SundayProposals').rows.length, 2);
  assert.equal(b.post({...op, row: {...op.row, name: 'tampered'}}).ok, false);
});

test('review authorization fails closed; more moderators can be configured privately', () => {
  const b = backend(), op = operation(b); b.post(op);
  for (const email of ['', 'stranger@example.com']) {
    b.actor = email; assert.throws(() => b.moderate(op.mutationId), /configured moderator/);
    assert.equal(b.row('steps', op.id).name, 'published');
  }
  b.properties.set('SUNDAY_MODERATOR_EMAILS', JSON.stringify(['moderator@example.com', 'other@example.com']));
  b.actor = 'other@example.com'; assert.equal(b.moderate(op.mutationId), 'approved');
  const line = b.sheets.get('SundayProposals').rows[1]; assert.equal(line[11], 'other@example.com');
});

test('approval checks the current row version; competing proposals cannot overwrite each other', () => {
  const b = backend(), a = operation(b), c = operation(b, 'steps-0', 'other proposal');
  b.post(a); b.post(c); assert.equal(b.moderate(a.mutationId), 'approved');
  assert.equal(b.moderate(c.mutationId), 'conflict');
  assert.equal(b.row('steps', a.id).name, a.row.name);
  assert.equal(b.post(c).error, 'conflict');
  assert.equal(b.post(a).status, 'approved');
});

test('approval interrupted after the journal write is recovered once with its original reviewer', () => {
  const b = backend(), op = operation(b); b.post(op);
  const count = b.sheets.get('SundayHistory').rows.length;
  b.failProjection = true; assert.throws(() => b.moderate(op.mutationId), /interrupted/);
  assert.equal(b.sheets.get('SundayProposals').rows[1][9], 'approving');
  assert.equal(b.post(op).status, 'approved');
  assert.equal(b.sheets.get('SundayHistory').rows.length, count + 1);
  assert.equal(b.sheets.get('SundayProposals').rows[1][11], 'moderator@example.com');
});

test('rejection preserves the published row and cannot be changed into approval by replay', () => {
  const b = backend(), op = operation(b); b.post(op);
  assert.equal(b.moderate(op.mutationId, false), 'rejected');
  assert.equal(b.moderate(op.mutationId, true), 'rejected');
  assert.equal(b.post(op).status, 'rejected'); assert.equal(b.row('steps', op.id).name, 'published');
  const del = {...operation(b), row: null, del: true}; b.post(del);
  assert(b.row('steps', del.id)); b.moderate(del.mutationId); assert.equal(b.row('steps', del.id), undefined);
});

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function storage() {
  const map = new Map(); return {get length() {return map.size;}, key: i => [...map.keys()][i],
    getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)};
}
async function client(b, local = storage(), session = storage()) {
  const changes = [], context = vm.createContext({crypto: {randomUUID}, AbortController, Date,
    localStorage: local, sessionStorage: session, fetch: (...args) => b.fetch(...args),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    window: {addEventListener() {}, removeEventListener() {}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../workspace-sync.js'), 'utf8'), context);
  const app = new context.WorkspaceSync({key: 'moderation-test', url: 'https://example.test/exec',
    protocol: 4, shared: ['steps'], initialData: seed, onChange: c => changes.push(c)});
  app.start(); await settle(); return {app, changes, local, session};
}
const edit = (c, name, id = 'steps-0') => c.app.update('steps', rows => rows.map(r => r._id === id ? {...r, name} : r));

test('client keeps a proposal durable across reload until moderator approval', async () => {
  const b = backend(), c = await client(b); edit(c, 'local'); await c.app.flush();
  const request = c.app.pending['steps|steps-0'].request;
  assert.equal(c.changes.at(-1).sync, 'approval'); assert.equal(b.row('steps', 'steps-0').name, 'published');
  c.app.stop(); const next = await client(b, c.local, c.session);
  assert.equal(next.app.data.steps[0].name, 'local');
  await next.app.flush(); assert.equal(next.app.pending['steps|steps-0'].request.mutationId, request.mutationId);
  b.moderate(request.mutationId); await next.app.flush();
  assert.equal(next.app.hasPending(), false); assert.equal(b.row('steps', 'steps-0').name, 'local');
});

test('waiting review cannot starve other rows; later edits become a new proposal after approval', async () => {
  const b = backend(), c = await client(b); edit(c, 'first'); edit(c, 'other', 'steps-1');
  await c.app.flush(); await c.app.flush(); assert.equal(b.sheets.get('SundayProposals').rows.length, 3);
  const first = c.app.pending['steps|steps-0'].request; edit(c, 'newer');
  b.moderate(first.mutationId); c.app.pending['steps|steps-0'].checkedAt = 0;
  await c.app.flush(); assert(c.app.hasPending()); await c.app.flush();
  assert.equal(b.row('steps', 'steps-0').name, 'first');
  const latest = c.app.pending['steps|steps-0'].request;
  assert.notEqual(latest.mutationId, first.mutationId); assert.equal(latest.row.name, 'newer');
});

test('rejected client draft survives and changing it submits a new operation', async () => {
  const b = backend(), c = await client(b); edit(c, 'rejected text'); await c.app.flush();
  const first = c.app.pending['steps|steps-0'].request;
  b.moderate(first.mutationId, false); await c.app.flush();
  assert.equal(c.changes.at(-1).sync, 'rejected'); assert.equal(c.app.data.steps[0].name, 'rejected text');
  edit(c, 'revised'); await c.app.flush();
  assert.notEqual(c.app.pending['steps|steps-0'].request.mutationId, first.mutationId);
  assert.equal(b.row('steps', 'steps-0').name, 'published');
});

test('restoring a pre-moderation retry keeps its ID but cannot bypass review', async () => {
  const b = backend(), c = await client(b); edit(c, 'old draft'); await c.app.flush();
  const record = c.app.snapshot(), first = record.pending['steps|steps-0'].request.mutationId;
  record.pending['steps|steps-0'].request.protocol = 3;
  const id = c.app.prefix + randomUUID(); c.local.setItem(id, JSON.stringify(record));
  c.app.restore(id); await settle();
  assert.equal(c.app.pending['steps|steps-0'].request.protocol, 4);
  assert.equal(c.app.pending['steps|steps-0'].request.mutationId, first);
  await c.app.flush(); assert.equal(b.row('steps', 'steps-0').name, 'published');
});
