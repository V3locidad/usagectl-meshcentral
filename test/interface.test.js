const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../views/usagectl.handlebars'), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function ui() {
  const elements = {}, timers = new Map(), requests = []; let serial=0;
  function el(id) {
    if (elements[id]) return elements[id];
    const classes = new Set();
    return elements[id] = {
      id, value: '', checked: false, disabled: false, style: {}, textContent: '', scrollTop: 0, scrollLeft: 0, writes: 0, boxes: [],
      get innerHTML() { return this.html || ''; },
      set innerHTML(value) { this.html=value; this.writes++; this.scrollTop=this.scrollLeft=0; this.boxes.forEach(b=>{b.scrollTop=b.scrollLeft=0;}); },
      classList: { add: x=>classes.add(x), remove: x=>classes.delete(x), contains: x=>classes.has(x), toggle: (x,on)=>on?classes.add(x):classes.delete(x) },
      setAttribute(name,value) { this[name]=value; }, getAttribute(name) { return this[name]; },
      querySelectorAll(q) { return q==='[data-scroll-key]'?this.boxes:[]; }, querySelector(){return null;},
      focus(){document.activeElement=this;}, click(){if(!this.disabled && this.onclick)return this.onclick();}
    };
  }
  const tabs=['salles','heatmap','horsHeures','topPostes','loginTimes'].map(name=>{const e=el('tab-'+name);e['data-tab']=name;return e;});
  const document={getElementById:el, querySelectorAll:q=>q==='.tab'?tabs:[],querySelector:()=>null,activeElement:null};
  el('modeSel').value='week';el('weekSel').value='2026-10-05';el('daysSel').value='7';el('schoolHours').checked=true;
  function timer(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;}
  const sandbox={document,window:{scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y;}},console,Date,Promise,Set,
    confirm:()=>true,alert:msg=>assert.fail(msg),setTimeout:timer,setInterval:timer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),
    fetch:()=>new Promise(()=>{})};
  vm.createContext(sandbox);vm.runInContext(script,sandbox);
  sandbox.loading=null;sandbox.wingetLoading=null;
  sandbox.api=(action,params,body)=>{const d=deferred();requests.push({action,params,body,...d});return d.promise;};
  return {s:sandbox,el,timers,requests};
}

function salles(name='Salle A'){return {weekMode:true,weekLabel:'05/10 au 09/10',salles:[{meshid:'a',name,nodes:12,nodesWithData:10,avgOnPct:42,avgOnMinutes:1260,avgObservedMinutes:3000,avgPowerMinutes:1800,avgPowerPct:60}]};}
function login(){return {weekMode:true,rows:[{id:'pc-a',name:'PC-A',mesh:'Salle A',count:1,incomplete:0,lastMs:12000,avgMs:12000,maxMs:12000,historyCount:1,history:[{startAt:123000,endAt:135000,durationMs:12000,startReliable:true,status:'ready',username:'demo'}]}],globalStats:{avgMs:12000,count:1}};}

