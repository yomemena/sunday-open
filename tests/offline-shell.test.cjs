const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../preview/offline-sw.js'), 'utf8');

test('offline shell caches only its static files and preserves the active version until tabs close', async () => {
  const scope = 'https://nalatka.github.io/sunday-open-test/';
  const events = {}, cached = new Map(), removed = [], requests = [];
  const prefix = 'sunday-open-test-shell:' + scope + ':';
  let claimed = false, fetched = false, skipped = false;
  const cache = {addAll: async files => {
    requests.push(...files);
    files.forEach(r => cached.set(r.url, new Response(r.url.endsWith('index.html') ? 'workspace-sync.__PREVIEW_VERSION__.js' : 'script')));
  }, match: async request => cached.get(typeof request === 'string' ? request : request.url)?.clone()};
  vm.runInNewContext(source, {URL, Request, self: {registration: {scope},
    skipWaiting: () => {skipped = true;},
    clients: {claim: async () => {claimed = true;}},
    addEventListener: (name, fn) => {events[name] = fn;}},
    caches: {open: async () => cache, keys: async () => [prefix + 'old', prefix + '__PREVIEW_VERSION__', 'unrelated-cache'],
      delete: async name => {removed.push(name);}},
    fetch: async () => {fetched = true; throw new Error('Offline');}});
  let work;
  events.install({waitUntil: promise => {work = promise;}}); await work;
  assert.equal(requests.length, 3); assert(requests.every(r => r.cache === 'reload'));
  assert.equal(skipped, false);
  events.activate({waitUntil: promise => {work = promise;}}); await work;
  assert.equal(claimed, true); assert.deepEqual(removed, [prefix + 'old']);
  const dispatch = request => {
    let response;
    events.fetch({request, respondWith: value => {response = value;}});
    return response;
  };
  const html = await dispatch({url: scope + '?tab=start', method: 'GET', mode: 'navigate'});
  assert.match(await html.text(), /workspace-sync/); assert.equal(fetched, false);
  assert(await dispatch({url: scope + 'preview-offline.__PREVIEW_VERSION__.js', method: 'GET'}));
  for (const request of [
    {url: 'https://script.google.com/macros/s/test/exec', method: 'GET'},
    {url: 'https://script.google.com/macros/s/test/exec', method: 'POST'},
    {url: scope + 'index.html', method: 'POST'},
    {url: 'https://nalatka.github.io/another-site/', method: 'GET', mode: 'navigate'},
    {url: scope + 'missing.js', method: 'GET'}
  ]) assert.equal(dispatch(request), undefined);
});
