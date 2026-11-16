import assert from 'node:assert/strict';
import {api} from '../worker/api.mjs';
const records = new Map();
const env = {DB:{prepare(sql){return {bind(...args){return {
  async first(){return records.get(args[0]) || null;},
  async run(){
    if (sql.startsWith('INSERT')) {
      if (records.has(args[0])) return {meta:{changes:0}};
      records.set(args[0],{payload:args[1],revision:1});
    } else {
      const row=records.get(args[1]);
      if (!row || row.revision !== args[2]) return {meta:{changes:0}};
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
