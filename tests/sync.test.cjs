const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const path = require('node:path');
const {server, clone} = require('./apps-script-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../workspace-sync.js'), 'utf8');
const initial = {steps: [{name: 'first', note: ''}, {name: 'second', note: ''}], briefs: [], calc: [{price: 10}]};
const shared = ['steps', 'briefs'];
const seed = Object.fromEntries(shared.map(t => [t, initial[t].map((r, i) => ({...r, _id: t + '-' + i, _o: i}))]));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function backend() { const result = server(seed); result.setup(); return result; }
function storage() {
  const data = new Map();
  return {get length() { return data.size; }, key: i => [...data.keys()][i], getItem: key => data.get(key) || null,
    setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data};
}
function client(backend, localStorage = storage(), sessionStorage = storage(), data = initial) {
  const jobs = new Set(), listeners = {}, changes = [];
  const context = vm.createContext({crypto: {randomUUID}, AbortController, Date, localStorage, sessionStorage,
    fetch: (...args) => backend.fetch(...args),
    setTimeout: (fn, ms) => { const job = {fn, ms}; jobs.add(job); return job; }, clearTimeout: job => jobs.delete(job),
    setInterval: () => 1, clearInterval: () => {},
    window: {addEventListener: (name, fn) => listeners[name] = fn, removeEventListener: name => delete listeners[name]}});
  vm.runInContext(source, context);
  const app = new context.WorkspaceSync({key: 'test', url: 'https://example.test/exec', initialData: data,
    shared, onChange: change => changes.push(clone(change))});
  return {app, localStorage, sessionStorage, jobs, listeners, changes, context};
}
async function start(c) { c.app.start(); await settle(); return c; }
function edit(c, index = 0, value = 'mine') { c.app.update('steps', rows => rows.map((r, i) => i === index ? {...r, name: value} : r)); }
const pending = c => c.app.pending['steps|steps-0'];

test('draft is durable before debounce and reload restores it', async () => {
  const b = backend(), c = await start(client(b)); edit(c);
  assert.equal(b.posts.length, 0); assert.equal(c.changes.at(-1).sync, 'pending');
  assert.equal(JSON.parse(c.localStorage.getItem(c.app.id)).pending['steps|steps-0'].row.name, 'mine');
  c.app.stop(); const next = await start(client(b, c.localStorage, c.sessionStorage));
  assert.equal(next.app.data.steps[0].name, 'mine'); await next.app.flush();
  assert.equal(b.row('steps', 'steps-0').name, 'mine'); assert.equal(next.app.hasPending(), false);
});

test('failed save followed by poll never replaces draft', async () => {
  const b = backend(), c = await start(client(b)), fetch = b.fetch; edit(c);
  b.fetch = (...args) => args[1]?.method === 'POST' ? Promise.reject(new Error('offline')) : fetch(...args);
  await c.app.flush(); await c.app.pull();
  assert.equal(c.app.data.steps[0].name, 'mine'); assert.equal(c.app.hasPending(), true);
  assert.notEqual(c.changes.at(-1).sync, 'ok');
});

test('HTTP errors, invalid JSON and application errors never clear queue', async () => {
  for (const failure of [{ok: false, status: 500},
    {ok: true, json: async () => { throw new Error('HTML'); }},
    {ok: true, json: async () => ({ok: false, error: 'failed'})}]) {
    const b = backend(), c = await start(client(b)); edit(c); b.fetch = async () => failure;
    await c.app.flush(); assert.equal(c.app.hasPending(), true); assert.equal(c.changes.at(-1).sync, 'err');
  }
});

test('legacy endpoints are read-only until upgraded', async () => {
  const b = backend(); b.fetch = async (_, options) => {
    assert.notEqual(options?.method, 'POST'); return b.response({data: {steps: initial.steps}});
  };
  const c = await start(client(b)); edit(c); await c.app.flush();
  assert.equal(c.changes.at(-1).sync, 'upgrade'); assert.equal(c.app.hasPending(), true);
});

test('two people can save different rows of the same table', async () => {
  const b = backend(), a = await start(client(b)), c = await start(client(b));
  edit(a, 0, 'Alice'); edit(c, 1, 'Bob'); await a.app.flush(); await c.app.flush();
  assert.equal(b.row('steps', 'steps-0').name, 'Alice'); assert.equal(b.row('steps', 'steps-1').name, 'Bob');
  assert.equal(a.app.hasPending(), false); assert.equal(c.app.hasPending(), false);
});

test('same-row conflict preserves local and remote versions', async () => {
  const b = backend(), a = await start(client(b)), c = await start(client(b));
  edit(a, 0, 'Alice'); edit(c, 0, 'Bob'); await a.app.flush(); await c.app.flush();
  assert.equal(b.row('steps', 'steps-0').name, 'Alice'); assert.equal(c.app.data.steps[0].name, 'Bob');
  assert.equal(c.app.remote['steps|steps-0'].row.name, 'Alice'); assert.equal(c.changes.at(-1).sync, 'conflict');
});

