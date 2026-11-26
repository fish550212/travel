import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID, webcrypto} from 'node:crypto';

// Exercise the page's real handlers with a small DOM and a persistent cloud stub.
const nodes = new Map();
function element() {
  return {value:'',innerHTML:'',textContent:'',children:[],listeners:{},classList:{add(){},remove(){},toggle(){}},
    setAttribute(){},appendChild(child){this.children.push(child);},addEventListener(name,fn){this.listeners[name]=fn;},
    elements:{namedItem(name){return document.getElementById('field-' + name);}},
    reset(){},showModal(){this.open=true;},close(){this.open=false;}};
}
const document = {hidden:false,getElementById(id){if (!nodes.has(id)) nodes.set(id,element()); return nodes.get(id);},createElement:element,querySelectorAll(){return [];}};
let cloud = null, revision = 0;
const storage = new Map();
const context = vm.createContext({document,window:{addEventListener(){}},crypto:{randomUUID},confirm:()=>true,setInterval(){},setTimeout(){},clearTimeout(){},
  localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k) || null},
  FormData:class {constructor(form){return Object.entries(form.values);}},
  fetch:async (url,options={}) => {
    if (options.method === 'PUT') {const body=JSON.parse(options.body); assert.equal(body.revision,revision); cloud=body.tripData; revision++; return {ok:true,status:200,json:async()=>({revision})};}
    return {ok:true,json:async()=>({tripData:structuredClone(cloud),revision,canEdit:true})};
  }});
const html = fs.readFileSync('code_artifact.html','utf8');
document.title = html.match(/<title>([^<]*)<\/title>/)[1];
const deployedScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const script = deployedScript.replace(/const sheetsEndpoint = '[^']*'/, "const sheetsEndpoint = ''");
vm.runInContext(script,context);
const run = code => vm.runInContext(code,context);
await run('initFirebase()');
run('openPlaceForm()');
assert.equal(document.getElementById('place-dialog').open,true);
const deletePlaceButton = document.getElementById('delete-place');
assert.equal(deletePlaceButton.hidden,true);
const form = document.getElementById('place-form');
form.values={type:'restaurant',name:'測試 <img src=x onerror=alert(1)>',tag:'羅東鎮',location:'測試地址',desc:'第一行\n第二行',highlight:'"提醒"',mapUrl:''};
form.listeners.submit({preventDefault(){},target:form});
await new Promise(setImmediate);
assert.equal(cloud.customItems.length,1);
const id = cloud.customItems[0].id;
assert.ok(cloud.customItems[0].mapUrl.startsWith('https://www.google.com/maps/search/'));
assert.equal(run('items[0].id'),id);
assert.ok(run('displayItem(items[0]).name').includes('&lt;img'));
assert.equal(document.getElementById('place-dialog').open,false);
run('isEditing=true');
for (const day of ['day1','day2','day3']) {
  run(`addToSchedule('${id}', '${day}')`);
  await new Promise(setImmediate);
  run(`updateItemNote('${id}', '${day}', '測試備註')`);
  await new Promise(setImmediate);
}
assert.ok(cloud.day2.ids.includes(id));
const originalCount = cloud.customItems.length;
run(`openPlaceForm('${id}')`);
assert.equal(form.elements.namedItem('name').value,cloud.customItems[0].name);
assert.equal(form.elements.namedItem('desc').value,cloud.customItems[0].desc);
const originalName = cloud.customItems[0].name;
form.elements.namedItem('name').value = 'Unsaved change';
document.getElementById('place-dialog').close();
assert.equal(cloud.customItems[0].name,originalName);
run(`openPlaceForm('${id}')`);
form.values={...cloud.customItems[0],name:'Updated place',type:'attraction',location:'New address',desc:'Updated details'};
delete form.values.id;
form.listeners.submit({preventDefault(){},target:form});
await new Promise(setImmediate);
assert.equal(cloud.customItems.length,originalCount);
assert.equal(cloud.customItems[0].id,id);
assert.equal(cloud.customItems[0].name,'Updated place');
assert.equal(cloud.customItems[0].type,'attraction');
for (const day of ['day1','day2','day3']) {
  assert.ok(cloud[day].ids.includes(id));
  assert.ok(cloud[day].notes[id]);
}
deletePlaceButton.listeners.click();
assert.equal(cloud.customItems.length,1);
run('tripData={day1:{ids:[],notes:{}},day2:{ids:[],notes:{}},day3:{ids:[],notes:{}}}');
await run('initFirebase()');
assert.ok(run('items.some(item=>item.id===' + JSON.stringify(id) + ')'));
assert.equal(run('items.find(item=>item.id===' + JSON.stringify(id) + ').name'),'Updated place');
run(`openPlaceForm('${id}')`);
assert.equal(deletePlaceButton.hidden,false);
deletePlaceButton.listeners.click();
await new Promise(setImmediate);
assert.equal(cloud.customItems.length,0);
for (const day of ['day1','day2','day3']) {assert.ok(!cloud[day].ids.includes(id)); assert.equal(cloud[day].notes[id],undefined);}
run("openPlaceForm('spot-1')");
assert.equal(document.getElementById('save-place').disabled,true);
deletePlaceButton.listeners.click();
await new Promise(setImmediate);
await run('initFirebase()');
assert.ok(!run("items.some(item=>item.id==='spot-1')"));
const before=JSON.stringify(cloud);
run("openPlaceForm('spot-2'); canEdit=false");
deletePlaceButton.listeners.click();
assert.equal(JSON.stringify(cloud),before);
console.log('Passed: create, edit, prefill, cancel, stable ID and notes, cloud reload, escaping, removal and read-only guard.');

