const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const STORAGE = 'your-name.notebook.v1', DRAFT = 'your-name.draft.v1';
const stamp = '2026-10-12T00:00:00.000Z';
const record = (change = {}) => ({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name:'테스트', body:'본문', date:'2026-10-12', createdAt:stamp, updatedAt:stamp, curse:null, ...change});
const copy = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(id = '') { this.id=id; this.value=''; this.textContent=''; this.hidden=false; this.disabled=false; this.open=false; this.type=''; this.dataset={}; this.children=[]; this.listeners=new Map(); this.nodes=new Map(); this.classList={add(){},remove(){}}; }
  addEventListener(name, fn) { const list=this.listeners.get(name)||[]; list.push(fn); this.listeners.set(name,list); }
  async fire(name, fields={}) { for (const fn of this.listeners.get(name)||[]) await fn({target:this,preventDefault(){},...fields}); }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector,new Element(selector)); return this.nodes.get(selector); }
  setAttribute() {}
  replaceChildren(...children) { this.children=[...children]; }
  append(...children) { this.children.push(...children); }
  click() { return this.fire('click'); }
  remove() {}
  focus() {}
  select() {}
  scrollIntoView() {}
  showModal() { this.open=true; }
  close() { this.open=false; }
  setCustomValidity(value) { this.validationMessage=value; }
  reportValidity() { return !this.validationMessage; }
}