test('lost reply is retried immutably even after another person edits that row', async () => {
  const b = backend(), c = await start(client(b)), fetch = b.fetch; let lose = true;
  b.fetch = async (...args) => { const result = await fetch(...args); if (args[1]?.method === 'POST' && lose) { lose = false; throw new Error('reply lost'); } return result; };
  edit(c, 0, 'first edit'); await c.app.flush(); const request = clone(pending(c).request);
  b.change('steps', 'steps-0', r => ({...r, note: 'teammate'}));
  edit(c, 0, 'second edit'); await c.app.pull(); await c.app.flush();
  assert.deepEqual(b.posts[1], request); assert.equal(pending(c).baseVersion, 2);
  await c.app.flush();
  assert.equal(c.changes.at(-1).sync, 'conflict'); assert.equal(c.app.data.steps[0].name, 'second edit');
  assert.equal(b.row('steps', 'steps-0').note, 'teammate');
});

test('reload after uncertain save reuses persisted mutation ID', async () => {
  const b = backend(), c = await start(client(b)), fetch = b.fetch; edit(c);
  b.fetch = async (...args) => { const r = await fetch(...args); if (args[1]?.method === 'POST') throw new Error('lost'); return r; };
  await c.app.flush(); const id = pending(c).request.mutationId; c.app.stop(); b.fetch = fetch;
  const next = await start(client(b, c.localStorage, c.sessionStorage)); await next.app.flush();
  assert.equal(b.posts.at(-1).mutationId, id); assert.equal(b.version('steps', 'steps-0'), 2); assert.equal(next.app.hasPending(), false);
});

test('typing during a save remains queued and GET cannot claim it is saved', async () => {
  const b = backend(), c = await start(client(b)), fetch = b.fetch; let release;
  b.fetch = (...args) => args[1]?.method === 'POST' ? new Promise(resolve => release = async () => resolve(await fetch(...args))) : fetch(...args);
  edit(c, 0, 'sent'); const sending = c.app.flush(); edit(c, 0, 'later'); await c.app.pull();
  assert.equal(c.changes.at(-1).sync, 'saving'); await release(); await sending;
  assert.equal(c.app.data.steps[0].name, 'later'); assert.equal(c.app.hasPending(), true);
  b.fetch = fetch; await c.app.flush(); assert.equal(b.row('steps', 'steps-0').name, 'later');
});

test('poll detects stale row before send without losing draft', async () => {
  const b = backend(), c = await start(client(b)); edit(c); b.change('steps', 'steps-0', r => ({...r, name: 'team'}));
  await c.app.pull(); await c.app.flush(); assert.equal(b.posts.length, 0);
  assert.equal(c.app.data.steps[0].name, 'mine'); assert.equal(c.changes.at(-1).sync, 'conflict');
});

test('typing before initial load cannot overwrite existing team data', async () => {
  const b = backend(), c = client(b); b.change('steps', 'steps-0', r => ({...r, name: 'existing'}));
  c.app.start(); edit(c); await settle(); await c.app.flush();
  assert.equal(b.posts.length, 0); assert.equal(c.changes.at(-1).sync, 'conflict');
});

test('multiple tabs keep separate durable drafts and new tab can recover either', async () => {
  const b = backend(), disk = storage(), a = await start(client(b, disk)), c = await start(client(b, disk));
  edit(a, 0, 'Alice'); edit(c, 0, 'Bob'); assert.notEqual(a.app.id, c.app.id);
  const next = await start(client(b, disk)); assert.equal(next.app.drafts().length, 2);
  next.app.restore(a.app.id); await settle(); assert.equal(next.app.data.steps[0].name, 'Alice');
  assert.equal(JSON.parse(disk.getItem(c.app.id)).pending['steps|steps-0'].row.name, 'Bob');
});

test('loading team version first archives conflicting work', async () => {
  const b = backend(), c = await start(client(b)); edit(c); b.change('steps', 'steps-0', r => ({...r, name: 'team'}));
  await c.app.pull(); c.app.useRemote(); assert.equal(c.app.data.steps[0].name, 'team');
  assert.equal(c.app.hasPending(), false); assert.equal(c.app.read(c.app.drafts()[0].id).pending['steps|steps-0'].row.name, 'mine');
});

test('failed archiving cannot discard a conflicting draft', async () => {
  const b = backend(), c = await start(client(b)); edit(c); b.change('steps', 'steps-0', r => ({...r, name: 'team'})); await c.app.pull();
  c.localStorage.setItem = () => { throw new Error('quota'); }; c.app.useRemote();
  assert.equal(c.app.data.steps[0].name, 'mine'); assert.equal(c.changes.at(-1).sync, 'storage');
});

