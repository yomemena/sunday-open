// Sunday Open: row versions, durable receipts and a recoverable write journal.
// Bound to the user's existing spreadsheet. Run setupSundayOpen once before deploying.
var SUNDAY_SPREADSHEET_ID = '1Z0-M7YVVZqGpFVCQXRXdZwjF-T3G5qxgkCFTU3QbJX0';
var SUNDAY_DATA = ['table', 'id', 'version', 'json', 'deleted', 'updatedAt'];
var SUNDAY_HISTORY = ['mutationId', 'hash', 'time', 'table', 'id', 'action', 'baseVersion', 'version', 'before', 'after'];
var SUNDAY_PROPOSALS = ['mutationId', 'hash', 'createdAt', 'table', 'id', 'baseVersion', 'before', 'after', 'delete', 'status', 'reviewedAt', 'reviewedBy', 'reason'];
var SUNDAY_NOTIFICATIONS = ['mutationId', 'notifiedAt'];

function sundayModerated_() {
  return PropertiesService.getScriptProperties().getProperty('SUNDAY_MODERATION') === '4';
}

function sundaySheet_(ss, name, headers, create) {
  var sheet = ss.getSheetByName(name);
  if (!sheet && create) sheet = ss.insertSheet(name);
  if (sheet && create && sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  if (!sheet) throw new Error('Run setupSundayOpen first: missing ' + name);
  var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (JSON.stringify(actual) !== JSON.stringify(headers)) throw new Error('Unexpected headers in ' + name + '; existing data was not replaced');
  return sheet;
}

function sundayJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function sundayValidate_(op) {
  if (!op || !Object.prototype.hasOwnProperty.call(SUNDAY_SEED, op.table) || op.table === 'calc' ||
      typeof op.id !== 'string' || op.id.indexOf(op.table + '-') !== 0 || !/^[a-zA-Z0-9_-]{1,120}$/.test(op.id) ||
      typeof op.mutationId !== 'string' || !/^[a-zA-Z0-9_:-]{1,180}$/.test(op.mutationId) ||
      !Number.isSafeInteger(op.baseVersion) || op.baseVersion < 0 || typeof op.del !== 'boolean' ||
      (op.del ? op.row !== null : !op.row || Array.isArray(op.row) || op.row._id !== op.id || !Number.isFinite(op.row._o))) {
    throw new Error('Invalid operation');
  }
  if (JSON.stringify(op).length > 30000) throw new Error('Row is too large');
}

function sundayHash_(op) {
  var text = JSON.stringify([op.table, op.id, op.baseVersion, op.del, op.row]);
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function sundayPut_(state, record) {
  var key = record.table + '|' + record.id;
  var line = [record.table, record.id, record.version, record.deleted ? '' : JSON.stringify(record.row), record.deleted, record.time];
  if (state.index[key]) state.sheet.getRange(state.index[key], 1, 1, 6).setValues([line]);
  else { state.sheet.appendRow(line); state.index[key] = state.sheet.getLastRow(); }
  state.records[key] = record;
}

function sundayRead_(ss) {
  var sheet = sundaySheet_(ss, 'Data', SUNDAY_DATA, false);
  var history = sundaySheet_(ss, 'SundayHistory', SUNDAY_HISTORY, false);
  var state = {sheet: sheet, history: history, records: {}, index: {}, receipts: {}};
  sheet.getDataRange().getValues().slice(1).forEach(function (line, i) {
    if (!line[0] && !line[1]) return;
    var record = {table: line[0], id: line[1], version: Number(line[2]),
      row: line[4] === true || line[4] === 'TRUE' ? null : JSON.parse(line[3]),
      deleted: line[4] === true || line[4] === 'TRUE', time: line[5]};
    sundayValidate_({table: record.table, id: record.id, baseVersion: record.version - 1,
      del: record.deleted, row: record.row, mutationId: 'validate'});
    var key = record.table + '|' + record.id;
    if (state.records[key]) throw new Error('Duplicate Data row: ' + key);
    state.records[key] = record;
    state.index[key] = i + 2;
  });
  // ponytail: scan the small event-office journal; add an index if history volume becomes material.
  history.getDataRange().getValues().slice(1).forEach(function (line) {
    if (!line[0]) return;
    var record = {table: line[3], id: line[4], version: Number(line[7]),
      row: line[5] === 'delete' ? null : JSON.parse(line[9]), deleted: line[5] === 'delete', time: line[2]};
    var op = {table: record.table, id: record.id, baseVersion: Number(line[6]),
      del: record.deleted, row: record.row, mutationId: line[0]};
    sundayValidate_(op);
    if (record.version !== op.baseVersion + 1 || sundayHash_(op) !== line[1] || state.receipts[op.mutationId]) throw new Error('Invalid SundayHistory entry');
    state.receipts[op.mutationId] = {hash: line[1], record: record};
    var key = record.table + '|' + record.id, current = state.records[key];
    if (current && current.version >= record.version) return;
    if ((current ? current.version : 0) !== op.baseVersion) throw new Error('Gap in journal: ' + key);
    // A crash after journal append cannot lose the accepted operation: finish its projection now.
    sundayPut_(state, record);
  });
  return state;
}

function sundayReply_(op, record, ok) {
  return {protocol: 3, ok: ok, table: op.table, id: op.id, mutationId: op.mutationId,
    version: record ? record.version : 0, row: record ? record.row : null,
    deleted: !record || record.deleted, error: ok ? null : 'conflict'};
}

function sundayApply_(state, op) {
  sundayValidate_(op);
  var hash = sundayHash_(op), receipt = state.receipts[op.mutationId];
  if (receipt) {
    if (receipt.hash !== hash) throw new Error('Mutation ID was reused with different contents');
    return sundayReply_(op, receipt.record, true);
  }
  var key = op.table + '|' + op.id, current = state.records[key];
  if ((current ? current.version : 0) !== op.baseVersion) return sundayReply_(op, current, false);
  var record = {table: op.table, id: op.id, version: op.baseVersion + 1,
    row: op.row, deleted: op.del, time: new Date()};
  // Append the complete operation first; Data is its repairable projection.
  state.history.appendRow([op.mutationId, hash, record.time, op.table, op.id,
    op.del ? 'delete' : current ? 'update' : 'create', op.baseVersion, record.version,
    current && !current.deleted ? JSON.stringify(current.row) : '', op.del ? '' : JSON.stringify(op.row)]);
  state.receipts[op.mutationId] = {hash: hash, record: record};
  sundayPut_(state, record);
  return sundayReply_(op, record, true);
}

function sundayWithLock_(fn) {
  var protocol = sundayModerated_() ? 4 : 3;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return sundayJson_({protocol: protocol, ok: false, error: 'busy'});
  try { return sundayJson_(fn()); }
  catch (error) { return sundayJson_({protocol: protocol, ok: false, error: String(error)}); }
  finally { lock.releaseLock(); }
}

function doGet() {
  return sundayWithLock_(function () {
    if (PropertiesService.getScriptProperties().getProperty('SUNDAY_READY') !== '3') throw new Error('Run setupSundayOpen first');
    var state = sundayRead_(SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID)), data = {};
    Object.keys(SUNDAY_SEED).filter(function (t) { return t !== 'calc'; }).forEach(function (t) {
      data[t] = {rows: {}, deleted: [], deletedVersions: {}};
    });
    Object.keys(state.records).forEach(function (key) {
      var r = state.records[key], tb = data[r.table];
      if (r.deleted) { tb.deleted.push(r.id); tb.deletedVersions[r.id] = r.version; }
      else tb.rows[r.id] = {row: r.row, v: r.version};
    });
    SpreadsheetApp.flush();
    return {protocol: sundayModerated_() ? 4 : 3, ok: true, data: data};
  });
}

function doPost(e) {
  return sundayWithLock_(function () {
    var op = JSON.parse(e && e.postData && e.postData.contents || 'null');
    var protocol = sundayModerated_() ? 4 : 3;
    if (!op || op.protocol !== protocol) return {protocol: protocol, ok: false, error: 'upgrade_required'};
    if (PropertiesService.getScriptProperties().getProperty('SUNDAY_READY') !== '3') throw new Error('Run setupSundayOpen first');
    var state = sundayRead_(SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID));
    var result = protocol === 4 ? sundayPropose_(state, op) : sundayApply_(state, op);
    SpreadsheetApp.flush();
    return result;
  });
}

