'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', '34-cloud-save.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const role = JSON.stringify({v:2, p:{cls:'knight', lv:60}, ms:{current:'town_silver_knight'}});
const save = 'SIG1:test:' + role;
let tokenSeq=0;
function nextToken(){return '00000000-0000-4000-8000-'+String(++tokenSeq).padStart(12,'0');}

function createHarness(opts = {}) {
    const data = new Map(opts.local || []);
    const db = opts.sharedDb || {row:opts.cloud || null,updates:0,inserts:0,sessionId:null,claims:0};
    if(!Object.prototype.hasOwnProperty.call(db,'sessionId'))db.sessionId=null;
    const uid = opts.uid === undefined ? 'user-1' : opts.uid;
    let account = uid ? {id:uid,email:'example@example.test'} : null;
    let shouldConfirm = opts.confirm !== false;
    let backupDownloads = 0, reloads = 0, saveAttempts = 0;
    const timers=[];
    const elems = {};
    for(const id of ['cloud-save-upload','cloud-save-restore','cloud-save-status','game-screen']) {
        elems[id]={hidden:id!=='cloud-save-status',disabled:false,handlers:{},
            classList:{contains(){return !opts.playing;}},textContent:'',style:{},
            addEventListener(n,cb){this.handlers[n]=cb;},
            click(){return this.handlers.click && this.handlers.click();}};
    }
    const localStorage={getItem(k){return data.has(k)?data.get(k):null;},
        setItem(k,v){data.set(k,String(v));},removeItem(k){data.delete(k);}};
    const methods={
        async rpc(name,args) {
            if(name==='claim_game_session'){db.sessionId=args.p_session;db.claims++;return {data:true,error:null};}
            if(name==='game_session_alive')return {data:db.sessionId===args.p_session,error:null};
            if(db.sessionId!==args.p_session)return {data:null,error:{message:'GAME_SESSION_REPLACED'}};
            if(name==='read_game_save')return {data:db.row?{...db.row}:null,error:null};
            if(name==='write_game_save'){
                const old=args.p_expected_revision;
                if((db.row?db.row.revision:0)!==old)return {data:null,error:{message:'SAVE_REVISION_CONFLICT'}};
                const rev=old+1;
                db.row={user_id:'user-1',save_data:args.p_data,revision:rev};
                if(old===0)db.inserts++;else db.updates++;
                return {data:rev,error:null};
            }
            throw Error('Unexpected RPC '+name);
        },
        from(table) {
            assert.equal(table, 'game_saves');
            return {
                select(cols){this.cols=cols;return this;},
                eq(k,v){this[k]=v;return this;},
                insert(payload){this.mode='insert';this.payload=payload;return this;},
                update(payload){this.mode='update';this.payload=payload;return this;},
                async maybeSingle(){
                    if(this.mode==='update'){
                        if (!db.row || this.revision!==db.row.revision) return {data:null,error:null};
                        db.row={...db.row,...this.payload};db.updates++;
                        return {data:{revision:db.row.revision},error:null};
                    }
                    return {data:db.row?{...db.row}:null,error:null};
                },
                async single(){
                    if(db.row)return{data:null,error:{message:'duplicate',code:'23505'}};
                    db.row={...this.payload};db.inserts++;
                    return{data:{revision:db.row.revision},error:null};
                }
            };
        },
        auth:{async getUser(){return {data:{user:account},error:null};}}
    };
    const listeners = new Map();
    const window = {
        fableStore:null,
        crypto:{randomUUID:nextToken},
        localStorage,
        Event:class{constructor(type){this.type=type;}},
        IDLE_GOOGLE_AUTH:{getClient(){return account?methods:null;},getUser(){return account;}},
        confirm(){return shouldConfirm;},
        location:{reload(){reloads++;}},
        addEventListener(name,fn){listeners.set(name,fn);},
        dispatchEvent(e){if(listeners.has(e.type))listeners.get(e.type)(e);}
    };
    const document={
        readyState:'complete',
        getElementById(k){return elems[k]||null;},
        createElement(){return{click(){backupDownloads++;},remove(){},setAttribute(){},appendChild(){},addEventListener(){},style:{},set href(v){},set download(v){}};},
        body:{appendChild(){}}
    };
    const URLStub={createObjectURL(){return 'blob:test';},revokeObjectURL(){}};
    const sandbox={window,document,URL:URLStub,Blob,Date,JSON,console,state:{running:true},setTimeout(fn){Promise.resolve().then(fn);return 1;},
        setInterval(fn){timers.push(fn);return 1;},
        _lzGet(key){return localStorage.getItem(key);},
        _lzSet(key,value){localStorage.setItem(key,value);return true;},
        _lzSetStoredRaw(key,value){localStorage.setItem(key,value);return true;},
        _lzRemoveStored(key){localStorage.removeItem(key);},
        _saveUnwrap(raw){return{ok:true,payload:raw.startsWith('SIG1:')?raw.split(':').slice(2).join(':'):raw};},
        saveGame(){saveAttempts++;return opts.failedSave?false:true;},
        _roleOtherActiveSessions(){return opts.otherTabs?[{slot:2}]:[];},
        player:{cls:opts.playing?'knight':null}
    };
    vm.runInNewContext(source,sandbox);
    return {data,db,elems,timers,window,get backupDownloads(){return backupDownloads;},
        get reloads(){return reloads;},get saveAttempts(){return saveAttempts;},
        setAccount(id){account=id?{id,email:'example@example.test'}:null;window.dispatchEvent(new window.Event('idle-google-auth-change'));},
        async settle(){for(let i=0;i<7;i++)await tick();},
        async click(id){await elems[id].click();await this.settle();},
        async interval(){for(const fn of timers)await fn();await this.settle();}
    };
}
test('main menu has cloud controls and script',()=>{
    for(const s of ['cloud-save-upload','cloud-save-restore','cloud-save-status','js/34-cloud-save.js'])
        assert.ok(html.includes(s),s);
});
test('snapshot only includes the known game storage keys, never OAuth tokens',async()=>{
    const h=createHarness({local:[['lineage_idle_save_1',save],['sb-project-auth-token','do-not-upload']]});
    await h.settle();
    assert.equal(h.db.row,null);
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();
    await h.settle();
    assert.equal(h.db.inserts,1);
    assert.equal(h.db.row.save_data.entries.lineage_idle_save_1,save);
    assert.equal(h.db.row.save_data.entries['sb-project-auth-token'],undefined);
    assert.equal(JSON.stringify(h.db.row.save_data).includes('do-not-upload'),false);
    assert.equal(h.data.has('fb5_cloud_link_owner_v1'),true);
});
test('guest mode never performs cloud requests or uploads',async()=>{
    const h=createHarness({uid:null,local:[['lineage_idle_save_1',save]]});
    await h.settle(); await h.interval();
    assert.equal(h.db.inserts,0);
    assert.equal(h.elems['cloud-save-upload'].hidden,true);
});
test('unlinked cloud save is not automatically overwritten',async()=>{
    const h=createHarness({local:[['lineage_idle_save_1',save]],cloud:{revision:3,save_data:{format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_1:save}}}});
    await h.settle();await h.interval();
    assert.equal(h.db.updates,0);
    assert.equal(h.db.row.revision,3);
    assert.match(h.elems['cloud-save-status'].textContent,/下載雲端存檔/);
});
test('successful restore backs up local and reloads with cloud save',async()=>{
    const remote='SIG1:test:'+JSON.stringify({v:2,p:{cls:'mage',lv:20},ms:{current:'town_giran'}});
    const h=createHarness({local:[['lineage_idle_save_1',save]],cloud:{revision:4,save_data:{format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_2:remote}}}});
    await h.settle();await h.click('cloud-save-restore');
    assert.equal(h.data.get('lineage_idle_save_1'),undefined);
    assert.equal(h.data.get('lineage_idle_save_2'),remote);
    assert.equal(JSON.parse(h.data.get('fb5_cloud_link_owner_v1')).revision,4);
    assert.equal(h.backupDownloads,1);
    assert.equal(h.reloads,1);
});
test('stale other-device revision cannot be overwritten by auto sync',async()=>{
    const local=[['lineage_idle_save_1',save],['fb5_cloud_link_owner_v1',JSON.stringify({uid:'user-1',revision:1})]];
    const h=createHarness({local,cloud:{revision:1,save_data:{format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_1:save}}}});
    await h.settle();
    h.db.row.revision=2;
    await h.interval();
    assert.equal(h.db.updates,0);
    assert.equal(h.db.row.revision,2);
    assert.match(h.elems['cloud-save-status'].textContent,/自動同步已暫停/);
});
test('invalid or injected cloud keys are rejected',async()=>{
    const h=createHarness({uid:null});
    const validate=h.window.IDLE_CLOUD_SAVE.validate;
    assert.throws(()=>validate({format:'idle-rpg-cloud-bundle',schema:1,entries:{'sb-auth-token':'secret'}}),/無法識別/);
    assert.throws(()=>validate({format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_1:'broken'}}),/有效角色|JSON/);
});
test('an account switch does not transfer old account saves',async()=>{
    const local=[['lineage_idle_save_1',save],['fb5_cloud_link_owner_v1',JSON.stringify({uid:'old-user',revision:7})]];
    const h=createHarness({local,uid:'user-1'});await h.settle();
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();await h.interval();
    assert.equal(h.db.inserts,0);
    assert.match(h.elems['cloud-save-status'].textContent,/其他 Google 帳號/);
    assert.equal(h.elems['cloud-save-upload'].hidden,true);
});
test('active role must save successfully before auto upload',async()=>{
    const h=createHarness({local:[['lineage_idle_save_1',save]],playing:true,failedSave:true});
    await h.settle();
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();await h.settle();
    assert.equal(h.db.inserts,0);
    assert.ok(h.saveAttempts>0);
});
test('new Google account auto-binds after character creation without a manual button',async()=>{
    const h=createHarness({local:[]});
    await h.settle();
    assert.equal(h.db.inserts,0);
    assert.equal(h.elems['cloud-save-upload'].hidden,true);
    assert.match(h.elems['cloud-save-status'].textContent,/首次存檔會自動綁定/);
    h.data.set('lineage_idle_save_1',save);
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();await h.settle();
    assert.equal(h.db.inserts,1);
    assert.equal(h.db.row.revision,1);
    assert.equal(h.db.row.user_id,'user-1');
    assert.equal(h.db.row.save_data.entries.lineage_idle_save_1,save);
});
test('successful JSON import auto-binds existing JSON to the signed-in user',async()=>{
    const h=createHarness({local:[]});await h.settle();
    h.data.set('lineage_idle_save_7',save);
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();await h.settle();
    assert.equal(h.db.inserts,1);
    assert.equal(h.db.row.save_data.entries.lineage_idle_save_7,save);
});
test('an empty browser with existing cloud save restores automatically',async()=>{
    const h=createHarness({local:[],cloud:{
        revision:8,save_data:{format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_4:save}}
    }});await h.settle();
    assert.equal(h.data.get('lineage_idle_save_4'),save);
    assert.equal(JSON.parse(h.data.get('fb5_cloud_link_owner_v1')).revision,8);
    assert.equal(h.reloads,1);
    assert.equal(h.backupDownloads,0);
    assert.equal(h.db.updates,0);
});
test('local data is never replaced without consent',async()=>{
    const h=createHarness({local:[['lineage_idle_save_1',save]],cloud:{
        revision:5,save_data:{format:'idle-rpg-cloud-bundle',schema:1,entries:{lineage_idle_save_2:save}}
    }});await h.settle();
    assert.equal(h.reloads,0);
    assert.equal(h.data.get('lineage_idle_save_1'),save);
    assert.equal(h.data.has('lineage_idle_save_2'),false);
    assert.equal(h.elems['cloud-save-restore'].hidden,false);
});
test('guests never upload even after saving progress',async()=>{
    const h=createHarness({local:[],uid:null});await h.settle();
    h.data.set('lineage_idle_save_1',save);
    h.window.IDLE_CLOUD_SAVE.onProgressSaved();await h.interval();
    assert.equal(h.db.inserts,0);
});
test('existing game save and import paths both notify the cloud layer after successful local writes',()=>{
    const code=fs.readFileSync(path.join(__dirname,'..','js','13-shop-save.js'),'utf8');
    const saveFn=code.slice(code.indexOf('function saveGame()'),code.indexOf('function consolidateInventory()'));
    assert.ok(saveFn.includes('onProgressSaved()'));
    assert.ok(saveFn.indexOf('onProgressSaved()')>saveFn.indexOf('logSys('));
    const importFn=code.slice(code.indexOf('function importSave(n)'),code.indexOf('const CREATION_CLASS_ANIM_FRAMES'));
    assert.ok(importFn.includes('onProgressSaved()'));
    assert.ok(importFn.indexOf('onProgressSaved()')>importFn.indexOf('renderLoadSelect();'));
});

