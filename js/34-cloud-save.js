/* One JSON document per Google account; no game save format migration.
 * This file never sends any auth tokens or browser-wide localStorage contents to Supabase.
 */
(function () {
    'use strict';
    const FORMAT = 'idle-rpg-cloud-bundle';
    const TABLE = 'game_saves';
    const LINK_KEY = 'fb5_cloud_link_owner_v1';
    const MAX_JSON_CHARS = 12 * 1024 * 1024;
    const INTERVAL_MS = 60000;

    const KEYS = [];
    for (let n = 1; n <= 8; n++) KEYS.push('lineage_idle_save_' + n);
    const modeKeys = [
        'lineage_idle_warehouse', 'lineage_idle_carddex', 'lineage_idle_equipdex',
        'lineage_idle_miscdex', 'lineage_idle_relicdex', 'fb5_pet_roster'
    ];
    for (const base of modeKeys) {
        for (const suffix of ['', '_classic']) {
            KEYS.push(base + suffix);
            if (base === 'lineage_idle_warehouse' || base === 'fb5_pet_roster')
                KEYS.push(base + suffix + '_rm');
        }
    }
    KEYS.push('fb5_clan_state_v1', 'fb5_pandora_relic_market_v1',
        'fb5_merc_exp_ledger', 'lineage_idle_autosell_global_v1');
    for (const mode of ['normal', 'classic']) {
        const base = 'fb5_mercenary_employment_v1_' + mode;
        KEYS.push(base);
        for (let n = 1; n <= 8; n++) KEYS.push(base + '_leader_' + n);
    }

    let client = null;
    let userId = null;
    let revision = null;
    let active = false;
    let firstUploadArmed = false;
    let accountReady = false;
    let hasCloud = false;
    let pendingProgress = false;
    let saveScheduled = false;
    let busy = false;
    let accountEpoch = 0;
    let lastPayload = null;
    let lastMessage = 'Google 登入後，建立角色或匯入進度便會自動綁定帳號。';
    let lastError = false;

    function $(id) { return document.getElementById(id); }
    function setMessage(message, error) {
        lastMessage = message;
        lastError = !!error;
        draw();
    }
    function draw() {
        const upload = $('cloud-save-upload'), restore = $('cloud-save-restore'), status = $('cloud-save-status');
        if (!upload || !restore || !status) return;
        const signedIn = !!client && !!userId && !window.fableStore;
        // Manual upload is reserved for resolving an existing-cloud conflict.
        upload.hidden = !(signedIn && accountReady && hasCloud && !active);
        upload.textContent = '以本機進度覆蓋雲端';
        restore.hidden = !(signedIn && accountReady && hasCloud);
        upload.disabled = restore.disabled = busy;
        const start = $('btn-start-menu');
        if (start) start.disabled = signedIn && !accountReady;
        status.textContent = signedIn ? lastMessage : '訪客模式僅儲存在本機；Google 登入後，進度會自動綁定與備份。';
        status.style.color = lastError ? '#fca5a5' : '#e7d7b5';
    }
    function readLink() {
        try {
            const raw = window.localStorage.getItem(LINK_KEY);
            const p = JSON.parse(raw || 'null');
            if (p && typeof p.uid === 'string' && Number.isSafeInteger(p.revision) && p.revision > 0)
                return p;
        } catch (_) {}
        return null;
    }
    function writeLink(uid, rev) {
        window.localStorage.setItem(LINK_KEY, JSON.stringify({ uid: uid, revision: rev }));
    }
    function snapshot() {
        const entries = {};
        for (const key of KEYS) {
            const raw = typeof _lzGet === 'function' ? _lzGet(key) : null;
            if (raw == null) continue;
            if (typeof raw !== 'string') throw new Error('本機儲存格式異常：' + key);
            entries[key] = raw;
        }
        const doc = { format: FORMAT, schema: 1, entries: entries };
        validate(doc);
        return doc;
    }
    function validate(doc) {
        if (!doc || doc.format !== FORMAT || doc.schema !== 1 ||
            !doc.entries || Array.isArray(doc.entries) || typeof doc.entries !== 'object') {
            throw new Error('雲端存檔格式不符合此遊戲版本');
        }
        const keys = Object.keys(doc.entries);
        if (keys.some(key => !KEYS.includes(key) || typeof doc.entries[key] !== 'string'))
            throw new Error('雲端存檔包含無法識別的資料');
        for (let n = 1; n <= 8; n++) {
            const s = doc.entries['lineage_idle_save_' + n];
            if (!s) continue;
            if (typeof _saveUnwrap !== 'function') throw new Error('遊戲讀檔引擎尚未載入');
            const parsed = _saveUnwrap(s);
            if (!parsed || !parsed.ok) throw new Error('第 ' + n + ' 格存檔完整性校驗失敗');
            let obj;
            try { obj = JSON.parse(parsed.payload); } catch (_) { throw new Error('第 ' + n + ' 格 JSON 無效'); }
            if (!obj || !obj.p || !obj.p.cls || !obj.ms) throw new Error('第 ' + n + ' 格不是有效角色');
        }
        if (JSON.stringify(doc).length > MAX_JSON_CHARS) throw new Error('存檔超過雲端備份大小上限');
    }
    function isPlaying() {
        try {
            const game = $('game-screen');
            return !!(game && !game.classList.contains('hidden') && typeof player !== 'undefined' && player && player.cls);
        } catch (_) { return false; }
    }
    function safeToRestore() {
        if (isPlaying()) {
            setMessage('請先返回遊戲主選單，避免目前角色繼續寫入舊進度。', true);
            return false;
        }
        if (typeof _roleOtherActiveSessions === 'function' && _roleOtherActiveSessions().length) {
            setMessage('偵測到其他遊戲分頁仍在執行，請先關閉再還原。', true);
            return false;
        }
        return true;
    }
    function localHasProgress() {
        return KEYS.some(k => /^lineage_idle_save_[1-8]$/.test(k) && _lzGet(k) != null);
    }
    function localHasAnyState() {
        return KEYS.some(k => _lzGet(k) != null);
    }
    function onProgressSaved() {
        // Invoked only after successful existing saveGame/importSave writes.
        if (!client || !userId) return;
        if (!accountReady) { pendingProgress = true; return; }
        if (!active && !firstUploadArmed) return;
        if (saveScheduled) return;
        saveScheduled = true;
        const epoch = accountEpoch;
        setTimeout(function () {
            saveScheduled = false;
            if (accountEpoch === epoch) uploadCloud(false);
        }, 1200);
    }
    function getAuth() { return window.IDLE_GOOGLE_AUTH || null; }
    async function verifiedUser() {
        if (!client) return null;
        const response = await client.auth.getUser();
        if (response.error) throw response.error;
        return response.data && response.data.user ? response.data.user : null;
    }
    async function serverRow(uid) {
        const r = await client.from(TABLE).select('revision,save_data,updated_at')
            .eq('user_id', uid).maybeSingle();
        if (r.error) throw r.error;
        return r.data || null;
    }
    function showAccountState(row, uid) {
        const link = readLink();
        accountReady = true;
        hasCloud = !!row;
        lastPayload = null;
        if (!row) {
            // No cloud save: the NEXT successful import/create/save becomes revision 1.
            // Do not silently send another Google account's local saves to this UID.
            firstUploadArmed = !link || link.uid === uid;
            active = false;
            revision = null;
            setMessage(firstUploadArmed
                ? '此 Google 帳號尚無進度。直接創角或匯入 JSON，首次存檔會自動綁定帳號。'
                : '本機進度已綁定其他 Google 帳號，已禁止自動轉存；請改用原帳號或獨立瀏覽器設定檔。',
                !firstUploadArmed);
        } else if (link && link.uid === uid && link.revision === row.revision && localHasProgress()) {
            firstUploadArmed = false;
            active = true;
            revision = row.revision;
            setMessage('已同步 Google 雲端進度（版本 ' + revision + '）。');
        } else {
            firstUploadArmed = false;
            active = false;
            revision = row.revision;
            setMessage(link && link.uid && link.uid !== uid
                ? '這台電腦仍有其他 Google 帳號的本機資料。請先處理原進度，再下載目前帳號雲端存檔。'
                : '找到雲端進度（版本 ' + row.revision + '）。本機已有不同進度，請選擇「下載雲端存檔」避免覆蓋。');
        }
    }
    async function refreshAccount() {
        const auth = getAuth();
        const possibleClient = auth && typeof auth.getClient === 'function' ? auth.getClient() : null;
        const possibleUser = auth && typeof auth.getUser === 'function' ? auth.getUser() : null;
        const uid = possibleClient && possibleUser && possibleUser.id ? possibleUser.id : null;
        if (!uid || !possibleClient) {
            accountEpoch++;
            client = null; userId = null; revision = null; active = false;
            firstUploadArmed = false; accountReady = false; hasCloud = false;
            pendingProgress = false; lastPayload = null;
            draw();
            return;
        }
        if (userId === uid && client === possibleClient) return;
        const epoch = ++accountEpoch;
        client = possibleClient;
        userId = uid;
        active = false; accountReady = false; firstUploadArmed = false; hasCloud = false;
        pendingProgress = false;
        setMessage('正在確認 Google 帳號的雲端進度…');
        try {
            const validUser = await verifiedUser();
            if (epoch !== accountEpoch || !validUser || validUser.id !== uid) return;
            const row = await serverRow(uid);
            if (epoch !== accountEpoch) return;
            showAccountState(row, uid);
            if (row && !localHasAnyState() && safeToRestore()) {
                await restoreCloud(true);
                return;
            }
            if (!row && pendingProgress && firstUploadArmed) {
                pendingProgress = false;
                onProgressSaved();
            }
        } catch (e) {
            if (epoch !== accountEpoch) return;
            accountReady = true; // Still allow offline/local gameplay after a lookup error.
            active = false; firstUploadArmed = false;
            setMessage('無法讀取雲端存檔：' + ((e && e.message) || '連線失敗') +
                '。已停止自動上傳，請稍後重試。', true);
        }
    }
    function downloadBackup(doc) {
        const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'idle-rpg-local-before-cloud-restore-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    function restoreEntries(entries) {
        const before = new Map();
        const previousLink = window.localStorage.getItem(LINK_KEY);
        for (const key of KEYS) before.set(key, window.localStorage.getItem(key));
        try {
            for (const key of KEYS) {
                if (Object.prototype.hasOwnProperty.call(entries, key)) {
                    if (typeof _lzSet !== 'function' || !_lzSet(key, entries[key]))
                        throw new Error('本機儲存空間不足：' + key);
                } else if (typeof _lzRemoveStored === 'function') _lzRemoveStored(key);
                else window.localStorage.removeItem(key);
            }
        } catch (e) {
            for (const [key, value] of before.entries()) {
                if (value == null) {
                    if (typeof _lzRemoveStored === 'function') _lzRemoveStored(key);
                    else window.localStorage.removeItem(key);
                } else if (typeof _lzSetStoredRaw === 'function') _lzSetStoredRaw(key, value);
                else window.localStorage.setItem(key, value);
            }
            if (previousLink == null) window.localStorage.removeItem(LINK_KEY);
            else window.localStorage.setItem(LINK_KEY, previousLink);
            throw e;
        }
    }
    async function restoreCloud(automatic) {
        if (!client || !userId || busy || !safeToRestore()) return;
        if (automatic && localHasAnyState()) return;
        busy = true; draw();
        const epoch = accountEpoch, uid = userId;
        try {
            const validUser = await verifiedUser();
            if (!validUser || validUser.id !== uid || epoch !== accountEpoch) throw new Error('登入帳號已變更');
            const row = await serverRow(uid);
            if (!row) throw new Error('目前雲端沒有存檔');
            validate(row.save_data);
            if (!automatic && !window.confirm('下載雲端存檔將取代這台電腦的 8 格角色及共用資料。系統會先下載本機備份檔；確定還原嗎？')) return;
            if (!safeToRestore() || epoch !== accountEpoch) return;
            // Backup BEFORE touching local save data; failure aborts restore.
            if (!automatic) downloadBackup(snapshot());
            restoreEntries(row.save_data.entries);
            writeLink(uid, row.revision);
            setMessage('雲端進度已還原，即將重新載入遊戲。');
            window.location.reload();
        } catch (e) {
            setMessage('還原失敗：' + ((e && e.message) || '未知錯誤'), true);
        } finally {
            busy = false; draw();
        }
    }
    async function uploadCloud(manual) {
        if (!client || !userId || busy) return;
        // The manual override only exists when a remote save already exists.
        if (manual && !hasCloud) return;
        const uid = userId, epoch = accountEpoch;
        // No cloud save: successful in-game save / JSON import can insert revision 1.
        if (!manual && !active && !firstUploadArmed) return;
        if (manual) {
            const link = readLink();
            const warning = link && link.uid !== uid
                ? '注意：本機資料綁定了另一個 Google 帳號，繼續會把本機進度上傳到目前登入的帳號。確定嗎？'
                : '確定將此電腦的完整進度 JSON 上傳至目前 Google 帳號？如果雲端已有進度，會取代雲端版本。';
            if (!window.confirm(warning)) return;
        }
        busy = true; draw();
        try {
            const validUser = await verifiedUser();
            if (!validUser || validUser.id !== uid || epoch !== accountEpoch) throw new Error('登入帳號已變更');
            if (isPlaying()) {
                if (typeof saveGame !== 'function' || saveGame() !== true)
                    throw new Error('無法保存進行中的角色，已取消上傳');
            }
            const bundle = snapshot(), json = JSON.stringify(bundle);
            if (!Object.keys(bundle.entries).some(k => /^lineage_idle_save_[1-8]$/.test(k)))
                throw new Error('目前沒有可上傳的角色進度');
            if (!manual && json === lastPayload) return;

            // Compare-and-set with server revision: another device can never be
            // overwritten by a stale automatic upload.
            const row = await serverRow(uid);
            if (epoch !== accountEpoch) throw new Error('登入帳號已變更');
            let result, nextRevision;
            if (manual) {
                if (row && !window.confirm('雲端目前已有版本 ' + row.revision + '。再次確認要以本機進度覆蓋雲端嗎？')) return;
            } else if (firstUploadArmed) {
                if (row) {
                    active = false; firstUploadArmed = false; hasCloud = true;
                    throw new Error('其他裝置已先建立雲端存檔。自動綁定已暫停，避免覆蓋');
                }
            } else if (!row || row.revision !== revision) {
                active = false;
                throw new Error('雲端已有較新的版本；自動同步已暫停，請先決定使用哪一份進度');
            }
            if (!row) {
                result = await client.from(TABLE).insert({ user_id: uid, revision: 1, save_data: bundle })
                    .select('revision').single();
                nextRevision = 1;
            } else {
                result = await client.from(TABLE).update({
                    save_data: bundle, revision: row.revision + 1, updated_at: new Date().toISOString()
                }).eq('user_id', uid).eq('revision', row.revision).select('revision').maybeSingle();
                if (!result.error && !result.data) {
                    active = false;
                    throw new Error('其他裝置剛更新雲端，已拒絕覆蓋');
                }
                nextRevision = row.revision + 1;
            }
            if (result.error) throw result.error;
            if (epoch !== accountEpoch) return;
            writeLink(uid, nextRevision);
            revision = nextRevision;
            active = true;
            firstUploadArmed = false;
            hasCloud = true;
            lastPayload = json;
            setMessage('已儲存至雲端（版本 ' + nextRevision + '）。每 60 秒自動同步。');
        } catch (e) {
            if (epoch === accountEpoch)
                setMessage('雲端同步失敗：' + ((e && e.message) || '未知錯誤'), true);
        } finally {
            busy = false; draw();
        }
    }
    function start() {
        if (window.fableStore) return; // Desktop file-store build is intentionally excluded.
        const up = $('cloud-save-upload'), down = $('cloud-save-restore');
        if (!up || !down) return;
        up.addEventListener('click', function () { uploadCloud(true); });
        down.addEventListener('click', restoreCloud);
        window.addEventListener('idle-google-auth-change', function () {
            setTimeout(refreshAccount, 0);
        });
        setTimeout(refreshAccount, 0);
        setInterval(function () { uploadCloud(false); }, INTERVAL_MS);
        draw();
    }

    window.IDLE_CLOUD_SAVE = Object.freeze({
        // Explicitly exported for integration tests; excludes credentials and raw save data.
        keys: KEYS.slice(), validate: validate, onProgressSaved: onProgressSaved
    });
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}());
