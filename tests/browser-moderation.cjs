// Live TEST-only check. A moderator must act in the private Google Sheet when ACTION is printed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json'), 'utf8'));
assert.equal(config.site, 'https://nalatka.github.io/sunday-open-test/');
assert.equal(config.spreadsheetId, '1SMOX1RNy7CipaqbvKmTLs-QYlSMZsgS0EIHH64pAsNs');
assert(!fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes(config.endpoint));
const out = path.join(root, '.preview-check'); fs.mkdirSync(out, {recursive: true});
const id = 'steps-moderation-' + Date.now(), key = 'sunday-open-test-' + config.spreadsheetId;
const report = {site: config.site, rowId: id, time: new Date().toISOString(), checks: {}};
let browser, page;
const read = async () => {
  const r = await (await fetch(config.endpoint, {signal: AbortSignal.timeout(60000)})).json();
  assert.equal(r.protocol, 4); assert.equal(r.ok, true); return r.data.steps.rows[id];
};
const post = async op => (await fetch(config.endpoint, {method: 'POST',
  headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(op), signal: AbortSignal.timeout(60000)})).json();
const proposal = async (entry, who, del = false) => {
  const row = entry ? {...entry.row, who} : {_id: id, _o: Date.now(), step: 'TEST moderation', who,
    what: 'Temporary review check', deadline: '', result: '', status: 'Не начато'};
  const op = {protocol: 4, table: 'steps', id, baseVersion: entry?.v || 0,
    row: del ? null : row, del, mutationId: crypto.randomUUID()};
  assert.equal((await post({...op, action: 'approve', approved: true})).status, 'pending'); return op;
};
const action = (decision, op) => {
  const record = {decision, table: 'steps', id, mutationId: op.mutationId};
  fs.writeFileSync(path.join(out, 'moderation-action.json'), JSON.stringify(record, null, 2));
  console.log('ACTION in private SundayProposals:', JSON.stringify(record));
};
const waitServer = async predicate => {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    if (predicate(await read())) return;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error('Timed out waiting for the private moderator action');
};
const waitStatus = text => page.getByRole('status').filter({hasText: text}).waitFor({timeout: 300000});
const field = () => page.locator(`textarea[data-t="steps"][data-i="${id}"][data-k="who"]`);
const request = () => page.evaluate(({key, id}) => {
  const active = sessionStorage.getItem(key + ':active-draft');
  return JSON.parse(localStorage.getItem(active)).pending['steps|' + id].request;
}, {key, id});
const snapshot = async name => {
  await page.getByRole('button', {name: 'Запуск', exact: true}).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path: path.join(out, name + '.png')});
};
(async () => {
  assert.equal(await read(), undefined);
  const create = await proposal(null, 'TEST approved initial');
  assert.equal(await read(), undefined); report.checks.forgedApprovalCannotPublish = true;
  action('approve-create', create);
  await waitServer(entry => entry?.row.who === 'TEST approved initial');
  report.checks.explicitApprovalPublishes = true;
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
  await page.goto(config.site, {waitUntil: 'domcontentloaded'});
  await waitStatus('Все правки сохранены');
  await page.locator('#preview-offline-state').filter({hasText: 'Доступ без интернета готов'}).waitFor({timeout: 60000});
  await field().fill('TEST awaiting rejection'); await waitStatus('Ожидает одобрения');
  const rejected = await request(); assert.equal((await read()).row.who, 'TEST approved initial');
  const legacy = await post({...rejected, protocol: 3}); assert.equal(legacy.error, 'upgrade_required');
  report.checks.oldProtocolCannotPublish = true;
  await snapshot('moderation-01-awaiting'); action('reject-edit', rejected);
  await waitStatus('Правка отклонена');
  assert.equal(await field().inputValue(), 'TEST awaiting rejection');
  assert.equal((await read()).row.who, 'TEST approved initial');
  report.checks.rejectionKeepsDraftAndPublishedRow = true;
  await context.setOffline(true);
  await field().fill('TEST revised offline');
  await page.reload({waitUntil: 'domcontentloaded'}); await field().waitFor();
  assert.equal(await field().inputValue(), 'TEST revised offline');
  await context.setOffline(false); await waitStatus('Ожидает одобрения');
  const revised = await request(); assert.notEqual(revised.mutationId, rejected.mutationId);
  assert.equal((await read()).row.who, 'TEST approved initial');
  report.checks.offlineReloadStillRequiresApproval = true;
  await snapshot('moderation-02-reloaded'); action('approve-revised', revised);
  await waitStatus('Все правки сохранены');
  assert.equal((await read()).row.who, 'TEST revised offline');
  report.checks.approvalAcknowledgedByClient = true;
  await snapshot('moderation-03-approved');
})().catch(async error => {
  report.failure = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(out, 'moderation-failure.png')}).catch(() => {});
  console.error(error.message);
}).finally(async () => {
  if (browser) await browser.close();
  try {
    const entry = await read();
    if (entry) {const del = await proposal(entry, '', true); action('approve-delete', del); await waitServer(value => !value);}
    report.cleanup = 'temporary published row removed';
  } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'moderation-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