function sundayReviewUser_() {
  var email = Session.getActiveUser().getEmail().trim().toLowerCase();
  var allowed = JSON.parse(PropertiesService.getScriptProperties().getProperty('SUNDAY_MODERATOR_EMAILS') || '[]');
  if (!email || !Array.isArray(allowed) || !allowed.some(function (x) { return typeof x === 'string' && x.trim().toLowerCase() === email; })) {
    throw new Error('Only a configured moderator with a verified Google account can review changes');
  }
  return email;
}

function setupSundayModeration() {
  sundayReviewUser_();
  setupSundayOpen();
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    sundaySheet_(SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID), 'SundayProposals', SUNDAY_PROPOSALS, true);
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty('SUNDAY_MODERATION', '4');
    return 'Moderation ready. Reload the private spreadsheet to see the Sunday Open menu.';
  } finally { lock.releaseLock(); }
}

function sundayProposal_(line) {
  var op = {protocol: 4, mutationId: line[0], table: line[3], id: line[4], baseVersion: Number(line[5]),
    del: line[8] === true || line[8] === 'TRUE', row: line[8] === true || line[8] === 'TRUE' ? null : JSON.parse(line[7])};
  sundayValidate_(op);
  if (sundayHash_(op) !== line[1]) throw new Error('Invalid proposal hash');
  return op;
}

// Run once as the moderator who should receive the emails. The address stays private.
function setupSundayNotifications() {
  var email = sundayReviewUser_(), properties = PropertiesService.getScriptProperties();
  if (!sundayModerated_()) throw new Error('Enable moderation first');
  MailApp.getRemainingDailyQuota(); // Request mail permission before installing the trigger.
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var existing = properties.getProperty('SUNDAY_NOTIFICATION_EMAIL');
    if (existing && existing !== email) throw new Error('Notifications already belong to another moderator');
    sundaySheet_(SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID), 'SundayNotifications', SUNDAY_NOTIFICATIONS, true);
    SpreadsheetApp.flush();
    properties.setProperty('SUNDAY_NOTIFICATION_EMAIL', email);
    var installed = ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === 'sendSundayNotifications';
    });
    if (!installed) ScriptApp.newTrigger('sendSundayNotifications').timeBased().everyMinutes(5).create();
    console.log('Notifications ready: ' + email + ', every 5 minutes.');
  } finally { lock.releaseLock(); }
}

function sundayNotificationRecipient_() {
  var properties = PropertiesService.getScriptProperties();
  var email = properties.getProperty('SUNDAY_NOTIFICATION_EMAIL');
  var allowed = JSON.parse(properties.getProperty('SUNDAY_MODERATOR_EMAILS') || '[]');
  if (!email || email !== Session.getEffectiveUser().getEmail().trim().toLowerCase() ||
      !Array.isArray(allowed) || !allowed.some(function (x) { return typeof x === 'string' && x.trim().toLowerCase() === email; })) {
    throw new Error('Run notifications as their configured moderator');
  }
  return email;
}

function sundayReviewLink_(sheet) {
  return 'https://docs.google.com/spreadsheets/d/' + SUNDAY_SPREADSHEET_ID + '/edit#gid=' + sheet.getSheetId();
}

// Independent of doPost: mail failures never undo a saved proposal.
function sendSundayNotifications() {
  if (!PropertiesService.getScriptProperties().getProperty('SUNDAY_NOTIFICATION_EMAIL')) return 'Disabled';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'Busy; retry on the next trigger';
  try {
    var email = sundayNotificationRecipient_();
    if (!sundayModerated_()) throw new Error('Moderation is not enabled');
    var ss = SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID);
    var proposals = sundaySheet_(ss, 'SundayProposals', SUNDAY_PROPOSALS, false);
    var receipts = sundaySheet_(ss, 'SundayNotifications', SUNDAY_NOTIFICATIONS, false);
    // ponytail: scan the small queue/receipt log; index them if the office outgrows Sheets.
    var sent = new Set(receipts.getDataRange().getValues().slice(1).map(function (r) { return r[0]; }));
    var pending = proposals.getDataRange().getValues().slice(1).filter(function (r) {
      return r[9] === 'pending' && !sent.has(r[0]);
    });
    if (!pending.length) return 'No new proposals';
    pending.forEach(sundayProposal_);
    if (MailApp.getRemainingDailyQuota() < 1) return 'Email quota exhausted; retry later';
    var summary = pending.slice(0, 20).map(function (r) {
      return '• ' + r[3] + ' / ' + r[4] + (r[8] === true || r[8] === 'TRUE' ? ' — удаление' : ' — изменение');
    }).join('\n');
    MailApp.sendEmail({to: email, name: 'Sunday Open',
      subject: 'Sunday Open: новые правки на одобрение — ' + pending.length,
      body: 'Новых правок: ' + pending.length + '. Они ещё ожидают одобрения.\n\nОткрыть очередь:\n' +
        sundayReviewLink_(proposals) + '\n\n' + summary + (pending.length > 20 ? '\nОстальные правки — в таблице.' : '') +
        '\n\nВыберите одну строку со статусом pending, затем меню Sunday Open → Одобрить выбранную правку или Отклонить выбранную правку.\nК моменту открытия таблицы часть правок уже может быть рассмотрена.'});
    // Receipt follows send: a failure retries instead of silently losing an alert.
    // A process crash between mail and receipt can cause a duplicate digest.
    var now = new Date();
    receipts.getRange(receipts.getLastRow() + 1, 1, pending.length, 2).setValues(pending.map(function (r) { return [r[0], now]; }));
    SpreadsheetApp.flush();
    console.log('Notification sent for ' + pending.length + ' new proposals.');
    return 'Sent: ' + pending.length;
  } finally { lock.releaseLock(); }
}

