const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {server} = require('./apps-script-fixture.cjs');
function backend() {
  const b = server({steps: [{_id: 'steps-0', _o: 0, name: 'published'}], calc: []});
  b.enableModeration(); return b;
}
function propose(b) {
  const op = {protocol: 4, table: 'steps', id: 'steps-0', baseVersion: b.version('steps', 'steps-0'),
    mutationId: randomUUID(), del: false, row: {...b.row('steps', 'steps-0'), name: 'new'}};
  assert.equal(b.post(op).status, 'pending'); return op;
}

test('only a moderator can install notifications; repeat setup preserves one timer and receipts', () => {
  const b = backend();
  assert.equal(b.context.sendSundayNotifications(), 'Disabled');
  b.actor = 'stranger@example.com'; assert.throws(() => b.context.setupSundayNotifications(), /configured moderator/);
  b.actor = 'moderator@example.com'; b.context.setupSundayNotifications();
  const op = propose(b); b.context.sendSundayNotifications(); b.context.setupSundayNotifications();
  assert.equal(b.triggers.length, 1); assert.equal(b.triggers[0].minutes, 5);
  assert.equal(b.properties.get('SUNDAY_NOTIFICATION_EMAIL'), 'moderator@example.com');
  assert.equal(b.sheets.get('SundayNotifications').rows[1][0], op.mutationId);
  assert.equal(b.context.sendSundayNotifications(), 'No new proposals');
  b.properties.set('SUNDAY_MODERATOR_EMAILS', JSON.stringify(['moderator@example.com', 'other@example.com']));
  b.actor = 'other@example.com'; assert.throws(() => b.context.setupSundayNotifications(), /another moderator/);
  assert.throws(() => b.context.sendSundayNotifications(), /configured moderator/);
});

test('one digest includes existing pending and new proposals, excludes reviewed ones, and survives retries and sorting', () => {
  const b = backend(), approved = propose(b); b.moderate(approved.mutationId);
  const oldPending = propose(b), rejected = propose(b); b.moderate(rejected.mutationId, false);
  b.context.setupSundayNotifications();
  const fresh = propose(b); assert.equal(b.emails.length, 0); // doPost never sends mail
  assert.equal(b.context.sendSundayNotifications(), 'Sent: 2');
  assert.equal(b.emails[0].to, 'moderator@example.com');
  assert.match(b.emails[0].body, /Новых правок: 2/);
  assert(b.emails[0].body.includes('/' + b.context.SUNDAY_SPREADSHEET_ID + '/edit#gid=123'));
  assert.equal(b.sheets.get('SundayNotifications').rows.length, 3);
  b.post(oldPending); b.post(fresh);
  const queue = b.sheets.get('SundayProposals').rows; queue.splice(1, queue.length - 1, ...queue.slice(1).reverse());
  assert.equal(b.context.sendSundayNotifications(), 'No new proposals'); assert.equal(b.emails.length, 1);
  propose(b); assert.equal(b.context.sendSundayNotifications(), 'Sent: 1'); assert.equal(b.emails.length, 2);
});

test('mail errors and exhausted quota keep proposals durable and retry the unnotified batch', () => {
  const b = backend(); b.context.setupSundayNotifications(); const first = propose(b);
  b.failMail = true; assert.throws(() => b.context.sendSundayNotifications(), /mail unavailable/);
  const second = propose(b); // failed mail released the lock; saving still works
  b.failMail = false; b.mailQuota = 0;
  assert.match(b.context.sendSundayNotifications(), /quota exhausted/);
  assert.equal(b.sheets.get('SundayNotifications').rows.length, 1); assert.equal(b.emails.length, 0);
  assert.equal(b.post(first).status, 'pending'); assert.equal(b.post(second).status, 'pending');
  assert.equal(b.row('steps', 'steps-0').name, 'published');
  b.mailQuota = 1; assert.equal(b.context.sendSundayNotifications(), 'Sent: 2');
  assert.equal(b.sheets.get('SundayNotifications').rows.length, 3);
});

test('a crash after sending may repeat the digest but never silently marks unsent mail delivered', () => {
  const b = backend(); b.context.setupSundayNotifications(); propose(b);
  b.failNotificationReceipt = true; assert.throws(() => b.context.sendSundayNotifications(), /receipt interrupted/);
  assert.equal(b.sheets.get('SundayNotifications').rows.length, 1);
  assert.equal(b.context.sendSundayNotifications(), 'Sent: 1'); assert.equal(b.emails.length, 2);
  assert.equal(b.context.sendSundayNotifications(), 'No new proposals');
});

test('test email changes no review data; revoked moderator cannot send alerts', () => {
  const b = backend(); b.context.setupSundayNotifications(); propose(b);
  const before = JSON.stringify([...b.sheets].map(([name, s]) => [name, s.rows]));
  b.context.sendSundayNotificationTest();
  assert.match(b.emails[0].subject, /проверка уведомлений/);
  assert.equal(JSON.stringify([...b.sheets].map(([name, s]) => [name, s.rows])), before);
  b.properties.set('SUNDAY_MODERATOR_EMAILS', '[]');
  assert.throws(() => b.context.sendSundayNotifications(), /configured moderator/);
  assert.equal(b.emails.length, 1);
});
