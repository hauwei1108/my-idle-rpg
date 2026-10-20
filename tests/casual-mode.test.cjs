const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/casual-mode.js', 'utf8');
function fresh(initial) {
  const store = new Map();
  if (initial) store.set('my_idle_rpg_casual_mode_v1', initial);
  const listeners = {};
  const btn = { style: { cssText: '' }, textContent: '', setAttribute(k,v) { this[k]=v; }, addEventListener(k,fn){this[k]=fn;} };
  const document = {
    readyState: 'complete',
    getElementById(){ return this.created ? btn : null; },
    createElement(){return btn;},
    body:{ appendChild(){document.created=true;} }
  };
  const storage={getItem(k){return store.get(k)||null;},setItem(k,v){store.set(k,v);}};
  const ctx={window:{},document,localStorage:storage};
  vm.runInNewContext(source,ctx,{filename:'js/casual-mode.js'});
  return {window:ctx.window,btn,store};
}
let a=fresh();
assert.equal(a.window.casualHitBonus(),0);
assert.equal(a.window.casualKariSpawnChance(),0.01);
assert.equal(a.window.casualMultiplier('exp'),1);
assert.equal(a.window.casualMultiplier('drop'),1);
assert.equal(a.window.casualMultiplier('damage'),1);
assert.equal(a.window.casualMultiplier('taken'),1);
assert.equal(a.window.casualMultiplier('speed'),1);
assert.equal(a.window.casualMultiplier('enhance'),1);
a.window.setCasualMode(true);
assert.equal(a.window.casualHitBonus(),30);
assert.equal(a.window.casualKariSpawnChance(),1);
for(const [key,val] of Object.entries({exp:50,drop:500,damage:5,taken:0.2,gold:50,speed:3,enhance:1}))
  assert.equal(a.window.casualMultiplier(key),val,key);