function sendSundayNotificationTest() {
  sundayReviewUser_();
  var email = sundayNotificationRecipient_();
  var sheet = sundaySheet_(SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID), 'SundayProposals', SUNDAY_PROPOSALS, false);
  MailApp.sendEmail({to: email, name: 'Sunday Open', subject: 'Sunday Open: проверка уведомлений',
    body: 'Это проверочное письмо. Уведомления о новых правках проверяются примерно раз в 5 минут.\n\nОчередь одобрения:\n' + sundayReviewLink_(sheet) + '\n\nЭто письмо не создаёт правок и не меняет данные сайта.'});
  console.log('Test notification sent to ' + email);
}

function sundayDecision_(state, sheet, index, line) {
  var op = sundayProposal_(line);
  if (line[9] === 'approving') {
    // The moderator's durable decision is written BEFORE the journal operation.
    // A retry can finish a partially applied approval without a second publication.
    if (!line[10] || !line[11]) throw new Error('Approval has no reviewer');
    var result = sundayApply_(state, op);
    SpreadsheetApp.flush();
    line[9] = result.ok ? 'approved' : 'conflict';
    line[12] = result.ok ? '' : 'The published row changed; submit a new proposal';
    sheet.getRange(index, 1, 1, SUNDAY_PROPOSALS.length).setValues([line]);
  }
  if (line[9] === 'approved') {
    var receipt = state.receipts[op.mutationId];
    if (!receipt || receipt.hash !== line[1]) throw new Error('Approved proposal has no journal receipt');
    return Object.assign(sundayReply_(op, receipt.record, true), {protocol: 4, status: 'approved'});
  }
  if (line[9] === 'conflict') {
    return Object.assign(sundayReply_(op, state.records[op.table + '|' + op.id], false), {protocol: 4, status: 'conflict'});
  }
  if (line[9] !== 'pending' && line[9] !== 'rejected') throw new Error('Invalid proposal status');
  return {protocol: 4, ok: line[9] === 'pending', status: line[9], table: op.table, id: op.id,
    mutationId: op.mutationId, error: line[9] === 'rejected' ? 'rejected' : null};
}

function sundayPropose_(state, op) {
  sundayValidate_(op);
  var ss = SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID);
  var sheet = sundaySheet_(ss, 'SundayProposals', SUNDAY_PROPOSALS, false);
  // ponytail: scan the small review queue; index it when the office outgrows this sheet.
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] !== op.mutationId) continue;
    if (rows[i][1] !== sundayHash_(op)) throw new Error('Mutation ID was reused with different contents');
    return sundayDecision_(state, sheet, i + 1, rows[i]);
  }
  // Pre-moderation writes may already have a durable receipt. Never reapply them.
  var receipt = state.receipts[op.mutationId];
  if (receipt) {
    if (receipt.hash !== sundayHash_(op)) throw new Error('Mutation ID was reused with different contents');
    return Object.assign(sundayReply_(op, receipt.record, true), {protocol: 4, status: 'approved'});
  }
  var current = state.records[op.table + '|' + op.id];
  if ((current ? current.version : 0) !== op.baseVersion) {
    return Object.assign(sundayReply_(op, current, false), {protocol: 4, status: 'conflict'});
  }
  if (rows.filter(function (r) { return r[9] === 'pending' || r[9] === 'approving'; }).length >= 1000) throw new Error('Review queue is full; draft remains on your device');
  sheet.appendRow([op.mutationId, sundayHash_(op), new Date(), op.table, op.id, op.baseVersion,
    current && !current.deleted ? JSON.stringify(current.row) : '', op.del ? '' : JSON.stringify(op.row),
    op.del, 'pending', '', '', '']);
  return {protocol: 4, ok: true, status: 'pending', table: op.table, id: op.id, mutationId: op.mutationId, error: null};
}

function onOpen() {
  if (!sundayModerated_()) return;
  SpreadsheetApp.getUi().createMenu('Sunday Open')
    .addItem('Одобрить выбранную правку', 'approveSundayProposal')
    .addItem('Отклонить выбранную правку', 'rejectSundayProposal').addToUi();
}

function approveSundayProposal() { return sundayReviewSelected_(true); }
function rejectSundayProposal() { return sundayReviewSelected_(false); }

function sundayReviewSelected_(approve) {
  var email = sundayReviewUser_();
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sheet = ss.getActiveSheet(), range = sheet.getActiveRange();
  if (ss.getId() !== SUNDAY_SPREADSHEET_ID || sheet.getName() !== 'SundayProposals' ||
      !range || range.getRow() < 2 || range.getNumRows() !== 1) throw new Error('Select one proposal row in SundayProposals');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var state = sundayRead_(ss), index = range.getRow();
    var line = sheet.getRange(index, 1, 1, SUNDAY_PROPOSALS.length).getValues()[0];
    sundayProposal_(line);
    if (line[9] === 'pending') {
      line[9] = approve ? 'approving' : 'rejected';
      line[10] = new Date(); line[11] = email; line[12] = approve ? '' : 'Rejected by moderator';
      sheet.getRange(index, 1, 1, SUNDAY_PROPOSALS.length).setValues([line]);
      SpreadsheetApp.flush();
    }
    var result = sundayDecision_(state, sheet, index, line);
    SpreadsheetApp.flush();
    return result.status;
  } finally { lock.releaseLock(); }
}

