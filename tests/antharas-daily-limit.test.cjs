const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('js/05-kill-progression.js', 'utf8');
const start = source.indexOf('const ANTHARAS_AREAS =');
const end = source.indexOf('// ---------- 🐉 助戰者系統', start);
assert.ok(start >= 0 && end > start, 'Antharas module exists');
const moduleCode = source.slice(start, end);

function fixture() {
  const store = new Map();
  let day = 25000;
  let failsFor = '';
  const knight = { cls: 'knight', name: 'Knight', enSeed: 'knight-seed', allies: [] };
  const mage = { cls: 'mage', name: 'Mage', enSeed: 'mage-seed', _slot: 2 };
  const context = {
    player: knight, currentSlot: 1,
    Date: class extends Date { static now() { return day * 86400000 - 8 * 3600000 + 3600000; } },
    _lsGet: k => store.has(k) ? store.get(k) : null,
    _lsSet: (k, v) => { if (k.includes(failsFor) && failsFor) return false; store.set(k,v); return true; },
    _lsRemove: k => { store.delete(k); return true; },
    state: {}, logSys() {}, updateUI() {}, saveGame() {}, enterOblivionMap() {},
    document: {getElementById() {return {classList:{contains(){return true;}}};}}
  };
  vm.createContext(context);
  vm.runInContext(moduleCode, context);
  return {ctx:context, store, knight, mage, setDay:n=>{day=n;}, failKey:s=>{failsFor=s;}};
}

{
  const f = fixture();
  assert.equal(vm.runInContext('ANTHARAS_DAILY_LIMIT', f.ctx), 10);
  assert.equal(f.ctx.antharasClearedToday(), false);
  for(let i=1;i<=10;i++){
    assert.equal(f.ctx.antharasClaimDailyClear().ok,true,'success '+i);
    assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.knight,1)),i);
  }
  assert.equal(f.ctx.antharasClearedToday(),true);
  assert.deepEqual(Array.from(f.ctx.antharasPartyUsedToday(),r=>r.name),['Knight']);
  assert.equal(f.ctx.antharasClaimDailyClear().ok,false,'11th attempt blocked');
  f.setDay(25001);
  assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.knight,1)),0,'reset at next Taiwan midnight');
  assert.equal(f.ctx.antharasClaimDailyClear().ok,true);
}
{
  const f = fixture();
  f.knight.allies=[f.mage];
  assert.equal(f.ctx.antharasClaimDailyClear().ok,true);
  assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.knight,1)),1);
  assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.mage,2)),1,'mercenary charged');
  f.knight.allies=[];
  for(let i=0;i<9;i++) assert.equal(f.ctx.antharasClaimDailyClear().ok,true);
  f.knight.allies=[f.mage];
  assert.equal(f.ctx.antharasClaimDailyClear().ok,false,'exhausted leader blocks party');
  assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.mage,2)),1,'no partial charge');
}
{
  const f = fixture();
  const ref=f.ctx.antharasRoleRef(f.knight,1);
  f.store.set(f.ctx.antharasRoleClearKey(ref),String(25000));
  assert.equal(f.ctx.antharasRoleClearCount(ref),1,'legacy successful clear migrated');
  assert.equal(f.ctx.antharasClaimDailyClear().ok,true);
  assert.equal(f.ctx.antharasRoleClearCount(ref),2);
}
{
  const f = fixture();
  const ref=f.ctx.antharasRoleRef(f.knight,1);
  f.knight.allies=[f.mage];
  f.failKey('mage-seed');
  assert.equal(f.ctx.antharasClaimDailyClear().storageError,true);
  assert.equal(f.ctx.antharasRoleClearCount(ref),0,'rollback on failed mercenary write');
  f.failKey('');
  assert.equal(f.ctx.antharasClaimDailyClear().ok,true);
}
{
  const f=fixture();
  f.ctx.antharasEnter();
  assert.equal(f.ctx.state.antharas,1);
  f.ctx.state.antharas=0; // failed/abandoned attempt: no claim
  assert.equal(f.ctx.antharasRoleClearCount(f.ctx.antharasRoleRef(f.knight,1)),0);
}
console.log('Antharas daily 10-clear tests passed');