storage.clear();
let networkCalls = 0;
function openGitHubPage() {
  const page = vm.createContext({...context,
    window:{location:{hostname:'example.github.io'},addEventListener(){}},
    fetch(){networkCalls++; throw new Error('GitHub Pages has no itinerary API');}
  });
  vm.runInContext(script,page);
  return code => vm.runInContext(code,page);
}
const github = openGitHubPage();
await github('initFirebase()');
github('toggleItineraryEdit(); addToSchedule("spot-1", "day1"); updateItemNote("spot-1", "day1", "Meet at 10")');
assert.match(document.getElementById('cloud-sync-status').innerHTML,/已儲存在此瀏覽器/);
const reloaded = openGitHubPage();
await reloaded('initFirebase()');
assert.equal(reloaded('getSchedule("day1").ids[0]'),'spot-1');
assert.equal(reloaded('getSchedule("day1").notes["spot-1"]'),'Meet at 10');
assert.equal(networkCalls,0);
console.log('Passed: GitHub Pages saves and reloads itinerary edits without an API.');

const rows = [];
const sheet = {
  getLastRow: () => rows.length,
  getLastColumn: () => Math.max(...rows.map(row => row.length)),
  getMaxColumns: () => 26,
  appendRow: row => rows.push(row),
  getRange: (row, column, height, width) => ({
    getValues: () => [Array.from({length:width}, (_, i) => rows[row - 1][column - 1 + i] ?? '')]
  })
};
const workbook = {getSheetByName: () => rows.length ? sheet : null, insertSheet: () => sheet};
const gas = vm.createContext({
  SpreadsheetApp: {openById: () => workbook, flush(){}},
  LockService: {getScriptLock: () => ({waitLock(){}, releaseLock(){}})},
  ContentService: {MimeType:{JSON:'json'},createTextOutput: body => ({setMimeType: () => body})}
});
vm.runInContext(fs.readFileSync('google-sheets/Code.gs','utf8'),gas);
const endpoint = deployedScript.match(/const sheetsEndpoint = '(https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec)'/)[1];
function openSheetsPage() {
  const page = vm.createContext({...context,
    window:{location:{hostname:'example.github.io'},addEventListener(){}},
    fetch:async (url, options) => {
      assert.equal(url,endpoint);
      assert.equal(options.method,'POST');
      const result = gas.doPost({postData:{contents:options.body}});
      return {ok:true,json:async () => JSON.parse(result)};
    }
  });
  vm.runInContext(deployedScript,page);
  return code => vm.runInContext(code,page);
}
const phone = openSheetsPage();
const stale = openSheetsPage();
await phone('initFirebase()');
await stale('initFirebase()');
phone('toggleItineraryEdit(); addToSchedule("spot-1", "day1"); updateItemNote("spot-1", "day1", "手機新增")');
await new Promise(setImmediate);
const desktop = openSheetsPage();
await desktop('initFirebase()');
assert.equal(desktop('getSchedule("day1").notes["spot-1"]'),'手機新增');
stale('toggleItineraryEdit(); addToSchedule("spot-2", "day1")');
await new Promise(setImmediate);
assert.equal(stale('syncConflict'),true);
assert.equal(rows.length,3);
console.log('Passed: Sheets access without a passphrase, append history, cross-device reload and stale revision protection.');

