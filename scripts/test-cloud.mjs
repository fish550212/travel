import assert from 'node:assert/strict';
import {api} from '../worker/api.mjs';
const records = new Map();
const env = {DB:{prepare(sql){return {
  async all(){return {results:[...records].reverse().map(([id,row])=>{
    const {title,deleted,dateRange,dates}=JSON.parse(row.payload);
    return {id,title,deleted,departureDate:dateRange?.departureDate ?? dates?.day1,returnDate:dateRange?.returnDate ?? dates?.day3};
  })};},
  bind(...args){return {
  async first(){return records.get(args[0]) || null;},
  async run(){
    if (sql.startsWith('INSERT')) {
      if (records.has(args[0]) && !sql.includes('DO UPDATE')) return {meta:{changes:0}};
      records.set(args[0],{payload:args[1],revision:1});
    } else if (sql.includes('json_set')) {
      const row=records.get(args[0]);
      if (!row || JSON.parse(row.payload).deleted) return {meta:{changes:0}};
      records.set(args[0],{payload:JSON.stringify({...JSON.parse(row.payload),deleted:1}),revision:row.revision+1});
    } else {
      const row=records.get(args[1]);
      if (!row || row.revision !== args[2] || JSON.parse(row.payload).deleted) return {meta:{changes:0}};
      records.set(args[1],{payload:args[0],revision:row.revision+1});
    }
    return {meta:{changes:1}};
  }
};}};}}};
const tripData = {day1:{ids:['spot-1'],notes:{'spot-1':'11:30 "test" <text>'}},day2:{ids:[],notes:{}},day3:{ids:[],notes:{}}};
const req = (method, user='user-a', data, origin='https://test.example') => new Request('https://test.example/api/itinerary',{method, headers:{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user === 'user-a' ? 'codexllllllll@gmail.com' : '',Origin:origin}, ...(data ? {body:JSON.stringify(data)} : {})});
assert.deepEqual(await (await api(req('GET'),env)).json(),{tripData:null,revision:0,canEdit:true});
assert.equal((await api(req('PUT','user-a',{tripData,revision:0}),env)).status,200);
assert.deepEqual((await (await api(req('GET'),env)).json()).tripData,tripData);
assert.equal((await api(req('PUT','user-a',{tripData,revision:0}),env)).status,409);
assert.equal((await api(req('PUT','user-a',{tripData,revision:1}),env)).status,200);
assert.deepEqual((await (await api(req('GET',''),env)).json()).tripData,tripData);
assert.equal((await api(req('PUT','user-a',{tripData,revision:2},'https://other.example'),env)).status,403);
assert.equal((await api(req('PUT','user-a',{tripData:{},revision:2}),env)).status,400);
console.log('Passed: private Site shared persistence across sessions, conflict protection, request validation.');

assert.equal((await api(req('PUT','visitor',{tripData,revision:2}),env)).status,403);
assert.equal((await (await api(req('GET','visitor'),env)).json()).canEdit,false);

const custom = {id:'custom-test-1',type:'restaurant',name:'測試美食 <文字>',tag:'羅東鎮',location:'測試地址',desc:'營業時間\n推薦餐點',highlight:'已訂位',mapUrl:'https://maps.google.com/?q=test'};
const withPlace = {...tripData, customItems:[custom], deletedItemIds:['spot-2']};
assert.equal((await api(req('PUT','user-a',{tripData:withPlace,revision:2}),env)).status,200);
assert.deepEqual((await (await api(req('GET','visitor'),env)).json()).tripData,withPlace);
for (const change of [{mapUrl:'javascript:alert(1)'},{name:''},{id:'spot-1'},{type:'invalid'}]) {
  assert.equal((await api(req('PUT','user-a',{tripData:{...withPlace,customItems:[{...custom,...change}]},revision:3}),env)).status,400);
}
assert.equal((await api(req('PUT','visitor',{tripData:withPlace,revision:3}),env)).status,403);
assert.equal((await api(req('PUT','user-a',{tripData:{...withPlace,customItems:[]},revision:3}),env)).status,200);
assert.deepEqual((await (await api(req('GET'),env)).json()).tripData.customItems,[]);
console.log('Passed: custom place round trip, removal, validation and owner permissions.');

const day5 = {ids:['spot-2'],notes:{'spot-2':'16:00'}};
const dateRange = {departureDate:'2026-12-29',returnDate:'2027-01-02'};
const extendedTrip = {...tripData, day5, dateRange};
assert.equal((await api(req('PUT','user-a',{tripData:extendedTrip,revision:4}),env)).status,200);
assert.deepEqual((await (await api(req('GET'),env)).json()).tripData,extendedTrip);
const singleDayTrip = {...tripData, 'date-2027-01-02':day5, dateRange:{...dateRange,returnDate:dateRange.departureDate}};
assert.equal((await api(req('PUT','user-a',{tripData:singleDayTrip,revision:5}),env)).status,200);
assert.deepEqual((await (await api(req('GET'),env)).json()).tripData,singleDayTrip);
assert.equal((await api(req('PUT','user-a',{tripData:{...extendedTrip,dateRange:{...dateRange,returnDate:'2026-12-28'}},revision:6}),env)).status,400);
console.log('Passed: flexible date ranges and retained schedules after shortening.');

