const SPREADSHEET_ID = '18HPUEmLmW4DhH8iTL88-emdoLkXxlK4w6LuZYdeTzBQ';
const HISTORY_TAB = '宜蘭行程同步紀錄';

function doGet() {
  return json_({service: 'yilan-itinerary'});
}

function doPost(event) {
  try {
    const body = event.postData.contents;
    if (body.length > 1000000) return json_({error: 'too_large'});
    const request = JSON.parse(body);
    if (request.action !== 'read' && request.action !== 'save') return json_({error: 'invalid_request'});

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const book = SpreadsheetApp.openById(SPREADSHEET_ID);
      let sheet = book.getSheetByName(HISTORY_TAB);
      const lastRow = sheet ? sheet.getLastRow() : 0;
      const revision = Math.max(0, lastRow - 1);
      if (request.action === 'read') {
        const tripData = revision
          ? JSON.parse(sheet.getRange(lastRow, 3, 1, sheet.getLastColumn() - 2).getValues()[0]
              .map(part => String(part).slice(1)).join(''))
          : null;
        return json_({revision, tripData, canEdit: true});
      }
      if (request.revision !== revision) return json_({error: 'conflict'});
      if (!validTrip_(request.tripData)) return json_({error: 'invalid_data'});
      if (!sheet) sheet = book.insertSheet(HISTORY_TAB);
      if (!lastRow) sheet.appendRow(['版本', '儲存時間', '行程資料']);
      const payload = JSON.stringify(request.tripData);
      const chunks = [];
      for (let start = 0; start < payload.length;) {
        let end = Math.min(start + 20000, payload.length);
        const lastUnit = payload.charCodeAt(end - 1);
        if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) end--;
        chunks.push('|' + payload.slice(start, end));
        start = end;
      }
      const row = [revision + 1, new Date(), ...chunks];
      if (row.length > sheet.getMaxColumns()) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
      }
      sheet.appendRow(row);
      SpreadsheetApp.flush();
      return json_({revision: revision + 1});
    } finally {
      lock.releaseLock();
    }
  } catch {
    return json_({error: 'storage_unavailable'});
  }
}

function validTrip_(trip) {
  if (!trip || typeof trip !== 'object') return false;
  const validId = id => typeof id === 'string' && /^(?:(?:spot|rest)-[0-9]+|custom-[a-zA-Z0-9-]{1,80})$/.test(id);
  const places = trip.customItems ?? [];
  const deleted = trip.deletedItemIds ?? [];
  if (!Array.isArray(places) || !Array.isArray(deleted) || !deleted.every(validId)) return false;
  if (!places.every(place => place && validId(place.id) && place.id.startsWith('custom-')
      && ['attraction', 'restaurant'].includes(place.type)
      && ['name', 'tag', 'location', 'desc', 'highlight', 'mapUrl'].every(key => typeof place[key] === 'string'))) return false;
  return ['day1', 'day2', 'day3'].every(day => {
    const schedule = trip[day];
    if (Array.isArray(schedule)) return schedule.every(validId);
    return schedule && Array.isArray(schedule.ids) && schedule.ids.every(validId)
      && schedule.notes && typeof schedule.notes === 'object' && !Array.isArray(schedule.notes)
      && Object.values(schedule.notes).every(note => typeof note === 'string');
  });
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
