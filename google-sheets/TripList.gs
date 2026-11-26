const TRIP_LIST_TAB = '旅行列表';
const TRIP_LIST_API = 'https://yilan-trip-fish-20261116.codexllllllll.chatgpt.site';
const NEW_TRAVEL_LIST_DATABASE_ID = '1OjsMsJtqPqOa6pPrtJgY5xkH3AgALXnVGdNOXUv5CJo';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('旅行列表')
    .addItem('重新整理列表', 'refreshTripList')
    .addItem('新增空白旅程', 'createListedTrip')
    .addItem('刪除選取旅程', 'removeListedTrip')
    .addItem('重設所選旅程密碼', 'resetListedTripPassword')
    .addSeparator()
    .addItem('匯入現有網站資料', 'migrateWebsiteTrips')
    .addItem('連接旅行列表資料庫', 'connectTravelListDatabase')
    .addToUi();
}

function refreshTripList() {
  runTripListAction_(() => writeTripList_(manageListedTrip_('travel-list').trips));
}

function connectTravelListDatabase() {
  runTripListAction_(() => {
    connectTravelListDatabase_(NEW_TRAVEL_LIST_DATABASE_ID);
    SpreadsheetApp.getActiveSpreadsheet().toast('已連接旅行列表資料庫');
  });
}

function connectTravelListDatabase_(id) {
    const properties = PropertiesService.getScriptProperties();
    if (properties.getProperty(TRAVEL_READY) !== 'true') throw new Error('請先完成現有旅程的匯入。');
    const result = travelWithLock_(details => {
      const book = SpreadsheetApp.openById(id);
      const existing = book.getSheetByName(TRAVEL_LIST_DATABASE_TAB);
      if (existing?.getLastRow() && properties.getProperty(TRAVEL_LIST_DATABASE_ID) !== id) {
        throw new Error('新試算表已有同名的資料庫分頁，請確認後再連接。');
      }
      const database = existing || book.insertSheet(TRAVEL_LIST_DATABASE_TAB);
      database.setFrozenRows(1);
      database.setColumnWidth(2, 240);
      database.setColumnWidths(3, 2, 112);
      database.getRange(1, 1, 1, 5).setBackground('#0a507b').setFontColor('#ffffff').setFontWeight('bold');
      writeTravelListDatabase_(database, travelListSummaries_(details, true));
      SpreadsheetApp.flush();
      properties.setProperty(TRAVEL_LIST_DATABASE_ID, id);
      properties.deleteProperty(TRAVEL_LIST_DATABASE_DIRTY);
      return {ok:true};
    });
    if (!result.ok) throw new Error('目前沒有可連接的網站行程資料。');
}

function createListedTrip() {
  runTripListAction_(() => {
    manageListedTrip_('travel-create');
    refreshAfterTripListChange_('已新增空白旅程');
  });
}

function selectedListedTrip_(ui) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getActiveSheet();
  const selection = sheet.getActiveRange();
  if (sheet.getName() !== TRIP_LIST_TAB || !selection || selection.getRow() < 2 || selection.getNumRows() !== 1) {
    ui.alert('請在「旅行列表」分頁選取一筆旅程。');
    return;
  }
  const [title, , , id] = sheet.getRange(selection.getRow(), 1, 1, 4).getDisplayValues()[0];
  if (id !== 'owner-itinerary' && !/^trip-[0-9a-f-]{36}$/.test(id)) {
    ui.alert('這一列沒有旅程，請先重新整理列表。');
    return;
  }
  return {title, id};
}

function removeListedTrip() {
  const ui = SpreadsheetApp.getUi();
  const trip = selectedListedTrip_(ui);
  if (!trip) return;
  const {title, id} = trip;
  if (ui.alert('刪除旅程', '確定要從網站移除「' + title + '」嗎？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  runTripListAction_(() => {
    manageListedTrip_('travel-delete', id);
    refreshAfterTripListChange_('已刪除旅程');
  });
}

