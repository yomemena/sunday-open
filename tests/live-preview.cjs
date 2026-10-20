// Manual integration check. Writes only temporary rows to the configured TEST API.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json'), 'utf8'));
const productionScript = fs.readFileSync(path.join(root, 'apps-script.gs'), 'utf8');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(config.endpoint && !source.includes(config.endpoint), 'Use the separate preview endpoint only');
assert(config.spreadsheetId && !productionScript.includes(config.spreadsheetId), 'Use the test spreadsheet only');
const prefix = 'steps-test-' + Date.now() + '-';
const read = async () => {
  const response = await fetch(config.endpoint, {signal: AbortSignal.timeout(60000)});
  assert(response.ok); const body = await response.json();
  assert.equal(body.protocol, 3); assert.equal(body.ok, true); return body;
};
const send = async (id, version, row) => {
  const op = {protocol: 3, table: 'steps', id, baseVersion: version,
    row, del: row === null, mutationId: crypto.randomUUID()};
  return {op, result: await post(op)};
};
const post = async op => {
  const response = await fetch(config.endpoint, {method: 'POST',
    headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(op),
    signal: AbortSignal.timeout(60000)});
  assert(response.ok); return response.json();
};
(async () => {
  const before = await read();
  const seed = Object.values(before.data.steps.rows)[0].row;
  const row = (id, status) => ({...seed, _id: id, _o: Date.now(), status});
  const a = prefix + 'a', b = prefix + 'b';
  try {
    const creates = await Promise.all([send(a, 0, row(a, 'TEST A')), send(b, 0, row(b, 'TEST B'))]);
    creates.forEach(x => assert.equal(x.result.ok, true));
    const different = await Promise.all([send(a, 1, row(a, 'TEST A2')), send(b, 1, row(b, 'TEST B2'))]);
    different.forEach(x => assert.equal(x.result.ok, true));
    const competing = await Promise.all([send(a, 2, row(a, 'TEST first')), send(a, 2, row(a, 'TEST second'))]);
    assert.equal(competing.filter(x => x.result.ok).length, 1);
    assert.equal(competing.filter(x => x.result.error === 'conflict').length, 1);
    const winner = competing.find(x => x.result.ok);
    const next = await send(a, 3, row(a, 'TEST later')); assert.equal(next.result.ok, true);
    const replay = await post(winner.op); assert.equal(replay.ok, true); assert.equal(replay.version, 3);
    const after = await read();
    assert.equal(after.data.steps.rows[a].row.status, 'TEST later');
    assert.equal(after.data.steps.rows[b].row.status, 'TEST B2');
    console.log('PASS: independent rows; one winner for concurrent same-row edits; immutable retry does not overwrite later edits.');
  } finally {
    const current = await read();
    for (const id of [a, b]) {
      const entry = current.data.steps.rows[id];
      if (entry) assert.equal((await send(id, entry.v, null)).result.ok, true);
    }
    console.log('Temporary test rows removed; journal receipts retained.');
  }
})().catch(error => {console.error(error.message); process.exitCode = 1;});