test('new login kicks existing browser and prevents older saves',async()=>{
    const db={row:null,inserts:0,updates:0,sessionId:null,claims:0};
    const first=createHarness({sharedDb:db,local:[['lineage_idle_save_1',save]]});
    await first.settle();
    first.window.IDLE_CLOUD_SAVE.onProgressSaved();await first.settle();
    assert.equal(db.inserts,1);
    const firstToken=db.sessionId;
    const second=createHarness({sharedDb:db,local:[['lineage_idle_save_1',save]]});
    await second.settle();
    assert.notEqual(db.sessionId,firstToken);
    await first.interval();
    assert.equal(first.window.IDLE_CLOUD_SAVE.canSaveLocally(),false);
    first.window.IDLE_CLOUD_SAVE.onProgressSaved();await first.interval();
    assert.equal(db.updates,0);
    assert.equal(second.window.IDLE_CLOUD_SAVE.canSaveLocally(),true);
});
test('old session cannot write even before the next polling check',async()=>{
    const db={row:null,inserts:0,updates:0,sessionId:null,claims:0};
    const old=createHarness({sharedDb:db,local:[['lineage_idle_save_1',save]]});
    await old.settle();
    const newer=createHarness({sharedDb:db,local:[['lineage_idle_save_1',save]]});
    await newer.settle();
    old.window.IDLE_CLOUD_SAVE.onProgressSaved();await old.settle();
    assert.equal(db.inserts,0);
    assert.equal(old.window.IDLE_CLOUD_SAVE.canSaveLocally(),false);
});