function setupSundayOpen() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(SUNDAY_SPREADSHEET_ID);
    sundaySheet_(ss, 'Data', SUNDAY_DATA, true);
    // Existing History has a different layout. Keep it and all original sheets intact.
    sundaySheet_(ss, 'SundayHistory', SUNDAY_HISTORY, true);
    var state = sundayRead_(ss), legacy = ss.getSheetByName('SharedTabs');
    if (PropertiesService.getScriptProperties().getProperty('SUNDAY_READY') === '3') return 'Already ready';
    var legacyRows = legacy ? legacy.getDataRange().getValues().slice(1) : [], seenTables = {};
    legacyRows.forEach(function (line) {
      if (!Object.prototype.hasOwnProperty.call(SUNDAY_SEED, line[0]) || line[0] === 'calc') return;
      if (seenTables[line[0]]) throw new Error('Duplicate legacy table: ' + line[0]);
      seenTables[line[0]] = true;
    });
    legacyRows.forEach(function (line) {
      var t = line[0];
      if (!Object.prototype.hasOwnProperty.call(SUNDAY_SEED, t) || t === 'calc') return;
      var rows = null;
      [line[1], line[2]].forEach(function (cell) {
        if (typeof cell !== 'string' || cell.trim().charAt(0) !== '[') return;
        var parsed = JSON.parse(cell);
        if (Array.isArray(parsed)) {
          if (rows && JSON.stringify(rows) !== JSON.stringify(parsed)) throw new Error('Ambiguous legacy table: ' + t);
          rows = parsed;
        }
      });
      if (!rows) throw new Error('Cannot migrate legacy table: ' + t);
      var properties = PropertiesService.getScriptProperties(), hashKey = 'SUNDAY_MIGRATION_HASH:' + t;
      var hash = sundayHash_({table: t, id: 'source', baseVersion: 0, del: false, row: rows});
      var oldHash = properties.getProperty(hashKey);
      if (oldHash && oldHash !== hash) throw new Error('Legacy source changed during migration: ' + t);
      properties.setProperty(hashKey, hash);
      var previouslyMigrated = Object.keys(state.receipts).some(function (id) { return id.indexOf('migration:' + t + ':') === 0; });
      var existing = Object.keys(state.records).some(function (key) { return state.records[key].table === t; });
      if (existing && !previouslyMigrated) return;
      var seen = {};
      rows.forEach(function (row, i) {
        row = Object.assign({}, row, {_id: row._id || t + '-' + i, _o: row._o === undefined ? i : row._o});
        if (seen[row._id]) throw new Error('Duplicate legacy ID');
        seen[row._id] = true;
        if (!state.records[t + '|' + row._id]) sundayApply_(state, {table: t, id: row._id, row: row,
          del: false, baseVersion: 0, mutationId: 'migration:' + t + ':' + row._id});
      });
      SUNDAY_SEED[t].forEach(function (row) {
        if (!seen[row._id] && !state.records[t + '|' + row._id]) sundayApply_(state, {table: t, id: row._id,
          row: null, del: true, baseVersion: 0, mutationId: 'migration:' + t + ':' + row._id});
      });
    });
    Object.keys(SUNDAY_SEED).filter(function (t) { return t !== 'calc'; }).forEach(function (t) {
      var existing = Object.keys(state.records).some(function (key) { return state.records[key].table === t; });
      var seeded = Object.keys(state.receipts).some(function (id) { return id.indexOf('seed:' + t + ':') === 0; });
      if (existing && !seeded) return;
      SUNDAY_SEED[t].forEach(function (row) {
        if (!state.records[t + '|' + row._id]) sundayApply_(state, {table: t, id: row._id, row: row,
          del: false, baseVersion: 0, mutationId: 'seed:' + t + ':' + row._id});
      });
    });
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty('SUNDAY_READY', '3');
    return 'Ready: Data and SundayHistory; original sheets preserved';
  } finally { lock.releaseLock(); }
}

