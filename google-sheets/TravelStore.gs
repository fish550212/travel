const TRAVEL_DATA_TAB = '網站行程資料';
const TRAVEL_READY = 'travel-store-ready';
const TRAVEL_LOCK_SECRET = 'travel-lock-secret';
const ORIGINAL_TRIP_ID = 'owner-itinerary';
const TRAVEL_LIST_DATABASE_ID = 'travel-list-database-id';
const TRAVEL_LIST_DATABASE_DIRTY = 'travel-list-database-dirty';
const TRAVEL_LIST_DATABASE_TAB = '旅行列表資料庫';

function travelRequest_(request) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(TRAVEL_READY) !== 'true') return {error:'not_ready'};
  return travelWithLock_(sheet => runTravelAction_(sheet, request));
}

function travelPasswordDigest_(password, salt) {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty(TRAVEL_LOCK_SECRET);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty(TRAVEL_LOCK_SECRET, secret);
  }
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(salt + ':' + password, secret));
}

function newTravelEditLock_(password) {
  const salt = Utilities.getUuid();
  return {salt, digest:travelPasswordDigest_(password, salt), displayPassword:password};
}

function resetStoredTripPassword_(id, password) {
  return travelWithLock_(sheet => {
    const record = travelRecords_(sheet).find(entry => entry.id === id && !entry.tripData.deleted);
    if (!record) return {error:'not_found'};
    const tripData = {...record.tripData, editLock:newTravelEditLock_(password)};
    const dirty = markTravelListDirty_();
    writeTravelRows_(sheet, record.row, [travelRow_(id, record.revision + 1, tripData)]);
    refreshTravelListAfterWrite_(sheet, dirty);
    return {ok:true};
  });
}

function travelWithLock_(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(TRAVEL_DATA_TAB);
    if (!sheet) return {error:'not_ready'};
    const result = action(sheet);
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function travelRecords_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    .map(([id, revision, ...parts], index) => ({
      id, revision, row:index + 2,
      tripData:id ? JSON.parse(parts.map(part => String(part).slice(1)).join('')) : null
    })).filter(record => record.id);
}

function travelRow_(id, revision, tripData) {
  const payload = JSON.stringify(tripData);
  const parts = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + 20000, payload.length);
    const last = payload.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    parts.push('|' + payload.slice(start, end));
    start = end;
  }
  return [id, revision, ...parts];
}

function writeTravelRows_(sheet, row, values) {
  const width = Math.max(sheet.getLastColumn(), ...values.map(value => value.length));
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const endRow = row + values.length - 1;
  if (sheet.getMaxRows() < endRow) sheet.insertRowsAfter(sheet.getMaxRows(), endRow - sheet.getMaxRows());
  const padded = values.map(value => [...value, ...Array(width - value.length).fill('')]);
  sheet.getRange(row, 1, values.length, width).setValues(padded);
}

function travelSummary_(record) {
  const trip = record.tripData;
  const original = record.id === ORIGINAL_TRIP_ID;
  return {
    id:original ? null : record.id,
    title:trip.title || (original ? '宜蘭旅行' : '新旅程'),
    departureDate:trip.dateRange?.departureDate ?? trip.dates?.day1 ?? '2026-12-12',
    returnDate:trip.dateRange?.returnDate ?? trip.dates?.day3 ?? '2026-12-14'
  };
}

function travelListSummaries_(sheet, includePasswords = false) {
  const records = travelRecords_(sheet).filter(record => !record.tripData.deleted).reverse();
  return records.map(record => {
    const summary = travelSummary_(record);
    return includePasswords ? {...summary, password:record.tripData.editLock?.displayPassword ?? ''} : summary;
  });
}

