import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

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
const context = vm.createContext({document,window:{addEventListener(){}},crypto:{randomUUID},confirm:()=>true,setInterval(){},
  localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k) || null},
  FormData:class {constructor(form){return Object.entries(form.values);}},
  fetch:async (url,options={}) => {
    if (options.method === 'PUT') {const body=JSON.parse(options.body); assert.equal(body.revision,revision); cloud=body.tripData; revision++; return {ok:true,status:200,json:async()=>({revision})};}
    return {ok:true,json:async()=>({tripData:structuredClone(cloud),revision,canEdit:true})};
  }});
const script = fs.readFileSync('code_artifact.html','utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
vm.runInContext(script,context);
const run = code => vm.runInContext(code,context);
await run('initFirebase()');
run('openPlaceForm()');
assert.equal(document.getElementById('place-dialog').open,true);
const form = document.getElementById('place-form');
form.values={type:'restaurant',name:'測試 <img src=x onerror=alert(1)>',tag:'羅東鎮',location:'測試地址',desc:'第一行\n第二行',highlight:'"提醒"',mapUrl:''};
form.listeners.submit({preventDefault(){},target:form});
await new Promise(setImmediate);
assert.equal(cloud.customItems.length,1);
const id = cloud.customItems[0].id;
assert.ok(cloud.customItems[0].mapUrl.startsWith('https://www.google.com/maps/search/'));
assert.ok(run('displayItem(items[items.length-1]).name').includes('&lt;img'));
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
run('tripData={day1:{ids:[],notes:{}},day2:{ids:[],notes:{}},day3:{ids:[],notes:{}}}');
await run('initFirebase()');
assert.ok(run('items.some(item=>item.id===' + JSON.stringify(id) + ')'));
assert.equal(run('items.find(item=>item.id===' + JSON.stringify(id) + ').name'),'Updated place');
run(`deletePlace('${id}')`);
await new Promise(setImmediate);
assert.equal(cloud.customItems.length,0);
for (const day of ['day1','day2','day3']) {assert.ok(!cloud[day].ids.includes(id)); assert.equal(cloud[day].notes[id],undefined);}
run("deletePlace('spot-1')");
await new Promise(setImmediate);
await run('initFirebase()');
assert.ok(!run("items.some(item=>item.id==='spot-1')"));
const before=JSON.stringify(cloud);
run("canEdit=false; deletePlace('spot-2')");
assert.equal(JSON.stringify(cloud),before);
console.log('Passed: create, edit, prefill, cancel, stable ID and notes, cloud reload, escaping, removal and read-only guard.');