// Initial rows match the shipped site. SharedTabs migration takes precedence.
var SUNDAY_SEED = {"steps":[{"step":"1. Утвердить темы и миссии 4 воскресений","who":"Амина Мукаметхан, Санжар, Темірлан","what":"Пройти вкладку «4 воскресенья», поправить темы, подтвердить состав ивентов","deadline":"21.10","result":"Финальный план на 4 недели","status":"В работе","_id":"steps-0","_o":0},{"step":"2. Подать заявки на все локации","who":"Сайлау Мұхаммед (Events)","what":"Одна пакетная заявка в ДНИ и ДСВР на все 4 воскресенья по вкладке «Локации»","deadline":"22.10","result":"Подтверждённые брони","status":"Не начато","_id":"steps-1","_o":1},{"step":"3. Назначить хостов и заполнить 5W1H","who":"Хосты ивентов, контроль: Жиенбай Темірлан","what":"Каждый хост заполняет бриф во вкладке «Шаблон 5W1H»","deadline":"за 10 дней до","result":"Бриф на каждый ивент","status":"Не начато","_id":"steps-2","_o":2},{"step":"4. Стартовый обзвон партнёров","who":"Женисбек Амина (Partners)","what":"Распределить строки «Коммуникаций» по команде, отправить первые письма","deadline":"23.10","result":"10+ контактов в работе","status":"Не начато","_id":"steps-3","_o":3},{"step":"5. Запуск медиа","who":"Билялова Адия (Media)","what":"Создать аккаунты Instagram и TikTok, запустить недельный цикл","deadline":"24.10","result":"Первые 3 публикации","status":"Не начато","_id":"steps-4","_o":4},{"step":"6. Набор волонтёров","who":"Aizere Yeres","what":"Объявить набор минимум за 7 дней по числу из калькулятора","deadline":"D-7","result":"Укомплектованные смены","status":"Не начато","_id":"steps-5","_o":5},{"step":"7. Еженедельная планёрка","who":"Амина Мукаметхан","what":"Понедельник: статусы всех вкладок, блокеры, решения за 30 минут","deadline":"каждый пн","result":"Обновлённые статусы","status":"Не начато","_id":"steps-6","_o":6},{"step":"8. Отчёт после ивента","who":"Хост ивента","what":"Цифры (люди, деньги), фидбэк участников, выводы","deadline":"D+2","result":"Отчёт и правки в шаблон","status":"Не начато","_id":"steps-7","_o":7}],"sundays":[{"date":"25.10","theme":"Game Day","mission":"Дать студентам AITU площадку для соревнования и познакомить их с Sunday Open","audience":"Студенты AITU","events":"AITU Gaming (Valorant, Brawl Stars, UFC) · Армрестлинг, локальный тур · KINO QUIZ (TYF × KINO Club)","locations":"Кибер-арена · Спортзал · Актовый зал","owner":"Жиенбай Темірлан","status":"В работе","_id":"sundays-0","_o":0},{"date":"01.11","theme":"Тёплое воскресенье","mission":"Снизить стресс в середине семестра и открыто поговорить о ментальном здоровье","audience":"Студенты вузов, молодые взрослые","events":"Утренний рейв с DJ и кофе · Групповая сессия с психологом · Разбор фильма с психологом (платный, с едой)","locations":"Атриум / Open Space · Отымекен Space · Актовый зал","owner":"Санжар","status":"Не начато","_id":"sundays-1","_o":1},{"date":"08.11","theme":"Семейное воскресенье","mission":"Открыть AITU для семей города и показать детям и школьникам IT и творчество","audience":"Дети, школьники, родители","events":"Детские мастер-классы · IT-квиз команды Polaris для школьников · Экскурсия в кибер-арену и VR","locations":"Maker Space · Отымекен Space · Кибер-арена","owner":"Жиенбай Темірлан","status":"Не начато","_id":"sundays-2","_o":2},{"date":"15.11","theme":"Сила сообщества","mission":"Выйти на город: открытый турнир и помощь приюту","audience":"Студенты вузов Астаны, взрослые","events":"Армрестлинг Open (городской, с федерацией) · Сбор и поход в приют · Киноквиз #2","locations":"Спортзал · Атриум · Актовый зал","owner":"Санжар","status":"Не начато","_id":"sundays-3","_o":3}],"comms":[{"event":"Армрестлинг","whom":"Федерация армрестлинга Астаны","ask":"Судьи и правила для Open 15.11, весовые категории, анонс в их каналах","channel":"Письмо + встреча","owner":"Крылов Виталий, Арсен Абдрашидов","deadline":"24.10","status":"В работе","_id":"comms-0","_o":0},{"event":"Армрестлинг","whom":"Тренажёрные залы и фитнес-клубы","ask":"Участники для Open, призы (абонементы), показательный бой тренера","channel":"Визит + DM","owner":"Амангелді Малика","deadline":"30.10","status":"Не начато","_id":"comms-1","_o":1},{"event":"Армрестлинг","whom":"Спортклубы других вузов Астаны","ask":"Команды на Open, промокоды для их студентов","channel":"Клуб → клуб","owner":"Ерасыл Рысбай","deadline":"01.11","status":"Не начато","_id":"comms-2","_o":2},{"event":"Армрестлинг","whom":"Спортпит и спортивные бренды","ask":"Призы и продукция в обмен на зону и упоминания","channel":"Письмо + партнёрский пакет","owner":"Акибаева Айғаным","deadline":"05.11","status":"Не начато","_id":"comms-3","_o":3},{"event":"AITU Gaming","whom":"Компьютерные клубы, бренды периферии","ask":"Призы, стенд, в будущем межвузовская лига","channel":"Письмо","owner":"Женисбек Амина","deadline":"27.10","status":"Не начато","_id":"comms-4","_o":4},{"event":"KINO","whom":"Кинотеатры города","ask":"Билеты как призы, анонс в их соцсетях","channel":"Письмо","owner":"Эльнура","deadline":"28.10","status":"Не начато","_id":"comms-5","_o":5},{"event":"Тёплое воскресенье","whom":"Кофейни Астаны","ask":"Кофе на рейв по бартеру за зону и контент","channel":"Визит","owner":"Жагуфарова Дария","deadline":"25.10","status":"Не начато","_id":"comms-6","_o":6},{"event":"Тёплое воскресенье","whom":"DJ AITU + внешние диджеи","ask":"Сет 60–90 минут, условия, свой звук или наш","channel":"DM","owner":"Хамет Мағжан","deadline":"25.10","status":"Не начато","_id":"comms-7","_o":7},{"event":"Тёплое воскресенье","whom":"Психологическая служба AITU, частные психологи","ask":"Групповая сессия и разбор фильма, гонорар или бартер","channel":"Письмо + звонок","owner":"Нұрбақыт Алимұрат","deadline":"24.10","status":"Не начато","_id":"comms-8","_o":8},{"event":"Семейное воскресенье","whom":"Школы робототехники и творчества, школы города","ask":"Мастер-классы для детей, анонс для родителей","channel":"Письмо + звонок","owner":"Михайлов Андрей","deadline":"31.10","status":"Не начато","_id":"comms-9","_o":9},{"event":"Семейное воскресенье","whom":"Команда Polaris","ask":"IT-квиз для школьников: вопросы, ведущий","channel":"DM","owner":"Арғынғазы Бақдәулет","deadline":"27.10","status":"Не начато","_id":"comms-10","_o":10},{"event":"Сила сообщества","whom":"Приюты для животных","ask":"Список нужд, дата визита, правила для волонтёров","channel":"Звонок","owner":"Aizere Yeres","deadline":"05.11","status":"Не начато","_id":"comms-11","_o":11},{"event":"Все","whom":"Городские паблики и блогеры Астаны","ask":"Анонсы, бартер на участие","channel":"DM","owner":"Болатов Ардак","deadline":"еженедельно","status":"Не начато","_id":"comms-12","_o":12}],"guests":[{"who":"Психолог с опытом групповой работы","event":"01.11 · Сессия и разбор фильма","value":"Безопасный разговор о стрессе, выгорании","how":"Психслужба AITU, рекомендации","owner":"Нұрбақыт Алимұрат","_id":"guests-0","_o":0},{"who":"DJ AITU и 1–2 внешних DJ","event":"01.11 · Утренний рейв","value":"Атмосфера, повод прийти утром","how":"Клубы, DM","owner":"Хамет Мағжан","_id":"guests-1","_o":1},{"who":"Чемпион или тренер по армрестлингу","event":"15.11 · Армрестлинг Open","value":"Показательный бой, мастер-класс по технике","how":"Через федерацию","owner":"Крылов Виталий","_id":"guests-2","_o":2},{"who":"Кинокритик или режиссёр","event":"01.11 · Разбор фильма","value":"Второй взгляд на фильм рядом с психологом","how":"TYF × KINO Club","owner":"Эльнура","_id":"guests-3","_o":3},{"who":"IT-специалисты, выпускники AITU","event":"08.11 · Семейное воскресенье","value":"Короткие истории «как я стал разработчиком» для школьников","how":"Карьерный центр, выпускники","owner":"Михайлов Андрей","_id":"guests-4","_o":4},{"who":"Городские блогеры","event":"Любое воскресенье","value":"Охват за пределами AITU","how":"DM, бартер","owner":"Болатов Ардак","_id":"guests-5","_o":5},{"who":"Основатели стартапов","event":"Маркет и pop-up","value":"Презентации продуктов, тест на аудитории","how":"Startups-направление","owner":"Юсупов Алан","_id":"guests-6","_o":6}],"audiences":[{"audience":"Дети 7–12","idea":"Детские мастер-классы","format":"Maker Space: робототехника, рисование, поделки","cadence":"Раз в 2 недели","direction":"Programs & Clubs","_id":"audiences-0","_o":0},{"audience":"Школьники","idea":"IT-квиз Polaris, экскурсия в VR","format":"Командный квиз, профориентация","cadence":"Раз в месяц","direction":"Programs & Clubs","_id":"audiences-1","_o":1},{"audience":"Студенты","idea":"Киноквиз / разбор фильма","format":"Квиз и разбор с психологом, по очереди","cadence":"Раз в 2 недели","direction":"Programs & Clubs","_id":"audiences-2","_o":2},{"audience":"Студенты, молодые взрослые","idea":"Утренний рейв с кофе","format":"DJ-сет, кофе, без алкоголя","cadence":"Раз в месяц","direction":"Events & Production","_id":"audiences-3","_o":3},{"audience":"Взрослые","idea":"Групповая сессия с психологом","format":"Малая группа до 15 человек","cadence":"Раз в месяц","direction":"Community","_id":"audiences-4","_o":4},{"audience":"Все","idea":"Сбор и поход в приют","format":"Сбор вещей и корма, выезд группой","cadence":"Раз в месяц","direction":"Community & Volunteers","_id":"audiences-5","_o":5},{"audience":"Пенсионеры","idea":"Цифровая грамотность","format":"Студенты учат пользоваться смартфоном и госуслугами","cadence":"Пилот в декабре","direction":"Community & Volunteers","_id":"audiences-6","_o":6},{"audience":"Все","idea":"Тематический день-карнавал","format":"Дресс-код, игры, станции, конкурс костюмов","cadence":"Раз в сезон","direction":"Events & Production","_id":"audiences-7","_o":7}],"bank":[{"idea":"Конные прогулки","audience":"Студенты, семьи","why":"Выезд за город, погода в ноябре рискованная","when":"Весна","owner":"Events & Production","_id":"bank-0","_o":0},{"idea":"Субботник и пикник «Сол Жерде»","audience":"Все","why":"Нужна тёплая погода и согласование с акиматом","when":"Апрель–май","owner":"Community & Volunteers","_id":"bank-1","_o":1},{"idea":"Новогодний карнавал","audience":"Все","why":"Лучшая точка для дня с дресс-кодом","when":"20 или 27.12","owner":"Events & Production","_id":"bank-2","_o":2},{"idea":"Цифровая грамотность для пенсионеров","audience":"Пенсионеры","why":"Нужны партнёры (ЦОН, советы ветеранов) и подготовка волонтёров","when":"Декабрь","owner":"Aizere Yeres","_id":"bank-3","_o":3},{"idea":"Маркет стартапов и pop-up-зоны","audience":"Студенты, взрослые","why":"Нужно собрать участников и условия","when":"Декабрь","owner":"Startups & Commercial","_id":"bank-4","_o":4},{"idea":"Межвузовская лига армрестлинга","audience":"Студенты вузов","why":"Логичный следующий шаг после Open 15.11","when":"Декабрь","owner":"Events & Production","_id":"bank-5","_o":5}],"pillars":[{"type":"Развлекательный","goal":"Охват и узнаваемость, люди хотят быть частью","share":"40%","formats":"Reels, TikTok-тренды, мемы, закулисье","examples":"Лучшие моменты армрестлинга, «угадай фильм за 3 секунды»","_id":"pillars-0","_o":0},{"type":"Основательный","goal":"Объясняет, зачем существует Sunday Open и миссию каждого дня","share":"30%","formats":"Карусели, истории хостов, итоги с цифрами","examples":"«Почему мы говорим о стрессе», хост рассказывает, как придумал ивент","_id":"pillars-1","_o":1},{"type":"Продающий","goal":"Регистрации, билеты, партнёры","share":"30%","formats":"Анонсы, обратный отсчёт, офферы партнёрам","examples":"«Осталось 20 мест», «Ранняя цена до четверга», кейс для спонсора","_id":"pillars-2","_o":2}],"channels":[{"channel":"Instagram","role":"Витрина бренда, главный канал анонсов","freq":"3 поста + сторис ежедневно","formats":"Карусели, Reels, сторис с опросами","owner":"Билялова Адия","_id":"channels-0","_o":0},{"channel":"TikTok","role":"Охват новой аудитории","freq":"3 ролика в неделю","formats":"Тренды, закулисье, нарезки","owner":"Дудкин Александр","_id":"channels-1","_o":1},{"channel":"Telegram-канал","role":"Расписание, регистрация, напоминания","freq":"4–5 сообщений в неделю","formats":"Анонс недели, ссылки, напоминания","owner":"Ермекова Линара","_id":"channels-2","_o":2},{"channel":"Сайт sunday-open","role":"Программа, регистрация, архив","freq":"Обновление к понедельнику","formats":"Карточки ивентов, форма регистрации","owner":"WebSpace: Жагуфарова Дария","_id":"channels-3","_o":3},{"channel":"Каналы AITU","role":"Охват студентов, официальный анонс","freq":"1–2 раза в неделю","formats":"Пост-анонс, напоминание","owner":"Болатов Ардак","_id":"channels-4","_o":4},{"channel":"Сторис клубов","role":"Аудитория хостов","freq":"К каждому ивенту","formats":"Репосты, свои анонсы хостов","owner":"@your_gera","_id":"channels-5","_o":5}],"cycle":[{"day":"Пн","what":"Анонс темы и миссии воскресенья","channel":"Instagram, Telegram, сайт","type":"Основательный","owner":"Билялова Адия","_id":"cycle-0","_o":0},{"day":"Вт","what":"Программа дня и регистрация","channel":"Instagram, Telegram, каналы AITU","type":"Продающий","owner":"Ермекова Линара","_id":"cycle-1","_o":1},{"day":"Ср","what":"Знакомство с хостом или гостем","channel":"Instagram Reels, TikTok","type":"Основательный","owner":"Дудкин Александр","_id":"cycle-2","_o":2},{"day":"Чт","what":"Тизер, тренд, ранняя цена заканчивается","channel":"TikTok, сторис","type":"Развлекательный","owner":"Дудкин Александр","_id":"cycle-3","_o":3},{"day":"Пт","what":"Напоминание, партнёры дня","channel":"Telegram, сторис клубов","type":"Продающий","owner":"@your_gera","_id":"cycle-4","_o":4},{"day":"Сб","what":"Закулисье подготовки","channel":"Сторис, TikTok","type":"Развлекательный","owner":"Болатов Ардак","_id":"cycle-5","_o":5},{"day":"Вс","what":"Live-сторис, фото и видео","channel":"Все","type":"Развлекательный","owner":"Media, все","_id":"cycle-6","_o":6},{"day":"Пн+1","what":"Итоги: фото, цифры, благодарности партнёрам","channel":"Instagram, Telegram","type":"Основательный","owner":"Билялова Адия","_id":"cycle-7","_o":7}],"weekly":[{"week":"20–25.10","story":"Запуск Sunday Open: что это и зачем","videos":"Тизер трёх ивентов, лучшие моменты 25.10","cta":"Регистрация на турниры","_id":"weekly-0","_o":0},{"week":"26.10–01.11","story":"«Тёплое воскресенье»: о стрессе без стыда","videos":"Утро рейва, интервью с психологом","cta":"Купить билет на разбор фильма","_id":"weekly-1","_o":1},{"week":"02–08.11","story":"AITU открыт для семей","videos":"Дети в Maker Space, школьники в VR","cta":"Запись ребёнка на мастер-класс","_id":"weekly-2","_o":2},{"week":"09–15.11","story":"Город vs кампус: армрестлинг Open","videos":"Промо федерации, сбор для приюта","cta":"Заявка на турнир, принести корм","_id":"weekly-3","_o":3}],"bookings":[{"date":"25.10","event":"AITU Gaming","location":"Кибер-арена (C1.3.267Р)","time":"уточнить","via":"ДНИ","submit":"—","owner":"Сайлау Мұхаммед","status":"Готово","_id":"bookings-0","_o":0},{"date":"25.10","event":"Армрестлинг, локальный тур","location":"Спортзал","time":"уточнить","via":"ДСВР","submit":"21.10","owner":"Сайлау Мұхаммед","status":"В работе","_id":"bookings-1","_o":1},{"date":"25.10","event":"KINO QUIZ","location":"Актовый зал","time":"16:00 или 18:00","via":"ДНИ","submit":"21.10","owner":"Сайлау Мұхаммед","status":"В работе","_id":"bookings-2","_o":2},{"date":"01.11","event":"Утренний рейв","location":"Атриум / Open Space","time":"10:00–12:00","via":"ДНИ","submit":"25.10","owner":"Вирясова Кира","status":"Не начато","_id":"bookings-3","_o":3},{"date":"01.11","event":"Групповая сессия с психологом","location":"Отымекен Space","time":"13:00–14:30","via":"ДНИ","submit":"25.10","owner":"Вирясова Кира","status":"Не начато","_id":"bookings-4","_o":4},{"date":"01.11","event":"Разбор фильма с психологом","location":"Актовый зал","time":"17:00–20:00","via":"ДНИ","submit":"25.10","owner":"Вирясова Кира","status":"Не начато","_id":"bookings-5","_o":5},{"date":"08.11","event":"Детские мастер-классы","location":"Maker Space","time":"11:00–13:00","via":"ДНИ","submit":"01.11","owner":"Адильбаев Мирас","status":"Не начато","_id":"bookings-6","_o":6},{"date":"08.11","event":"IT-квиз Polaris","location":"Отымекен Space","time":"14:00–16:00","via":"ДНИ","submit":"01.11","owner":"Адильбаев Мирас","status":"Не начато","_id":"bookings-7","_o":7},{"date":"08.11","event":"Экскурсия в кибер-арену и VR","location":"Кибер-арена","time":"13:00–14:00","via":"ДНИ","submit":"01.11","owner":"Адильбаев Мирас","status":"Не начато","_id":"bookings-8","_o":8},{"date":"15.11","event":"Армрестлинг Open","location":"Спортзал","time":"12:00–17:00","via":"ДСВР","submit":"08.11","owner":"Крылов Виталий","status":"Не начато","_id":"bookings-9","_o":9},{"date":"15.11","event":"Сбор для приюта","location":"Атриум","time":"весь день","via":"ДНИ","submit":"08.11","owner":"Aizere Yeres","status":"Не начато","_id":"bookings-10","_o":10},{"date":"15.11","event":"Киноквиз #2","location":"Актовый зал","time":"18:00–20:00","via":"ДНИ","submit":"08.11","owner":"Вирясова Кира","status":"Не начато","_id":"bookings-11","_o":11}],"risks":[{"risk":"Мало регистраций","prob":"Средняя","impact":"Высокая","prevent":"Регистрация открыта за 7 дней, ранняя цена, отслеживание в среду","planb":"Если в четверг меньше 50% от плана: усиленный анонс через клубы и паблики, объединить ивенты","owner":"Билялова Адия","_id":"risks-0","_o":0},{"risk":"Локация не подтверждена или занята","prob":"Средняя","impact":"Высокая","prevent":"Пакетная заявка на 4 недели вперёд, письменное подтверждение","planb":"Резервный зал за каждым ивентом (Open Space, библиотека)","owner":"Сайлау Мұхаммед","_id":"risks-1","_o":1},{"risk":"Волонтёры не пришли","prob":"Средняя","impact":"Средняя","prevent":"Набор за 7 дней, подтверждение в пятницу, +20% к числу","planb":"Резервный список, перераспределение из Events","owner":"Aizere Yeres","_id":"risks-2","_o":2},{"risk":"Спонсор отказался, призов нет","prob":"Средняя","impact":"Средняя","prevent":"Договорённость письменно до D-5, мерч университета как база","planb":"Мерч AITU + сертификаты, приз от направления","owner":"Женисбек Амина","_id":"risks-3","_o":3},{"risk":"Техника кибер-арены или интернет","prob":"Низкая","impact":"Высокая","prevent":"Тест за день, админ на месте","planb":"Перенос части матчей онлайн, сдвиг расписания","owner":"Хамет Мағжан","_id":"risks-4","_o":4},{"risk":"Травма на армрестлинге","prob":"Низкая","impact":"Высокая","prevent":"Судья федерации, медик или аптечка, расписка участника","planb":"Остановка поединка, вызов скорой, протокол","owner":"Крылов Виталий","_id":"risks-5","_o":5},{"risk":"Дети без сопровождения или без согласия","prob":"Средняя","impact":"Высокая","prevent":"Регистрация через родителя, согласие на фото, браслеты","planb":"Родитель остаётся в зоне, ребёнок без согласия не снимается","owner":"Адильбаев Мирас","_id":"risks-6","_o":6},{"risk":"Сессия с психологом превращается в терапию","prob":"Низкая","impact":"Высокая","prevent":"Квалифицированный специалист, правила группы, до 15 человек","planb":"Контакты психслужбы на месте для индивидуальной помощи","owner":"Нұрбақыт Алимұрат","_id":"risks-7","_o":7},{"risk":"Еда в зале не согласована","prob":"Средняя","impact":"Средняя","prevent":"Согласовать с ДНИ, учесть аллергии в регистрации","planb":"Фуршет в Атриуме вместо зала","owner":"Вирясова Кира","_id":"risks-8","_o":8},{"risk":"Негатив из-за цен для гостей","prob":"Средняя","impact":"Средняя","prevent":"Подача цены по рекомендации из «Калькулятора»","planb":"Промокоды вузам-партнёрам","owner":"Билялова Адия","_id":"risks-9","_o":9},{"risk":"Хост выпал за 2–3 дня","prob":"Низкая","impact":"Высокая","prevent":"Бриф 5W1H заполнен, у ивента есть второй ответственный","planb":"Второй ответственный ведёт по брифу","owner":"Жиенбай Темірлан","_id":"risks-10","_o":10},{"risk":"Погода для выездных ивентов","prob":"Высокая","impact":"Средняя","prevent":"Выездное переносим на весну, приют только с транспортом","planb":"Сбор для приюта в Атриуме без выезда","owner":"Aizere Yeres","_id":"risks-11","_o":11}],"requests":[{"from":"ДНИ и ДСВР","what":"Регламент и сроки брони, свободные залы по воскресеньям, вместимость","why":"Пакетная бронь на 4 недели","deadline":"21.10","status":"Не начато","_id":"requests-0","_o":0},{"from":"Университет","what":"Объём мерча на ивенты, можно ли принимать оплату за вход и через что","why":"Модель входа и призы в калькуляторе","deadline":"23.10","status":"Не начато","_id":"requests-1","_o":1},{"from":"Университет","what":"Шаблон расписки для спортивных ивентов и согласия родителей","why":"Армрестлинг Open, Семейное воскресенье","deadline":"28.10","status":"Не начато","_id":"requests-2","_o":2},{"from":"Хосты ивентов","what":"Заполненный бриф 5W1H","why":"Без брифа ивент не ставится в план","deadline":"за 10 дней","status":"Не начато","_id":"requests-3","_o":3},{"from":"Programs & Clubs","what":"2–3 идеи от каждого клуба с аудиторией и миссией","why":"Банк идей на декабрь","deadline":"27.10","status":"Не начато","_id":"requests-4","_o":4},{"from":"Partners & Fundraising","what":"Общая база контактов партнёров","why":"Коммуникации по всем ивентам","deadline":"25.10","status":"Не начато","_id":"requests-5","_o":5},{"from":"Media","what":"Доступы к аккаунтам, первые 3 публикации, фото 25.10","why":"Недельный цикл","deadline":"24.10","status":"Не начато","_id":"requests-6","_o":6},{"from":"Community & Volunteers","what":"Число волонтёров по каждому ивенту, сверенное с калькулятором","why":"Набор за 7 дней","deadline":"D-7","status":"Не начато","_id":"requests-7","_o":7},{"from":"WebSpace","what":"Форма регистрации на сайте, поле «студент AITU», ранняя цена","why":"Регистрация и прогноз явки","deadline":"27.10","status":"Не начато","_id":"requests-8","_o":8}],"materials":[{"item":"Партнёрский пакет (презентация)","purpose":"Что получает спонсор: аудитория, зоны, упоминания, цифры","who":"Partners + Media","deadline":"25.10","status":"Не начато","_id":"materials-0","_o":0},{"item":"Шаблоны писем партнёрам","purpose":"Первое письмо, follow-up, благодарность","who":"Женисбек Амина","deadline":"24.10","status":"Не начато","_id":"materials-1","_o":1},{"item":"Форма регистрации","purpose":"Единая для всех ивентов, с полем «откуда узнали»","who":"WebSpace","deadline":"27.10","status":"Не начато","_id":"materials-2","_o":2},{"item":"Форма обратной связи","purpose":"QR после каждого ивента, 5 вопросов","who":"Aizere Yeres","deadline":"25.10","status":"Не начато","_id":"materials-3","_o":3},{"item":"Шаблон отчёта после ивента","purpose":"Цифры, фидбэк, деньги, выводы","who":"Амина Мукаметхан","deadline":"26.10","status":"Не начато","_id":"materials-4","_o":4},{"item":"Инструктаж для волонтёров","purpose":"Одна страница на ивент: роли, тайминг, контакты","who":"Aizere Yeres","deadline":"D-3","status":"Не начато","_id":"materials-5","_o":5},{"item":"Брендированные шаблоны постов","purpose":"Анонс, программа, итоги в стиле бренд-бука","who":"Media","deadline":"24.10","status":"Не начато","_id":"materials-6","_o":6}],"briefs":[{"name":"AITU Gaming · 25.10","who":"Хост: AITU Gaming. Аудитория: студенты AITU. Production: Events & Production, Media: Билялова Адия.","what":"24.10 онлайн-этап Valorant 2×2. 25.10 офлайн: Valorant, Brawl Ball 3×3, UFC 1×1.","why":"Game Day: площадка для соревнования, первый контакт студентов с Sunday Open.","where":"Кибер-арена, C1.3.267Р.","when":"24–25.10, тайминг уточняется.","how":"Модель B, призы от партнёров, волонтёры: регистрация и судейство.","_id":"briefs-0","_o":0},{"name":"Армрестлинг · 25.10","who":"Студенты AITU. Ответственные менеджеры связаны с федерацией.","what":"Локальный тур, первый этап перед городским Open 15.11.","why":"Game Day + подготовка выхода на город.","where":"Спортзал.","when":"25.10, время уточняется.","how":"Мерч университета для победителей, аптечка, расписки.","_id":"briefs-1","_o":1},{"name":"KINO QUIZ · 25.10","who":"TYF × KINO Club, команды по 3–6 человек.","what":"6 раундов, 43 вопроса: постеры, предметы, саундтреки.","why":"Game Day: командная игра для студентов.","where":"Актовый зал.","when":"25.10, 16:00 или 18:00, 1,5–2 часа.","how":"Модель A, призы для 3 команд.","_id":"briefs-2","_o":2},{"name":"Новый ивент","who":"","what":"","why":"","where":"","when":"","how":"","_id":"briefs-3","_o":3}]};