const detailsForm = document.getElementById('trip-details-form');
document.getElementById('edit-reminder').listeners.click();
assert.match(detailsForm.elements.namedItem('reminder').value,/里海咖啡/);
detailsForm.elements.namedItem('reminder').value = '先確認訂位\n記得帶雨具';
detailsForm.listeners.submit({preventDefault(){}});
await new Promise(setImmediate);
document.getElementById('edit-stay').listeners.click();
assert.equal(detailsForm.elements.namedItem('checkIn').value,'2026-12-12T15:00');
assert.equal(phone('stayDateTimeValue("12/14（一）11:00", defaultStay.checkOut)'),'2026-12-14T11:00');
assert.equal(phone('stayDateTimeValue("11:00", defaultStay.checkOut)'),'2026-12-14T11:00');
for (const [key, value] of Object.entries({address:'新住宿地址',checkIn:'2026-12-12T15:30',checkOut:'2026-12-14T11:00'})) {
  detailsForm.elements.namedItem(key).value = value;
}
detailsForm.listeners.submit({preventDefault(){}});
await new Promise(setImmediate);
const anotherDevice = openSheetsPage();
await anotherDevice('initFirebase()');
assert.equal(anotherDevice('tripData.reminder'),'先確認訂位\n記得帶雨具');
assert.equal(anotherDevice('tripData.stay.address'),'新住宿地址');
assert.equal(anotherDevice('tripData.stay.checkIn'),'2026-12-12T15:30');
assert.equal(anotherDevice('tripData.stay.checkOut'),'2026-12-14T11:00');
assert.equal(document.getElementById('stay-check-in').textContent,'12/12（六）15:30');
assert.equal(anotherDevice('getSchedule("day1").notes["spot-1"]'),'手機新增');
assert.equal(document.getElementById('stay-map').href,'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('新住宿地址'));
console.log('Passed: reminder and stay editing, cross-device persistence and updated lodging navigation.');

document.getElementById('edit-trip-title').listeners.click();
assert.equal(document.getElementById('trip-details-title').textContent,'旅程編輯');
assert.match(detailsForm.elements.namedItem('tripTitle').value,/宜蘭三日遊/);
assert.equal(detailsForm.elements.namedItem('departureDate').value,'2026-12-12');
assert.equal(detailsForm.elements.namedItem('returnDate').value,'2026-12-14');
detailsForm.elements.namedItem('tripTitle').value = '冬日宜蘭旅行';
detailsForm.elements.namedItem('departureDate').value = '2026-12-15';
detailsForm.listeners.submit({preventDefault(){}});
assert.equal(document.getElementById('trip-date-error').hidden,false);
detailsForm.elements.namedItem('departureDate').value = '2026-12-11';
detailsForm.elements.namedItem('returnDate').value = '2026-12-15';
detailsForm.listeners.submit({preventDefault(){}});
await new Promise(setImmediate);
const titleReloaded = openSheetsPage();
await titleReloaded('initFirebase()');
assert.equal(document.getElementById('trip-header-title').textContent,'冬日宜蘭旅行');
assert.equal(document.getElementById('trip-header-dates').textContent,'2026/12/11 – 12/15');
assert.equal(document.title,'魚你同行');
assert.equal(titleReloaded('tripData.title'),'冬日宜蘭旅行');
assert.equal(titleReloaded('tripData.dateRange.departureDate'),'2026-12-11');
assert.equal(titleReloaded('tripData.dateRange.returnDate'),'2026-12-15');
assert.match(document.getElementById('trip-day-tabs').innerHTML,/12\/11 \(五\)/);
assert.match(document.getElementById('explore-day').innerHTML,/<option value="day5">12\/15<\/option>/);
assert.equal(titleReloaded('Object.keys(dayLabels).length'),5);
assert.equal(titleReloaded('getSchedule("day1").ids.length'),0);
assert.equal(titleReloaded('getSchedule("day2").notes["spot-1"]'),'手機新增');
titleReloaded('addToSchedule("spot-1", "day5")');
await new Promise(setImmediate);
document.getElementById('edit-trip-title').listeners.click();
detailsForm.elements.namedItem('returnDate').value = '2026-12-11';
detailsForm.listeners.submit({preventDefault(){}});
await new Promise(setImmediate);
const singleDay = openSheetsPage();
await singleDay('initFirebase()');
assert.equal(singleDay('Object.keys(dayLabels).length'),1);
assert.equal(document.getElementById('trip-header-dates').textContent,'2026/12/11');
assert.equal(singleDay('getSchedule("date-2026-12-15").ids[0]'),'spot-1');
document.getElementById('edit-trip-title').listeners.click();
detailsForm.elements.namedItem('departureDate').value = '2026-12-12';
detailsForm.elements.namedItem('returnDate').value = '2026-12-15';
detailsForm.listeners.submit({preventDefault(){}});
await new Promise(setImmediate);
const restoredTrip = openSheetsPage();
await restoredTrip('initFirebase()');
assert.equal(restoredTrip('getSchedule("day1").notes["spot-1"]'),'手機新增');
assert.equal(restoredTrip('getSchedule("day4").ids[0]'),'spot-1');
document.getElementById('add-trip-day').listeners.click();
await new Promise(setImmediate);
assert.equal(restoredTrip('tripData.dateRange.returnDate'),'2026-12-16');
assert.equal(restoredTrip('currentDay'),'day5');
assert.equal(restoredTrip('getSchedule("day4").ids[0]'),'spot-1');
assert.equal(restoredTrip('getSchedule("day5").ids.length'),0);

for (const id of ['open-stay', 'nav-stay']) {
  document.getElementById(id).listeners.click();
  assert.equal(document.getElementById('trip-stay').open,true);
  document.getElementById('trip-stay').close();
}
for (const id of ['trip-stay','trip-details-dialog','place-dialog']) {
  const dialog = document.getElementById(id);
  dialog.getBoundingClientRect = () => ({left:10,right:100,top:10,bottom:100});
  const inside = {target:dialog,clientX:20,clientY:20};
  const outside = {target:dialog,clientX:5,clientY:20};
  dialog.showModal();
  dialog.listeners.pointerdown(inside);
  dialog.listeners.click(inside);
  assert.equal(dialog.open,true);
  dialog.listeners.pointerdown(inside);
  dialog.listeners.click(outside);
  assert.equal(dialog.open,true);
  dialog.listeners.pointerdown(outside);
  dialog.listeners.click(outside);
  assert.equal(dialog.open,false);
}
console.log('Passed: header opens lodging details and dialogs close on backdrop clicks.');

const previewStorage = new Map();
let previewWrites = 0;
const previewPage = vm.createContext({...context,
  window:{location:{hostname:'localhost'},addEventListener(){}},
  crypto:webcrypto, TextEncoder,
  sessionStorage:{getItem:key => previewStorage.get(key) ?? null,setItem:(key,value) => previewStorage.set(key,value),removeItem:key => previewStorage.delete(key)},
  fetch:async (url,{body}) => {
    if (JSON.parse(body).action !== 'read') previewWrites++;
    return {ok:true,json:async () => ({revision:1,canEdit:true,tripData:null})};
  }
});
vm.runInContext(deployedScript,previewPage);
const preview = code => vm.runInContext(code,previewPage);
await preview('initFirebase()');
preview('addToSchedule("spot-1", "day1"); addToSchedule("spot-2", "day1"); moveItem(1, -1, "day1")');
assert.equal(preview('getSchedule("day1").ids.join(",")'),'spot-2,spot-1');
preview('updateItemNote("spot-1", "day1", "09:30 抵達"); moveToDay("spot-1", "day1", "day2")');
assert.equal(preview('getSchedule("day2").notes["spot-1"]'),'09:30 抵達');
preview('addToSchedule("spot-3", "day2")');
document.getElementById('undo-add').listeners.click();
assert.deepEqual(JSON.parse(previewStorage.get('yilan_trip_preview')).day2.ids,['spot-1']);
assert.equal(previewWrites,0);
console.log('Passed: direct addition, reordering, moving with notes, undo and isolated preview storage.');

preview('openTripDetails("title")');
assert.equal(document.getElementById('password-fields').hidden,true);
document.getElementById('trip-details-dialog').close();
const passwordButton = document.getElementById('edit-trip-password');
const passwordIcon = document.getElementById('trip-password-icon');
assert.match(passwordIcon.className, /fa-lock-open$/);
passwordButton.listeners.click();
assert.equal(document.getElementById('password-fields').hidden,false);
assert.equal(document.getElementById('title-fields').disabled,true);
detailsForm.elements.namedItem('newTripPassword').value = '012345';
await detailsForm.listeners.submit({preventDefault(){}});
assert.ok(!previewStorage.get('yilan_trip_preview_lock').includes('012345'));
await preview('initFirebase()');
assert.equal(preview('canEdit'),false);
assert.match(passwordIcon.className, /fa-lock$/);
passwordButton.listeners.click();
assert.equal(document.getElementById('trip-unlock-dialog').open,true);
document.getElementById('trip-unlock-password').value = 'incorrect';
await document.getElementById('trip-unlock-form').listeners.submit({preventDefault(){}});
assert.equal(preview('canEdit'),false);
document.getElementById('trip-unlock-password').value = '012345';
await document.getElementById('trip-unlock-form').listeners.submit({preventDefault(){}});
assert.equal(preview('canEdit'),true);
assert.match(passwordIcon.className, /fa-lock-open$/);
passwordButton.listeners.click();
assert.equal(document.getElementById('current-trip-password-field').hidden,false);
assert.equal(document.getElementById('current-trip-password').type,'password');
document.getElementById('show-current-trip-password').listeners.click();
assert.equal(document.getElementById('current-trip-password').type,'text');
document.getElementById('trip-details-dialog').close();
passwordButton.listeners.click();
assert.equal(document.getElementById('current-trip-password').type,'password');
detailsForm.elements.namedItem('removeTripPassword').checked = true;
await detailsForm.listeners.submit({preventDefault(){}});
assert.equal(previewStorage.has('yilan_trip_preview_lock'),false);
assert.equal(previewWrites,0);
console.log('Passed: local password setup, reload, failed unlock, unlock and removal.');

preview('addToSchedule("spot-3", "day1"); addToSchedule("spot-4", "day1"); toggleItineraryEdit()');
const frames = new Map();
let nextFrame = 0;
previewPage.requestAnimationFrame = callback => {frames.set(++nextFrame, callback); return nextFrame;};
previewPage.cancelAnimationFrame = id => frames.delete(id);
previewPage.getComputedStyle = target => target.styleForTest;
previewPage.window.matchMedia = () => ({matches:false});
previewPage.window.innerHeight = 800;
document.body = {appendChild(child) { child.attached = true; }};

function reorderGesture(index) {
  const handle = element();
  handle.setPointerCapture = () => {};
  const list = {
    scrollTop:0, scrollHeight:500, clientHeight:360,
    styleForTest:{overflowY:'auto'},
    getBoundingClientRect:() => ({top:100,bottom:460}),
    querySelectorAll:() => cards,
    querySelector:() => null
  };
  const cards = Array.from({length:3}, (_, cardIndex) => {
    const styles = new Map();
    const attributes = new Set();
    return {
      dataset:{stopIndex:String(cardIndex)}, isConnected:true, styleForTest:{marginTop:'10px'},
      styles, attributes,
      style:{setProperty:(key,value) => styles.set(key,value),removeProperty:key => styles.delete(key)},
      setAttribute:key => attributes.add(key), removeAttribute:key => attributes.delete(key),
      getBoundingClientRect:() => ({top:120 + cardIndex * 90 - list.scrollTop,left:10,width:300,height:80}),
      cloneNode:() => lifted
    };
  });
  const liftedClasses = new Set(['relative']);
  const lifted = {
    attached:false, style:{}, classes:liftedClasses,
    classList:{add:value => liftedClasses.add(value),remove:value => liftedClasses.delete(value)},
    setAttribute(){}, removeAttribute(){},
    remove(){this.attached = false;},getBoundingClientRect:() => ({top:240})
  };
  previewPage.reorderFixture = {handle,card:cards[index],list,index};
  preview('bindStopReorder(reorderFixture.handle,reorderFixture.card,reorderFixture.list,reorderFixture.index,"day1")');
  const fire = (name,clientY) => handle.listeners[name]({isPrimary:true,button:0,pointerId:1,clientY});
  return {cards,list,lifted,fire};
}

const fastDrop = reorderGesture(0);
fastDrop.fire('pointerdown',150);
fastDrop.fire('pointermove',190);
assert.equal(fastDrop.lifted.attached,true);
assert.equal(fastDrop.lifted.classes.has('reorder-lifted'),true);
assert.equal(fastDrop.lifted.classes.has('relative'),false);
assert.equal(fastDrop.cards[0].attributes.has('data-dragging'),true);
// The pointer can be released before the next animation frame runs.
fastDrop.fire('pointerup',350);
assert.equal(preview('getSchedule("day1").ids.join(",")'),'spot-3,spot-4,spot-2');
assert.equal(fastDrop.lifted.attached,false);
assert.equal(frames.size,0);
const cancelled = reorderGesture(2);
cancelled.fire('pointerdown',340);
cancelled.fire('pointermove',150);
assert.equal(cancelled.cards[0].styles.get('--reorder-shift'),'90px');
cancelled.fire('pointercancel',150);
assert.equal(preview('getSchedule("day1").ids.join(",")'),'spot-3,spot-4,spot-2');
assert.equal(cancelled.cards[0].styles.has('--reorder-shift'),false);
const edgeDrag = reorderGesture(1);
edgeDrag.fire('pointerdown',240);
edgeDrag.fire('pointermove',445);
assert.equal(edgeDrag.list.scrollTop,8);
edgeDrag.fire('lostpointercapture',445);
assert.equal(edgeDrag.lifted.attached,false);
assert.equal(frames.size,0);
console.log('Passed: lifted drag, sibling shifts, fast release, edge scrolling and pointer cancellation.');

preview('openPlaceForm()');
form.values = {type:'attraction',name:'Map only',tag:'',location:'',desc:'',highlight:'',mapUrl:''};
form.listeners.submit({preventDefault(){},target:form});
assert.equal(document.getElementById('place-error').textContent,'請至少填寫地址或地圖網址。');
form.values.mapUrl = 'https://maps.app.goo.gl/example';
form.listeners.submit({preventDefault(){},target:form});
const mapOnly = JSON.parse(previewStorage.get('yilan_trip_preview')).customItems.at(-1);
assert.equal(mapOnly.location,'');
assert.equal(mapOnly.tag,'');
assert.equal(mapOnly.mapUrl,'https://maps.app.goo.gl/example');
preview(`openPlaceInfo(${JSON.stringify(mapOnly.id)})`);
assert.equal(document.getElementById('place-info-dialog').open,true);
assert.equal(document.getElementById('place-info-title').textContent,'Map only');
assert.equal(document.getElementById('place-info-address').hidden,true);
assert.equal(document.getElementById('place-info-map').href,mapOnly.mapUrl);
console.log('Passed: map link without a street address and required either-or validation.');