function resetListedTripPassword() {
  const ui = SpreadsheetApp.getUi();
  const trip = selectedListedTrip_(ui);
  if (!trip) return;
  const response = ui.prompt('重設所選旅程密碼',
    '請為「' + trip.title + '」輸入新的 6 位數字密碼。儲存後，原密碼會失效。', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const password = response.getResponseText();
  if (!/^[0-9]{6}$/.test(password)) {
    ui.alert('密碼須為 6 位數字。');
    return;
  }
  runTripListAction_(() => {
    const result = resetStoredTripPassword_(trip.id, password);
    if (result.error === 'not_ready') throw new Error('請先從選單匯入現有網站資料。');
    if (result.error) throw new Error('找不到該旅程，請重新整理列表。');
    SpreadsheetApp.getActiveSpreadsheet().toast('已重設旅程密碼');
  });
}

function manageListedTrip_(action, id) {
  const result = travelWithLock_(sheet => runTravelAction_(sheet, {action,id}, true));
  if (result.error === 'not_ready') throw new Error('請先從選單匯入現有網站資料。');
  if (result.error) throw new Error('找不到該旅程，請重新整理列表。');
  return result;
}

function readLegacyWebsite_(path) {
  const response = UrlFetchApp.fetch(TRIP_LIST_API + path, {
    followRedirects:false, muteHttpExceptions:true
  });
  const status = response.getResponseCode();
  if (status !== 200) throw new Error('舊網站暫時無法讀取，尚未匯入任何資料。');
  return JSON.parse(response.getContentText());
}

function migrateWebsiteTrips() {
  runTripListAction_(() => {
    const properties = PropertiesService.getScriptProperties();
    if (properties.getProperty(TRAVEL_READY) === 'true') throw new Error('資料已匯入，請使用「重新整理列表」。');
    const {trips} = readLegacyWebsite_('/api/trips');
    if (!Array.isArray(trips)) throw new Error('舊網站回傳的旅行列表無法讀取。');
    const rows = trips.slice().reverse().map(trip => {
      const path = '/api/itinerary' + (trip.id ? '?trip=' + encodeURIComponent(trip.id) : '');
      const {tripData, revision, locked} = readLegacyWebsite_(path);
      if (locked) throw new Error('有旅程設定了編輯密碼。請先解除舊站鎖定，匯入後再於新版設定。');
      const empty = {ids:[],notes:{}};
      const data = tripData ?? {title:trip.title,day1:empty,day2:empty,day3:empty};
      if (!validTrip_(data)) throw new Error('有一趟旅程的格式無法讀取，尚未匯入任何資料。');
      return travelRow_(trip.id ?? ORIGINAL_TRIP_ID, Math.max(revision || 0, 1), data);
    });
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (properties.getProperty(TRAVEL_READY) === 'true') throw new Error('資料已匯入。');
      const book = SpreadsheetApp.openById(SPREADSHEET_ID);
      let sheet = book.getSheetByName(TRAVEL_DATA_TAB);
      if (!sheet) sheet = book.insertSheet(TRAVEL_DATA_TAB);
      if (sheet.getLastRow() > 1) throw new Error('已有網站行程資料，請先確認是否完成匯入。');
      writeTravelRows_(sheet, 1, [['旅程 ID','版本','行程資料'], ...rows]);
      sheet.hideSheet();
      SpreadsheetApp.flush();
      properties.setProperty(TRAVEL_READY, 'true');
    } finally {
      lock.releaseLock();
    }
    refreshAfterTripListChange_('已匯入 ' + trips.length + ' 趟旅程');
  });
}

function writeTripList_(trips) {
  if (PropertiesService.getScriptProperties().getProperty(TRAVEL_LIST_DATABASE_ID)) return;
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(TRIP_LIST_TAB);
  if (!sheet) {
    sheet = book.insertSheet(TRIP_LIST_TAB);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 240);
    sheet.setColumnWidths(2, 2, 112);
    sheet.hideColumns(4);
    sheet.getRange(1, 1, 1, 4).setBackground('#0a507b').setFontColor('#ffffff').setFontWeight('bold');
  }
  const rows = [['旅程名稱', '出發日', '回程日', '旅程 ID'], ...trips.map(trip => [
    /^[=+\-@']/.test(trip.title) ? "'" + trip.title : trip.title,
    trip.departureDate || '', trip.returnDate || '', trip.id || 'owner-itinerary'
  ])];
  const previousLastRow = sheet.getLastRow();
  const maxRows = sheet.getMaxRows();
  if (rows.length > maxRows) sheet.insertRowsAfter(maxRows, rows.length - maxRows);
  sheet.getRange(1, 1, rows.length, 4).setNumberFormat('@').setValues(rows);
  if (previousLastRow > rows.length) {
    sheet.getRange(rows.length + 1, 1, previousLastRow - rows.length, 4).clearContent();
  }
}

function refreshAfterTripListChange_(message) {
  try {
    writeTripList_(manageListedTrip_('travel-list').trips);
  } catch {
    SpreadsheetApp.getUi().alert(message + '。試算表尚未更新，請選「重新整理列表」。');
    return;
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(message);
}

function runTripListAction_(action) {
  try {
    action();
  } catch (error) {
    SpreadsheetApp.getUi().alert(error.message || '無法完成操作，請稍後再試。');
  }
}