function writeTravelListDatabase_(database, trips) {
  const rows = [['旅程 ID','旅程名稱','出發日','回程日','編輯密碼'], ...trips.map(trip => [
    trip.id ?? ORIGINAL_TRIP_ID,
    /^[=+\-@']/.test(trip.title) ? "'" + trip.title : trip.title,
    trip.departureDate, trip.returnDate, trip.password ?? ''
  ])];
  const previousRows = database.getLastRow();
  if (rows.length > database.getMaxRows()) database.insertRowsAfter(database.getMaxRows(), rows.length - database.getMaxRows());
  database.getRange(1, 1, rows.length, 5).setNumberFormat('@').setValues(rows);
  if (previousRows > rows.length) database.getRange(rows.length + 1, 1, previousRows - rows.length, 5).clearContent();
}

function readTravelListDatabase_(details) {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty(TRAVEL_LIST_DATABASE_ID);
  if (!id) return travelListSummaries_(details);
  const database = SpreadsheetApp.openById(id).getSheetByName(TRAVEL_LIST_DATABASE_TAB);
  if (!database) throw new Error('找不到旅行列表資料庫分頁。');
  if (properties.getProperty(TRAVEL_LIST_DATABASE_DIRTY) === 'true') {
    writeTravelListDatabase_(database, travelListSummaries_(details, true));
    SpreadsheetApp.flush();
    properties.deleteProperty(TRAVEL_LIST_DATABASE_DIRTY);
  }
  const count = database.getLastRow() - 1;
  if (count < 1) return [];
  return database.getRange(2, 1, count, 4).getDisplayValues().map(([id,title,departureDate,returnDate]) => ({
    id:id === ORIGINAL_TRIP_ID ? null : id, title, departureDate, returnDate
  }));
}

function markTravelListDirty_() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty(TRAVEL_LIST_DATABASE_ID)) return false;
  properties.setProperty(TRAVEL_LIST_DATABASE_DIRTY, 'true');
  return true;
}

function refreshTravelListAfterWrite_(details, dirty) {
  if (!dirty) return;
  SpreadsheetApp.flush();
  try {
    readTravelListDatabase_(details);
  } catch {
    // The next list read retries the update from the saved itinerary.
  }
}

function runTravelAction_(sheet, request, allowLockedDeletion = false) {
  if (request.action === 'travel-list') {
    return {canEdit:true, trips:readTravelListDatabase_(sheet)};
  }
  const records = travelRecords_(sheet);
  const id = request.id ?? ORIGINAL_TRIP_ID;
  const record = records.find(entry => entry.id === id && !entry.tripData.deleted);
  const {editLock, ...visibleTrip} = record?.tripData ?? {};
  const unlocked = !editLock || (typeof request.password === 'string' && request.password.length <= 72 &&
    editLock.digest === travelPasswordDigest_(request.password, editLock.salt));
  if (request.action === 'travel-read') {
    return record ? {tripData:visibleTrip, revision:record.revision, canEdit:unlocked,passwordSupport:true,
      ...(editLock ? {locked:true,canUnlock:true} : {})} : {error:'not_found'};
  }
  if (request.action === 'travel-create') {
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    const tripId = 'trip-' + Utilities.getUuid();
    const empty = {ids:[],notes:{}};
    const trip = {title:'新旅程',dateRange:{departureDate:today,returnDate:today},day1:empty,day2:empty,day3:empty};
    const dirty = markTravelListDirty_();
    writeTravelRows_(sheet, sheet.getLastRow() + 1, [travelRow_(tripId, 1, trip)]);
    refreshTravelListAfterWrite_(sheet, dirty);
    return {id:tripId};
  }
  if (!record) return {error:'not_found'};
  if (request.action === 'travel-delete') {
    if (editLock && !allowLockedDeletion) return {error:'locked'};
    const dirty = markTravelListDirty_();
    writeTravelRows_(sheet, record.row, [travelRow_(id, record.revision + 1, {...record.tripData,deleted:true})]);
    refreshTravelListAfterWrite_(sheet, dirty);
    return {ok:true};
  }
  if (request.action !== 'travel-save') return {error:'invalid_request'};
  if (!unlocked) return {error:'locked'};
  if (request.revision !== record.revision) return {error:'conflict'};
  if (!validTrip_(request.tripData) || request.tripData.deleted !== undefined || request.tripData.editLock !== undefined) return {error:'invalid_data'};
  let nextLock = editLock;
  if (request.passwordChange === null) nextLock = undefined;
  else if (request.passwordChange !== undefined) {
    const next = request.passwordChange;
    if (typeof next !== 'string' || !/^[0-9]{6}$/.test(next)) return {error:'invalid_data'};
    nextLock = newTravelEditLock_(next);
  }
  const revision = record.revision + 1;
  const nextTrip = nextLock ? {...request.tripData,editLock:nextLock} : request.tripData;
  const previousSummary = travelSummary_(record);
  const nextSummary = travelSummary_({id,tripData:nextTrip});
  const summaryChanged = previousSummary.title !== nextSummary.title || previousSummary.departureDate !== nextSummary.departureDate ||
      previousSummary.returnDate !== nextSummary.returnDate;
  const dirty = (summaryChanged || request.passwordChange !== undefined) && markTravelListDirty_();
  writeTravelRows_(sheet, record.row, [travelRow_(id, revision, nextTrip)]);
  refreshTravelListAfterWrite_(sheet, dirty);
  return {revision};
}
