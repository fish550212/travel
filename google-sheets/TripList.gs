const TRIP_LIST_TAB = '旅行列表';
const TRIP_LIST_API = 'https://yilan-trip-fish-20261116.codexllllllll.chatgpt.site';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('旅行列表')
    .addItem('重新整理列表', 'refreshTripList')
    .addItem('新增空白旅程', 'createListedTrip')
    .addItem('刪除選取旅程', 'removeListedTrip')
    .addSeparator()
    .addItem('匯入現有網站資料', 'migrateWebsiteTrips')
    .addItem('產生網站編輯金鑰', 'setTripListKey')
    .addToUi();
}

function refreshTripList() {
  runTripListAction_(() => writeTripList_(manageListedTrip_('travel-list').trips));
}

function setTripListKey() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('產生網站編輯金鑰', '產生新金鑰後，試算表版的舊金鑰會失效。要繼續嗎？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  runTripListAction_(() => {
    const key = Utilities.getUuid() + Utilities.getUuid();
    PropertiesService.getScriptProperties().setProperty(TRAVEL_EDITOR_DIGEST, travelDigest_(key));
    const output = HtmlService.createHtmlOutput('<p>複製並妥善保管這把金鑰，於 GitHub 版授權時貼上。</p><input readonly style="width:95%" value="' + key + '" onclick="this.select()">');
    ui.showModalDialog(output, '網站編輯金鑰');
  });
}

function createListedTrip() {
  runTripListAction_(() => {
    manageListedTrip_('travel-create');
    refreshAfterTripListChange_('已新增空白旅程');
  });
}

function removeListedTrip() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getActiveSheet();
  const selection = sheet.getActiveRange();
  const ui = SpreadsheetApp.getUi();
  if (sheet.getName() !== TRIP_LIST_TAB || !selection || selection.getRow() < 2 || selection.getNumRows() !== 1) {
    ui.alert('請在「旅行列表」分頁選取一筆旅程。');
    return;
  }
  const [title, , , id] = sheet.getRange(selection.getRow(), 1, 1, 4).getDisplayValues()[0];
  if (id !== 'owner-itinerary' && !/^trip-[0-9a-f-]{36}$/.test(id)) {
    ui.alert('這一列沒有旅程，請先重新整理列表。');
    return;
  }
  if (ui.alert('刪除旅程', '確定要從網站移除「' + title + '」嗎？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  runTripListAction_(() => {
    manageListedTrip_('travel-delete', id);
    refreshAfterTripListChange_('已刪除旅程');
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
      const {tripData, revision} = readLegacyWebsite_(path);
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
