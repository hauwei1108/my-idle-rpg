const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/casual-mode.js', 'utf8');
function fresh(initial) {
  const store = new Map();
  if (initial) store.set('my_idle_rpg_casual_mode_v1', initial);
  const listeners = {};
  const btn = { textContent: '', setAttribute(k,v) { this[k]=v; }, addEventListener(k,fn){this[k]=fn;} };
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
assert.equal(a.window.casualMultiplier('exp'),1);
assert.equal(a.window.casualMultiplier('drop'),1);
assert.equal(a.window.casualMultiplier('damage'),1);
assert.equal(a.window.casualMultiplier('taken'),1);
assert.equal(a.window.casualMultiplier('speed'),1);
assert.equal(a.window.casualMultiplier('enhance'),1);
a.window.setCasualMode(true);
for(const [key,val] of Object.entries({exp:50,drop:50,damage:5,taken:0.2,gold:50,speed:3,enhance:1}))
  assert.equal(a.window.casualMultiplier(key),val,key);
assert.equal(a.store.get('my_idle_rpg_casual_mode_v1'),'on');
assert.equal(fresh('on').window.casualMultiplier('exp'),50);
a.window.setCasualMode(false);
assert.equal(a.window.casualMultiplier('exp'),1);
assert.equal(a.store.get('my_idle_rpg_casual_mode_v1'),'off');
assert.equal(a.window.casualMultiplier('unexpected'),1);
// Validate enhancement override against the actual implementation.
const enhanceFile=fs.readFileSync('js/01-drops-config.js','utf8');
assert.match(enhanceFile,/function enhanceRollOutcome\(d, en\) \{\s*if \(typeof casualMultiplier/);
assert.match(enhanceFile,/return 'ok'/);
// Integration markers ensure important sites remain connected.
for(const [path, markers] of Object.entries({
 'index.html':['js/casual-mode.js'],
 'js/03-combat-core.js':["casualMultiplier('speed')","casualMultiplier('damage')","casualMultiplier('taken')"],
 'js/04-combat-attack.js':["casualMultiplier('taken')"],
 'js/05-kill-progression.js':["casualMultiplier('exp')","casualMultiplier('drop')","casualMultiplier('gold')"],
 'js/07-skills-cast.js':["casualMultiplier('damage')"]
})) {
 const body=fs.readFileSync(path,'utf8');
 for(const m of markers)assert.ok(body.includes(m),path+': '+m);
}
console.log('Casual mode tests passed');