const listUrl = 'https://test.example/api/trips';
const ownerHeaders = {'oai-authenticated-user-email':'codexllllllll@gmail.com', Origin:'https://test.example'};
assert.equal((await api(new Request(listUrl,{method:'POST'}),env)).status,403);
const created = await api(new Request(listUrl,{method:'POST',headers:ownerHeaders}),env);
assert.equal(created.status,201);
const {id} = await created.json();
const tripUrl = 'https://test.example/api/itinerary?trip=' + id;
const newTrip = await (await api(new Request(tripUrl),env)).json();
assert.deepEqual(newTrip.tripData.day1,{ids:[],notes:{}});
assert.equal(newTrip.tripData.dateRange.departureDate,newTrip.tripData.dateRange.returnDate);
const renamed = {...newTrip.tripData,title:'下一趟旅行'};
assert.equal((await api(new Request(tripUrl,{method:'PUT',headers:ownerHeaders,body:JSON.stringify({tripData:renamed,revision:1})}),env)).status,200);
const originalTrip = {id:null,title:'宜蘭旅行',...singleDayTrip.dateRange};
assert.deepEqual((await (await api(new Request(listUrl),env)).json()).trips,[{id,title:renamed.title,...renamed.dateRange},originalTrip]);
assert.deepEqual((await (await api(req('GET'),env)).json()).tripData,singleDayTrip);
console.log('Passed: empty trip creation, listing, permission checks and isolated editing.');

assert.equal((await api(new Request(tripUrl,{method:'DELETE'}),env)).status,403);
assert.equal((await api(new Request(tripUrl,{method:'DELETE',headers:ownerHeaders}),env)).status,204);
assert.equal((await api(new Request(tripUrl),env)).status,410);
assert.equal((await api(new Request(tripUrl,{method:'PUT',headers:ownerHeaders,body:JSON.stringify({tripData:renamed,revision:2})}),env)).status,409);
assert.deepEqual((await (await api(new Request(listUrl),env)).json()).trips,[originalTrip]);
records.delete('owner-itinerary');
assert.equal((await api(req('DELETE'),env)).status,204);
assert.deepEqual((await (await api(new Request(listUrl),env)).json()).trips,[]);
assert.equal((await api(req('GET'),env)).status,410);
console.log('Passed: owner-only removal, stale saves and original trip removal.');

const githubOrigin = 'https://fish550212.github.io';
const keyUrl = 'https://test.example/api/github-editor';
assert.equal((await api(new Request(keyUrl,{method:'POST',headers:{Origin:githubOrigin}}),env)).status,403);
const preflight = await api(new Request(listUrl,{method:'OPTIONS',headers:{Origin:githubOrigin}}),env);
assert.equal(preflight.status,204);
assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),githubOrigin);
const issueKey = async () => (await (await api(new Request(keyUrl,{method:'POST',headers:ownerHeaders}),env)).json()).key;
const key = await issueKey();
assert.equal(key.length,72);
assert.ok(!records.get('github-editor-key').payload.includes(key));
const github = (url, method, body, token=key, origin=githubOrigin) => new Request(url,{
  method,headers:{Origin:origin, Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
  ...(body ? {body:JSON.stringify(body)} : {})
});
assert.equal((await api(github(listUrl,'POST',null,key,'https://other.example'),env)).status,403);
assert.equal((await (await api(github(listUrl,'GET'),env)).json()).canEdit,true);
const githubCreated = await api(github(listUrl,'POST'),env);
assert.equal(githubCreated.status,201);
const githubTripUrl = 'https://test.example/api/itinerary?trip=' + (await githubCreated.json()).id;
const githubTrip = await (await api(github(githubTripUrl,'GET'),env)).json();
assert.equal(githubTrip.canEdit,true);
assert.equal((await api(github(githubTripUrl,'PUT',{...githubTrip,tripData:{...githubTrip.tripData,title:'GitHub 旅程'}}),env)).status,200);
const nextKey = await issueKey();
assert.equal((await api(github(githubTripUrl,'DELETE'),env)).status,403);
const githubRemoved = await api(github(githubTripUrl,'DELETE',null,nextKey),env);
assert.equal(githubRemoved.status,204);
assert.equal(githubRemoved.headers.get('Access-Control-Allow-Origin'),githubOrigin);
console.log('Passed: GitHub authorization, key rotation and cross-origin edits.');

const lockTrip = await api(new Request(listUrl,{method:'POST',headers:ownerHeaders}),env);
const lockUrl = 'https://test.example/api/itinerary?trip=' + (await lockTrip.json()).id;
const password = '012345';
const other = await (await api(new Request(lockUrl),env)).json();
const send = (method, body) => api(new Request(lockUrl,{method,headers:ownerHeaders,
  ...(body ? {body:JSON.stringify(body)} : {})}),env);
assert.equal((await send('PUT',{...other, passwordChange:'abc123'})).status,400);
assert.equal((await send('PUT',{...other, passwordChange:password})).status,200);
const locked = await (await send('GET')).json();
assert.equal(locked.canEdit,false);
assert.equal(locked.locked,true);
assert.equal(locked.canUnlock,true);
assert.equal(locked.tripData.editLock,undefined);
assert.equal((await send('PUT',locked)).status,423);
assert.equal((await (await send('POST',{password:'incorrect'})).json()).canEdit,false);
assert.equal((await (await send('POST',{password})).json()).canEdit,true);
assert.equal((await send('PUT',{...locked,password,passwordChange:null})).status,200);
assert.equal((await (await send('GET')).json()).canEdit,true);
console.log('Passed: per-trip password setup, locked writes, unlock and removal.');
