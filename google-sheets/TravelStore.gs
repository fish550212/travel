const TRAVEL_DATA_TAB = '網站行程資料';
const TRAVEL_READY = 'travel-store-ready';
const TRAVEL_EDITOR_DIGEST = 'travel-editor-digest';
const TRAVEL_LOCK_SECRET = 'travel-lock-secret';
const ORIGINAL_TRIP_ID = 'owner-itinerary';

function travelRequest_(request) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(TRAVEL_READY) !== 'true') return {error:'not_ready'};
  const digest = properties.getProperty(TRAVEL_EDITOR_DIGEST);
  const canEdit = Boolean(digest && typeof request.key === 'string'
    && /^[0-9a-f-]{72}$/.test(request.key) && travelDigest_(request.key) === digest);
  return travelWithLock_(sheet => runTravelAction_(sheet, request, canEdit));
}

function travelDigest_(key) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key));
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

function runTravelAction_(sheet, request, canEdit) {
  const records = travelRecords_(sheet);
  if (request.action === 'travel-list') {
    return {canEdit, trips:records.filter(record => !record.tripData.deleted).reverse().map(travelSummary_)};
  }
  const id = request.id ?? ORIGINAL_TRIP_ID;
  const record = records.find(entry => entry.id === id && !entry.tripData.deleted);
  const {editLock, ...visibleTrip} = record?.tripData ?? {};
  const unlocked = !editLock || (canEdit && typeof request.password === 'string' && request.password.length <= 72 &&
    editLock.digest === travelPasswordDigest_(request.password, editLock.salt));
  if (request.action === 'travel-read') {
    return record ? {tripData:visibleTrip, revision:record.revision, canEdit:canEdit && !!unlocked,passwordSupport:true,
      ...(editLock ? {locked:true,canUnlock:canEdit} : {})} : {error:'not_found'};
  }
  if (!canEdit) return {error:'forbidden'};
  if (request.action === 'travel-create') {
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    const tripId = 'trip-' + Utilities.getUuid();
    const empty = {ids:[],notes:{}};
    const trip = {title:'新旅程',dateRange:{departureDate:today,returnDate:today},day1:empty,day2:empty,day3:empty};
    writeTravelRows_(sheet, sheet.getLastRow() + 1, [travelRow_(tripId, 1, trip)]);
    return {id:tripId};
  }
  if (!record) return {error:'not_found'};
  if (request.action === 'travel-delete') {
    writeTravelRows_(sheet, record.row, [travelRow_(id, record.revision + 1, {...record.tripData,deleted:true})]);
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
    if (typeof next !== 'string' || !/^[\x21-\x7e]{8,72}$/.test(next)) return {error:'invalid_data'};
    const salt = Utilities.getUuid();
    nextLock = {salt,digest:travelPasswordDigest_(next,salt)};
  }
  const revision = record.revision + 1;
  const nextTrip = nextLock ? {...request.tripData,editLock:nextLock} : request.tripData;
  writeTravelRows_(sheet, record.row, [travelRow_(id, revision, nextTrip)]);
  return {revision};
}