function app({entries=[],draft=null,restoreResult=true,code=null}={}) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id,new Element(id)); return elements.get(id); };
  const values = new Map([[STORAGE,JSON.stringify(entries)]]);
  if(code)values.set('curse-note.cloud.active.v1',JSON.stringify({code}));
  if (draft) values.set(DRAFT,JSON.stringify(draft));
  const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  const windowEvents = new Map(), documentEvents = new Map();
  const document = {hidden:false,body:new Element('body'),getElementById:$,createElement:tag=>new Element(tag),
    addEventListener:(name,fn)=>{const list=documentEvents.get(name)||[];list.push(fn);documentEvents.set(name,list);},
    querySelector:selector=>selector==='dialog[open]'?[...elements.values()].find(el=>el.open)||null:$(selector)};
  const downloads=[];
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL=blob=>{downloads.push(blob);return 'blob:test';}; BrowserURL.revokeObjectURL=()=>{};
  let hooks;
  const notices=[];
  const cloud={start:async options=>{hooks=options;return false;},notify:entries=>{notices.push(copy(entries));return true;},getRecoveryCode:()=>code,restore:async()=>restoreResult,syncNow:async()=>false};
  const window={CurseCloud:cloud,scrollTo(){},addEventListener:(name,fn)=>{const list=windowEvents.get(name)||[];list.push(fn);windowEvents.set(name,list);}};
  let timerId=0; const timers=new Map();
  const context=vm.createContext({window,document,localStorage:storage,navigator:{},crypto:webcrypto,Blob,URL:BrowserURL,TextEncoder,Date,console,
    innerWidth:1000,matchMedia:()=>({matches:true}),setInterval:()=>1,
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  return {$,storage,cloud,notices,downloads,timers,
    get entries(){return copy(hooks.getEntries());},
    remote:records=>hooks.onRemote(copy(records)),
    storageEvent:async(key)=>{for(const fn of windowEvents.get('storage')||[])await fn({key,newValue:storage.getItem(key)});},
    import:async(text)=>{$('importFile').files=[{size:Buffer.byteLength(text),text:async()=>text}];await $('importFile').fire('change');},
    backup:async()=>{await $('backupBtn').click();return downloads.at(-1)?.text();},
  };
}
const backup = entries => JSON.stringify({format:'curse-note-backup',version:1,entries});

test('app imports an ordinary JSON backup, exposes it to cloud, and does not discard existing entries',async()=>{
  const old=record(), incoming=record({id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',body:'가져온 기록'});
  const ui=app({entries:[old]}); await ui.import(backup([incoming]));
  assert.equal(ui.entries.length,2); assert.equal(ui.entries[0].body,old.body); assert.equal(ui.entries[1].body,incoming.body);
  assert.equal(ui.notices.at(-1).length,2); assert.match(ui.$('vaultMessage').textContent,/1개의 기록/);
});

test('app rejects impossible calendar dates and malformed ritual times before changing storage',async()=>{
  for(const invalid of [record({date:'2026-02-30'}),record({date:'2026-13-01'}),record({createdAt:'2026-02-30T00:00:00.000Z'}),
    record({curse:{status:'pending',startedAt:1.5,deadline:10}}),record({curse:{status:'pending',startedAt:0,deadline:253402300800000}})]) {
    const ui=app(); await ui.import(backup([invalid]));
    assert.equal(ui.entries.length,0,JSON.stringify(invalid)); assert.equal(ui.notices.length,0); assert.doesNotMatch(ui.$('vaultMessage').textContent,/가져왔습니다/);
  }
});

test('app canonicalizes imported UUID case and ISO timestamps for the SQL contract',async()=>{
  const ui=app(); await ui.import(backup([record({id:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',createdAt:'2026-10-12T09:00:00+09:00'})]));
  assert.equal(ui.entries.length,1); assert.equal(ui.entries[0].id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); assert.equal(ui.entries[0].createdAt,stamp);
});

test('legacy text import preserves empty bodies and separator text inside a body',async()=>{
  const separator='─'.repeat(28), ui=app();
  const text=`\uFEFFCURSE NOTE — 저주의 서\n${separator}\n\n001. 첫 번째\n2026-10-12 · 미발동\n\n\n\n${separator}\n\n002. 두 번째\n2026-10-12 · 발동 완료\n\n본문\n${separator}\n계속\n\n${separator}`;
  await ui.import(text);
  assert.equal(ui.entries.length,2); assert.equal(ui.entries[0].body,''); assert.equal(ui.entries[1].body,`본문\n${separator}\n계속`); assert.ok(ui.entries.every(entry=>entry.curse===null));
});

test('backup download can be imported at the supported payload boundary',async()=>{
  const entries=Array.from({length:500},(_,i)=>record({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,body:'x'.repeat(1860)}));
  const before=app({entries}), text=await before.backup();
  assert.ok(Buffer.byteLength(text)>1048576,'fixture must exercise pretty-print overhead');
  const after=app(); await after.import(text);
  assert.equal(after.entries.length,500); assert.match(after.$('vaultMessage').textContent,/500개의 기록/);
});

test('import limit rejects the combined vault without changing saved records',async()=>{
  const entries=Array.from({length:500},(_,i)=>record({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}));
  const ui=app({entries}); await ui.import(backup([record()]));
  assert.equal(ui.entries.length,500); assert.equal(ui.notices.length,0); assert.match(ui.$('vaultMessage').textContent,/한도/);
});

test('import uses the PostgreSQL JSON size including formatting overhead',async()=>{
  const entries=Array.from({length:500},(_,i)=>record({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,body:'x'.repeat(1900)}));
  assert.ok(Buffer.byteLength(JSON.stringify(entries))<1048576,'compact JSON must fit to distinguish server size');
  const ui=app(); await ui.import(backup(entries)); assert.equal(ui.entries.length,0); assert.match(ui.$('vaultMessage').textContent,/한도/);
});

test('reimporting the same backup does not duplicate unchanged content',async()=>{
  const ui=app(), text=backup([record()]); await ui.import(text); await ui.import(text);
  assert.equal(ui.entries.length,1); assert.match(ui.$('vaultMessage').textContent,/0개의 기록/);
});

test('remote changes preserve an in-progress draft separately from the changed record',async()=>{
  const ui=app({entries:[record()]}); await ui.$('entryList').children[0].click();
  ui.$('entryBody').value='작성 중인 초안'; await ui.$('entryBody').fire('input');
  ui.remote([record({body:'다른 기기의 기록',updatedAt:'2026-10-12T01:00:00.000Z'})]);
  assert.equal(ui.entries[0].body,'다른 기기의 기록'); assert.equal(ui.$('entryBody').value,'작성 중인 초안');
  await ui.$('newEntryBtn').click();
  assert.equal(ui.entries.length,2); assert.ok(ui.entries.some(entry=>entry.body==='작성 중인 초안'));
});

test('getEntries and onRemote round trip identical valid application records',async()=>{
  const ui=app({entries:[record()]}); const next=[record({body:'서버에서 복구한 기록'})];
  assert.equal(ui.remote(next),true); assert.deepEqual(ui.entries,next); assert.deepEqual(JSON.parse(ui.storage.getItem(STORAGE)),next);
});

test('restore resolving false never displays a successful restore',async()=>{
  const ui=app({restoreResult:false}); ui.$('restoreCode').value='cn1_'+'a'.repeat(43);
  await ui.$('restoreForm').fire('submit'); assert.notEqual(ui.$('vaultMessage').textContent,'노트를 불러왔습니다.');
});

test('another tab changing recovery vault cannot mix records or overwrite its storage',async()=>{
  const codeA='cn1_'+'a'.repeat(43),codeB='cn1_'+'b'.repeat(43),ui=app({entries:[record()],code:codeA});
  await ui.$('entryList').children[0].click(); ui.$('entryBody').value='A 보관함 작성 중'; await ui.$('entryBody').fire('input');
  const other=[record({body:'B 보관함 기록'})]; ui.storage.setItem('curse-note.cloud.active.v1',JSON.stringify({code:codeB})); ui.storage.setItem(STORAGE,JSON.stringify(other));
  await ui.storageEvent(STORAGE); await ui.$('newEntryBtn').click();
  assert.equal(ui.entries[0].body,'본문'); assert.equal(ui.$('entryBody').value,'A 보관함 작성 중'); assert.deepEqual(JSON.parse(ui.storage.getItem(STORAGE)),other);
  assert.equal(ui.notices.length,0); assert.equal(JSON.parse(ui.storage.getItem(DRAFT+':'+codeA)).body,'A 보관함 작성 중'); assert.equal(ui.storage.getItem(DRAFT+':'+codeB),null);
});

test('a failed remote local-storage write keeps the displayed notebook and reports failure',async()=>{
  const ui=app({entries:[record()]}); ui.storage.setItem=()=>{throw new Error('quota');};
  assert.equal(ui.remote([record({body:'uncommitted remote'})]),false); assert.equal(ui.entries[0].body,'본문');
});