test('late room response cannot replace a newer tab or start its timer',async()=>{
  const h=ui(),old=h.s.loadSalles(false),fresh=h.s.loadLoginTimes(false);h.requests[1].resolve(login());await fresh;const before=h.el('content').innerHTML;
  h.requests[0].resolve(salles('Obsolete'));await old;assert.equal(h.el('content').innerHTML,before);assert.equal(h.s.currentTab,'loginTimes');assert.equal(h.el('content')['aria-labelledby'],'tab-loginTimes');
});
test('changing weeks rejects an old response and filtering cannot restore stale data mid-load',async()=>{
  const h=ui();let p=h.s.loadSalles(false);h.requests[0].resolve(salles());await p;
  h.el('weekSel').value='2026-10-12';p=h.s.loadSalles(false);h.el('filterInput').value='A';h.el('filterInput').oninput();assert.doesNotMatch(h.el('content').innerHTML,/Salle A/);
  const stale=h.requests[1];h.el('weekSel').value='2026-10-19';const fresh=h.s.loadSalles(false);h.requests[2].resolve(salles('Salle Actuelle'));await fresh;stale.resolve(salles('Ancienne'));await p;
  assert.match(h.el('content').innerHTML,/Actuelle/);assert.doesNotMatch(h.el('content').innerHTML,/Ancienne/);
});
test('same-view polling coalesces, preserves unchanged DOM and leaves history expanded',async()=>{
  const h=ui();h.s.expandedLoginHistory['pc-a']=true;let p=h.s.loadLoginTimes();assert.equal(h.s.loadLoginTimes(),p);h.requests[0].resolve(login());await p;
  const box=h.el('content'),writes=box.writes;box.scrollTop=220;
  p=h.s.loadLoginTimes(true);h.requests[1].resolve(login());await p;
  assert.equal(box.writes,writes);assert.equal(box.scrollTop,220);assert.match(box.innerHTML,/aria-expanded="true"/);assert.match(box.innerHTML,/display:table-row/);
});
test('changed results preserve keyed horizontal table and nested-history scroll',async()=>{
  const h=ui();let p=h.s.loadLoginTimes();h.requests[0].resolve(login());await p;
  const box=h.el('nested');box['data-scroll-key']='history-pc-a';box.scrollLeft=380;box.scrollTop=45;h.el('content').boxes=[box];
  const changed=login();changed.rows[0].avgMs=14000;p=h.s.loadLoginTimes(true);h.requests[1].resolve(changed);await p;
  assert.equal(box.scrollLeft,380);assert.equal(box.scrollTop,45);assert.match(h.el('content').innerHTML,/14s/);
});
test('failed login refresh keeps data and schedules another read',async()=>{
  const h=ui();let p=h.s.loadLoginTimes();h.requests[0].resolve(login());await p;const before=h.el('content').innerHTML;
  p=h.s.loadLoginTimes(true);h.requests[1].reject(new Error('réseau'));await p;
  assert.equal(h.el('content').innerHTML,before);assert.match(h.el('viewStatus').textContent,/conservées/);assert.ok([...h.timers.values()].some(t=>t.ms===15000));assert.equal(h.el('content')['aria-busy'],'false');
});
test('invalid custom dates issue no query and invalidate an outstanding response',async()=>{
  const h=ui(),old=h.s.loadSalles(false);h.el('modeSel').value='custom';h.el('customFrom').value='2026-10-13';h.el('customTo').value='2026-10-01';
  await h.s.loadSalles(false);assert.equal(h.requests.length,1);h.requests[0].resolve(salles());await old;
  assert.match(h.el('viewStatus').textContent,/date de début/);assert.doesNotMatch(h.el('content').innerHTML,/Salle A/);
});
test('room detail survives refresh and restoring room list restores its search',async()=>{
  const h=ui();h.el('filterInput').value='Salle A';let p=h.s.loadSalleDetail('a');assert.equal(h.el('filterInput').value,'');h.requests[0].resolve({nodes:[],weekMode:true});await p;
  p=h.s.loadCurrentTab(true);assert.equal(h.requests[1].action,'salleDetail');assert.equal(h.requests[1].params.meshid,'a');assert.equal(h.requests[1].params.force,'1');
  h.requests[1].resolve({nodes:[],weekMode:true});await p;h.el('backBtn').click();assert.equal(h.el('filterInput').value,'Salle A');assert.equal(h.requests.at(-1).action,'salles');
});
test('out-of-hours and ranking searches filter locally without additional API calls',async()=>{
  const h=ui();let p=h.s.loadHorsHeures(true);assert.equal(h.requests[0].params.force,'1');h.requests[0].resolve({meshid:'all',nodes:[{name:'PC-A',mesh:'Salle A',offPct:20,offMinutes:60},{name:'PC-B',mesh:'Salle B',offPct:30,offMinutes:90}]});await p;
  h.el('filterInput').value='Salle B';h.el('filterInput').oninput();assert.equal(h.requests.length,1);assert.match(h.el('content').innerHTML,/PC-B/);assert.doesNotMatch(h.el('content').innerHTML,/PC-A/);
  p=h.s.loadTopPostes(true);assert.equal(h.requests[1].params.force,'1');h.requests[1].resolve({top:[{name:'PC-A',mesh:'Salle A'}],bottom:[{name:'PC-B',mesh:'Salle B'}]});await p;
  h.el('filterInput').oninput();assert.equal(h.requests.length,2);assert.doesNotMatch(h.el('content').innerHTML,/PC-A/);
});
test('weekly tabs are disabled outside weekly mode and keyboard skips them',()=>{
  const h=ui();h.el('modeSel').value='rolling';h.s.updateModeUi();assert.equal(h.el('tab-heatmap').disabled,true);assert.equal(h.el('forceBtn').disabled,true);
  h.el('tab-salles').onkeydown({key:'ArrowRight',preventDefault(){}});assert.equal(h.s.currentTab,'loginTimes');assert.equal(h.el('tab-loginTimes')['aria-selected'],'true');
});
test('recalculate is disabled during a request and enabled after it finishes',async()=>{
  const h=ui(),p=h.s.loadHeatmap(true);assert.equal(h.requests[0].params.force,'1');assert.equal(h.el('forceBtn').disabled,true);
  h.requests[0].resolve({grid:Array(50).fill(20),nodesCount:1,meshid:'all'});await p;assert.equal(h.el('forceBtn').disabled,false);
});