assert.equal(a.store.get('my_idle_rpg_casual_mode_v1'),'on');
assert.equal(fresh('on').window.casualMultiplier('exp'),50);
assert.equal(fresh('on').window.casualMultiplier('drop'),500);
assert.match(a.btn.title, /掉寶×500/);
assert.equal(fresh('on').window.casualHitBonus(),30);
assert.equal(fresh('on').window.casualKariSpawnChance(),1);
a.window.setCasualMode(false);
assert.equal(a.window.casualMultiplier('exp'),1);
assert.equal(a.window.casualMultiplier('drop'),1);
assert.equal(a.window.casualHitBonus(),0);
assert.equal(a.window.casualKariSpawnChance(),0.01);
assert.equal(a.store.get('my_idle_rpg_casual_mode_v1'),'off');
assert.equal(a.window.casualMultiplier('unexpected'),1);
// Validate enhancement override against the actual implementation.
const enhanceFile=fs.readFileSync('js/01-drops-config.js','utf8');
assert.match(enhanceFile,/function enhanceRollOutcome\(d, en\) \{\s*if \(typeof casualMultiplier/);
assert.match(enhanceFile,/return 'ok'/);
// Integration markers ensure important sites remain connected.
for(const [path, markers] of Object.entries({
 'index.html':['js/casual-mode.js'],
 'js/03-combat-core.js':["casualHitBonus()","casualMultiplier('speed')","casualMultiplier('damage')","casualMultiplier('taken')"],
 'js/04-combat-attack.js':["casualMultiplier('taken')"],
 'js/05-kill-progression.js':["casualMultiplier('exp')","casualMultiplier('drop')","casualMultiplier('gold')"],
 'js/07-skills-cast.js':["casualMultiplier('damage')"]
})) {
 const body=fs.readFileSync(path,'utf8');
 for(const m of markers)assert.ok(body.includes(m),path+': '+m);
}

// Execute the real shared drop-rate formula to cover rare drops and the 100% cap.
const killSource = fs.readFileSync('js/05-kill-progression.js', 'utf8');
const partyRateDefinition = killSource.match(/^function partyDropRate\(rate\) \{[^\n]+\}/m);
assert.ok(partyRateDefinition, 'missing shared drop-rate calculation');
function dropRate(casual, partySize) {
  return vm.runInNewContext(partyRateDefinition[0] + '\npartyDropRate', {
    partyRewardMult: () => partySize,
    casualMultiplier: fresh(casual ? 'on' : 'off').window.casualMultiplier
  });
}
const normalDrop = dropRate(false, 1);
const casualDrop = dropRate(true, 1);
assert.equal(normalDrop(0.001), 0.001, 'normal mode preserves original 0.1% drop');
assert.equal(casualDrop(0.001), 0.5, '0.1% rare drop becomes 50%');
assert.equal(casualDrop(0.000001), 0.0005, '0.0001% relic drop becomes 0.05%');
\n// Black Elder's obsidian orb is an intentional exception to the ultra-rare relic table.
const orbDropEntries = [...enhanceFile.matchAll(/\['黑長者','relic_elder_obsidian_orb',\s*([0-9.]+)\]/g)];
assert.equal(orbDropEntries.length, 1, 'Black Elder orb has exactly one configured source');
assert.match(enhanceFile, /\.push\(\[r\[1\], r\[2\] \?\? 0\.0001\]\)/, 'per-item rate overrides must reach MOB_DROPS');
const orbDropProbability = Number(orbDropEntries[0][1]) / 100;
assert.equal(normalDrop(orbDropProbability), 0.0002, 'normal mode: 0.02% per kill');
assert.equal(casualDrop(orbDropProbability), 0.1, 'casual solo: 10% per kill with x500');
assert.equal(dropRate(true, 8)(orbDropProbability), 0.8, 'casual 8-member party: 80% per kill');

assert.equal(casualDrop(0.01), 1, '1% drop caps at 100%');
assert.equal(dropRate(true, 2)(0.001), 1, 'party size composes with bonus and caps at 100%');

console.log('Casual mode tests passed');

// Both attack types share getPhysicalDmg; the additive hit bonus must be applied after selecting meleeHit/rangedHit.
const physicalCore=fs.readFileSync('js/03-combat-core.js','utf8');
assert.match(physicalCore,/let hitBonus = \(isRanged \? player\.d\.rangedHit : player\.d\.meleeHit\)[^\n]*casualHitBonus\(\)/);


// Execute the real Kari spawn condition, not a duplicate reimplementation.
const coreSource=fs.readFileSync('js/03-combat-core.js','utf8');
const kariStart=coreSource.indexOf("    if (mapState.current === 'zone_31'\n");
assert.ok(kariStart >= 0,'Kari spawn condition not found');
const kariEnd=coreSource.indexOf('    // 🔥 50級試煉',kariStart);
assert.ok(kariEnd > kariStart,'Kari spawn condition end not found');
const kariBlock=coreSource.slice(kariStart,kariEnd);
assert.match(kariBlock,/casualKariSpawnChance\(\)/,'Kari must use casual mode spawn chance');
const kariItems=['item_dragon_claw','item_lizard_horn','item_crystal_ball','item_orc_amulet'];
const allKariItems=()=>kariItems.map(id=>({id,cnt:1}));
function kariRoll({casual=false,map='zone_31',bossInBattle=false,mobs=[],inv=allKariItems(),roll=0.999}={}) {
  const mode=fresh(casual ? 'on' : 'off').window;
  return vm.runInNewContext('(() => { let mobId="other";\n'+kariBlock+'\nreturn mobId; })()', {
    mapState:{current:map,mobs},
    bossInBattle,
    player:{inv},
    Math:{random:()=>roll},
    casualKariSpawnChance:mode.casualKariSpawnChance
  });
}
assert.equal(kariRoll({casual:true,roll:0.999999}),'kari','casual mode: 100% if eligible');
assert.equal(kariRoll({casual:false,roll:0}),'kari','normal mode: still has 1% chance');
assert.equal(kariRoll({casual:false,roll:0.00999}),'kari','normal mode: rolls below 1%');
assert.equal(kariRoll({casual:false,roll:0.01}),'other','normal mode: rolls at/above 1% fail');
assert.equal(kariRoll({casual:false,roll:0.999}),'other','normal mode: not guaranteed');
assert.equal(kariRoll({casual:true,map:'zone_30'}),'other','wrong floor blocks spawn');
assert.equal(kariRoll({casual:true,bossInBattle:true}),'other','other boss blocks spawn');
assert.equal(kariRoll({casual:true,mobs:[{n:'卡瑞'}]}),'other','cannot spawn second Kari');
for(const id of kariItems) {
  assert.equal(kariRoll({casual:true,inv:allKariItems().filter(i=>i.id!==id)}),'other',id+' required');
  assert.equal(kariRoll({casual:true,inv:allKariItems().map(i=>i.id===id?{...i,cnt:0}:i)}),'other',id+' needs positive count');
}
assert.equal(kariRoll({casual:true,mobs:[{n:'骷髏',boss:false}]}),'kari','regular mobs do not block Kari');
