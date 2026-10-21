// Manual live TEST-site check. Requires Playwright and an installed Chrome.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json'), 'utf8'));
assert.equal(config.site, 'https://nalatka.github.io/sunday-open-test/');
assert.equal(config.spreadsheetId, '1SMOX1RNy7CipaqbvKmTLs-QYlSMZsgS0EIHH64pAsNs');
assert(!fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes(config.endpoint));
const out = path.join(root, '.preview-check');
fs.mkdirSync(out, {recursive: true});
const id = 'steps-offline-' + Date.now();
const key = 'sunday-open-test-' + config.spreadsheetId;
const report = {site: config.site, time: new Date().toISOString(), rowId: id};
const read = async () => {
  const response = await fetch(config.endpoint, {signal: AbortSignal.timeout(60000)});
  assert(response.ok); const result = await response.json();
  assert.equal(result.protocol, 3); assert.equal(result.ok, true); return result.data.steps.rows[id];
};
const write = async (entry, who, remove = false) => {
  const row = entry ? {...entry.row, who} : {_id: id, _o: Date.now(), step: 'TEST offline/reload', who, what: 'Temporary browser check', deadline: '', result: '', status: 'Не начато'};
  const op = {protocol: 3, table: 'steps', id, baseVersion: entry?.v || 0,
    row: remove ? null : row, del: remove, mutationId: crypto.randomUUID()};
  const response = await fetch(config.endpoint, {method: 'POST',
    headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(op), signal: AbortSignal.timeout(60000)});
  const result = await response.json(); assert.equal(result.ok, true); return result;
};
let browser, context, page;
const draft = async () => page.evaluate(({key, id}) => {
  const active = sessionStorage.getItem(key + ':active-draft');
  const record = JSON.parse(localStorage.getItem(active));
  return {who: record.data.steps.find(row => row._id === id)?.who,
    pending: record.pending['steps|' + id], url: record.url};
}, {key, id});
const field = () => page.locator(`textarea[data-t="steps"][data-i="${id}"][data-k="who"]`);
const status = () => page.getByRole('status');
const waitSaved = async () => {
  await page.getByRole('status').filter({hasText: 'Все правки сохранены для команды'}).waitFor({timeout: 90000});
  assert.equal((await draft()).pending, undefined);
};
const snapshot = name => page.screenshot({path: path.join(out, name + '.png'), fullPage: false});
(async () => {
  const html = await (await fetch(config.site)).text();
  assert(html.includes(config.endpoint), 'Published site must use the test API');
  assert(!html.includes('AKfycbx6bzomSC7jcF0HeaDKd6NgC-WmujTvMzQNls5Ow14pxpMvDvgwOFTv-2FM6NsOsp161w'));
  await write(null, 'TEST initial');
  browser = await chromium.launch({channel: 'chrome', headless: true});
  context = await browser.newContext({viewport: {width: 1280, height: 900}});
  page = await context.newPage();
  report.dialogs = [];
  page.on('dialog', dialog => {
    report.dialogs.push(dialog.type());
    return dialog.type() === 'beforeunload' || dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss();
  });
  await page.goto(config.site, {waitUntil: 'domcontentloaded'});
  await waitSaved(); await field().waitFor();
  await page.locator('#preview-offline-state').filter({hasText: 'Доступ без интернета готов'}).waitFor({timeout: 60000});
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  report.offlineShellReady = true;

  // All browser network requests fail; server reads here use a separate Node client.
  await context.setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  const first = 'TEST offline draft survives reload ' + id;
  await field().fill(first);
  await status().filter({hasText: 'Нет подтверждения сервера'}).waitFor({timeout: 30000});
  assert.equal((await draft()).who, first); assert((await draft()).pending);
  assert.equal((await read()).row.who, 'TEST initial');
  await snapshot('01-offline-draft');
  console.log('PASS: offline edit persisted locally and did not reach the server.');
  await page.reload({waitUntil: 'domcontentloaded', timeout: 20000});
  await field().waitFor(); assert.equal(await field().inputValue(), first);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  assert((await draft()).pending);
  await page.locator('#preview-offline-state').filter({hasText: 'Без сети'}).waitFor();
  report.offlineReloadLoadsSite = true;
  const afterReload = 'TEST edited again while offline ' + id;
  await field().fill(afterReload);
  assert.equal((await draft()).who, afterReload);
  await page.getByRole('button', {name: 'Запуск', exact: true}).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await snapshot('02-offline-reload');
  await context.setOffline(false);
  // No reload or retry button: the online event must flush the restored queue.
  await waitSaved(); assert.equal(await field().inputValue(), afterReload);
  assert.equal((await read()).row.who, afterReload);
  report.offlineReloadRecovery = 'passed';
  report.automaticSendOnReconnect = 'passed';
  await snapshot('03-restored-and-saved');
  console.log('PASS: after offline reload and reconnect, the draft was recovered and acknowledged by the real TEST API.');

  // Frontend remains reachable, but its real API is unavailable during reload.
  const blockApi = route => route.abort('internetdisconnected');
  await context.route(config.endpoint + '**', blockApi);
  const second = 'TEST API outage draft ' + id;
  await field().fill(second);
  await status().filter({hasText: 'Нет подтверждения сервера'}).waitFor({timeout: 30000});
  await page.reload({waitUntil: 'domcontentloaded'});
  await field().waitFor(); assert.equal(await field().inputValue(), second);
  assert((await draft()).pending); assert.equal((await read()).row.who, afterReload);
  report.apiOutageReloadRecovery = 'passed';
  await snapshot('04-api-down-reloaded-draft');

  // Another editor saves while this browser still has its old unsent version.
  await write(await read(), 'TEST saved by another editor');
  await context.unroute(config.endpoint + '**', blockApi);
  await page.getByRole('button', {name: 'Повторить связь', exact: true}).click();
  await status().filter({hasText: 'Конфликт изменений'}).waitFor({timeout: 90000});
  assert.equal(await field().inputValue(), second);
  assert((await draft()).pending); assert.equal((await read()).row.who, 'TEST saved by another editor');
  report.offlineConflictPreservesBoth = 'passed';
  await page.getByRole('button', {name: 'Запуск', exact: true}).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await snapshot('05-recovered-conflict');
  console.log('PASS: API-outage reload preserved the draft; reconnect detected another editor without overwriting either version.');
})().catch(async error => {
  report.failure = error.stack; process.exitCode = 1;
  if (page) await snapshot('failure').catch(() => {});
  console.error(error.message);
}).finally(async () => {
  if (browser) await browser.close();
  try { const entry = await read(); if (entry) await write(entry, '', true); report.cleanup = 'temporary row removed'; }
  catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