test('calculator and view survive reload without being shared', async () => {
  const b = backend(), c = await start(client(b)); c.app.update('calc', () => [{price: 777}]); c.app.saveView('calc', 15); c.app.stop();
  const next = await start(client(b, c.localStorage, c.sessionStorage));
  assert.equal(next.app.data.calc[0].price, 777); assert.equal(next.app.tab, 'calc'); assert.equal(next.app.volRatio, 15);
  assert.equal(c.localStorage.getItem(c.app.id), null);
  await next.app.flush(); assert.equal(b.posts.length, 0);
});

test('restoring a draft invalidates an earlier pending read', async () => {
  const b = backend(), disk = storage(), a = await start(client(b, disk)), c = await start(client(b, disk));
  edit(a, 0, 'recover me');
  const fetch = b.fetch; let release;
  b.fetch = () => new Promise(resolve => release = () => resolve(b.response({protocol: 3, ok: true, data: {}})));
  const oldRead = c.app.pull(); b.fetch = fetch;
  c.app.restore(a.app.id); await settle(); release(); await oldRead;
  assert.equal(c.app.data.steps[0].name, 'recover me'); assert.equal(c.app.hasPending(), true);
  assert.equal(c.app.versions.steps['steps-0'], 1);
});

test('storage failure blocks non-durable outgoing requests', async () => {
  const b = backend(), c = await start(client(b)); c.localStorage.setItem = () => { throw new Error('quota'); };
  edit(c); await c.app.flush(); assert.equal(b.posts.length, 0); assert.equal(c.changes.at(-1).sync, 'storage');
});

test('invalid acknowledgements cannot clear pending work', async () => {
  const b = backend(), c = await start(client(b)); edit(c);
  b.fetch = async (_, options) => { const r = JSON.parse(options.body); return b.response({...r, ok: true, deleted: false, version: 2, row: seed.steps[0]}); };
  await c.app.flush(); assert.equal(c.app.hasPending(), true);
});

test('stale reads never roll back acknowledged row versions', async () => {
  const b = backend(), c = await start(client(b)), old = b.get(); edit(c); await c.app.flush(); b.fetch = async () => b.response(old);
  await c.app.pull(); assert.equal(c.app.data.steps[0].name, 'mine'); assert.equal(c.app.versions.steps['steps-0'], 2);
});

test('poll does not reorder a table while user has focus in its editor', async () => {
  const b = backend(), c = await start(client(b)); c.context.document = {activeElement: {dataset: {t: 'steps'}}};
  b.change('steps', 'steps-0', r => ({...r, name: 'team'})); await c.app.pull();
  assert.equal(c.app.data.steps[0].name, 'first'); edit(c); await c.app.flush();
  assert.equal(c.changes.at(-1).sync, 'conflict');
});

test('new rows and deletions use stable IDs and remain safe on retry', async () => {
  const b = backend(), c = await start(client(b)); c.app.update('briefs', rows => [...rows, {name: 'new'}]); await c.app.flush();
  const id = c.app.data.briefs[0]._id; assert.equal(b.row('briefs', id).name, 'new');
  c.app.update('briefs', () => []); await c.app.flush();
  assert.equal(b.get().data.briefs.deleted.includes(id), true); assert.equal(c.app.hasPending(), false);
});

test('unmount cancels timers and unsaved changes trigger unload warning', async () => {
  const b = backend(), c = await start(client(b)); edit(c); let prevented = false;
  c.listeners.beforeunload({preventDefault: () => prevented = true}); assert.equal(prevented, true);
  c.app.stop(); assert.equal(c.jobs.size, 0); assert.equal(Object.keys(c.listeners).length, 0);
});

test('embedded component uses stable row IDs and actual sync module', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.match(html, /<script src="\.\/workspace-sync\.js"><\/script>/);
  const template = JSON.parse(html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  const code = template.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const b = server(); b.setup(); const c = client(b);
  c.context.DCLogic = class {setState(patch) { this.state = {...this.state, ...patch}; }};
  vm.runInContext(code + '\nglobalThis.App = Component;', c.context);
  const app = new c.context.App(); app.componentDidMount(); await settle();
  assert.equal(app.state.sync, 'ok');
  const vals = app.renderVals(), row = vals.tables[0].rows[0];
  vals.onCell({target: {dataset: {t: 'steps', i: row.i, k: 'status'}, value: 'Готово'}});
  await app.syncStore.flush(); assert.equal(b.row('steps', row.i).status, 'Готово');
  app.renderVals().setTab({currentTarget: {dataset: {id: 'calc'}}});
  assert.equal(app.state.tab, 'calc'); app.componentWillUnmount();
});
