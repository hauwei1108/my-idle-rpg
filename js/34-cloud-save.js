/* One JSON document per Google account; no game save format migration.
 * This file never sends any auth tokens or browser-wide localStorage contents to Supabase.
 */
(function () {
    'use strict';
    const FORMAT = 'idle-rpg-cloud-bundle';
    const TABLE = 'game_saves';
    const LINK_KEY = 'fb5_cloud_link_owner_v1';
    const NOTICE_KEY = 'fb5_guest_to_google_notice_v1';
    const BOOT_KEY = 'fb5_cloud_bootstrap_once_v1';
    const MAX_JSON_CHARS = 12 * 1024 * 1024;
    // Regularly persist active gameplay: cloud snapshots are not tied to the game's 5-minute autosave.
    const INTERVAL_MS = 10000;
    const SESSION_CHECK_MS = 5000;

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
    let pendingUpload = false;
    let insideCloudLocalSave = false;
    let busy = false;
    let sessionToken = null;
    let kicked = false;
    let claiming = false;
    let accountEpoch = 0;
    let lastPayload = null;
    let lastMessage = 'Google 帳號以雲端進度為準；沒有雲端角色時可創角或匯入 JSON。';
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
        // Google cloud save is authoritative. No manual upload/restore choice on login.
        upload.hidden = true;
        restore.hidden = true;
        upload.disabled = restore.disabled = true;
        const start = $('btn-start-menu');
        if (start) start.disabled = signedIn && (!accountReady || kicked);
        status.textContent = signedIn ? lastMessage : '訪客進度只存本機；切換 Google 帳號前請先匯出 JSON。';
        status.style.color = lastError ? '#fca5a5' : '#e7d7b5';
    }
    function canSaveLocally() { return !kicked; }
    function showKickedScreen() {
        const status = $('cloud-save-status');
        if (status) status.textContent = '此 Google 帳號已在其他裝置或分頁登入，本連線已中止。';
        if (typeof state !== 'undefined' && state) state.running = false;
        if ($('cloud-session-kicked')) return;
        const el = document.createElement('div');
        el.id = 'cloud-session-kicked';
        el.setAttribute('role', 'alertdialog');
        el.setAttribute('aria-modal', 'true');
        el.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.95);'+
            'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;'+
            'font:18px sans-serif;color:#fff;text-align:center;padding:24px;';
        const heading = document.createElement('h2');
        heading.textContent = '帳號已在其他裝置登入';
        const msg = document.createElement('p');
        msg.textContent = '依照後登入優先規則，這個遊戲連線已被登出。重新整理可重新取得使用權，並踢除其他連線。';
        const backup = document.createElement('button');
        backup.textContent = '下載這台裝置的本機進度備份';
        backup.style.cssText = 'background:#1f2937;color:white;padding:12px 20px;border:1px solid #94a3b8;cursor:pointer;';
        backup.addEventListener('click', function () {
            try { downloadBackup(snapshot()); }
            catch (e) { window.alert('本機備份失敗：' + (e && e.message || '未知錯誤')); }
        });
        const btn = document.createElement('button');
        btn.textContent = '重新登入此帳號';
        btn.style.cssText = 'background:#875719;color:white;padding:12px 20px;border:1px solid #d7aa45;cursor:pointer;';
        btn.addEventListener('click', function () { window.location.reload(); });
        el.appendChild(heading); el.appendChild(msg); el.appendChild(backup); el.appendChild(btn);
        document.body.appendChild(el);
    }
    function markKicked() {
        if (kicked) return;
        // Claiming another session prevents old cloud writes immediately. Preserve the
        // still-live role in the old browser first, so its unsent progress remains recoverable.
        try {
            if (isPlaying() && typeof saveGame === 'function') saveGame();
        } catch (e) { console.warn('[cloud] local save on session displacement failed', e); }
        kicked = true;
        active = false; firstUploadArmed = false; accountReady = false;
        pendingProgress = false; sessionToken = null;
        lastPayload = null;
        setMessage('此帳號已由其他裝置或分頁登入，本連線已停止。', true);
        showKickedScreen();
    }
    function isSessionReplaced(error) {
        const msg = String(error && (error.message || error.details || '') || '');
        return msg.includes('GAME_SESSION_REPLACED') || msg.includes('GAME_SESSION_REQUIRED');
    }
    async function claimSession(epoch) {
        if (!client || !userId || kicked) return false;
        if (!window.crypto || typeof window.crypto.randomUUID !== 'function')
            throw new Error('此瀏覽器無法建立安全的登入連線 ID');
        const token = window.crypto.randomUUID();
        claiming = true;
        try {
            const result = await client.rpc('claim_game_session', { p_session: token });
            if (result.error) throw result.error;
            if (epoch !== accountEpoch || kicked) return false;
            sessionToken = token;
            return true;
        } finally { claiming = false; }
    }
    async function checkSession() {
        if (!client || !userId || !sessionToken || kicked || claiming) return;
        const epoch = accountEpoch;
        try {
            const result = await client.rpc('game_session_alive', { p_session: sessionToken });
            if (epoch !== accountEpoch || kicked) return;
            if (result.error) throw result.error;
            if (result.data !== true) markKicked();
        } catch (e) {
            if (epoch === accountEpoch && isSessionReplaced(e)) markKicked();
            // Network errors are not a kick; cloud RPCs will fail closed until restored.
        }
    }
    function readLink() {
        try {
            const raw = window.localStorage.getItem(LINK_KEY);
            const p = JSON.parse(raw || 'null');
            if (p && typeof p.uid === 'string' && Number.isSafeInteger(p.revision) && p.revision >= 0)
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
    function hasStoredGameState() {
        return KEYS.some(key => _lzGet(key) != null);
    }
    function stashTabValue(key, obj) {
        try { if (window.sessionStorage) window.sessionStorage.setItem(key, JSON.stringify(obj)); }
        catch (_) {}
    }
    function takeTabValue(key) {
        try {
            if (!window.sessionStorage) return null;
            const raw = window.sessionStorage.getItem(key);
            window.sessionStorage.removeItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }
    function prepareGoogleSignIn() {
        // No silent migration of guest saves into a Google account.
        if (isPlaying()) {
            if (typeof saveGame !== 'function' || saveGame() !== true) {
                window.alert('本機遊戲進度尚未成功儲存，已取消 Google 登入。');
                return false;
            }
        }
        const link = readLink();
        if (localHasProgress() && !link) {
            const yes = window.confirm(
                '即將切換為 Google 帳號進度。\n\n' +
                '目前的訪客角色不會自動綁定 Google 帳號，也不會取代雲端進度。' +
                '\n請先在角色選擇畫面使用「匯出進度」保存 JSON。' +
                '\n\n按「取消」先去匯出；確認已備份後，才按「確定」繼續登入。'
            );
            if (!yes) return false;
        }
        stashTabValue(NOTICE_KEY, { at: Date.now() });
        return true;
    }
    function prepareReplacement(uid) {
        const link = readLink();
        if (!localHasProgress() || (link && link.uid === uid)) return true;
        const notice = takeTabValue(NOTICE_KEY);
        if (notice && Date.now() - Number(notice.at || 0) < 10 * 60 * 1000) return true;
        // Covers an older browser session where OAuth had already been established
        // without the new pre-login warning.
        return window.confirm(
            '這台電腦還有訪客或其他帳號的本機角色。\n' +
            'Google 登入後一律以該帳號的雲端 JSON 為準。' +
            '\n請先匯出原本的角色進度；繼續將取代本機角色。\n\n確定繼續嗎？'
        );
    }
    function matchesCloud(row) {
        const local = snapshot().entries, remote = row.save_data.entries;
        const keys = Object.keys(local), other = Object.keys(remote);
        return keys.length === other.length && keys.every(k =>
            Object.prototype.hasOwnProperty.call(remote, k) && local[k] === remote[k]);
    }
    function markReload(uid, rev) {
        stashTabValue(BOOT_KEY, { uid: uid, revision: rev, at: Date.now() });
    }
    function justReloaded(uid, rev) {
        const marker = takeTabValue(BOOT_KEY);
        return !!(marker && marker.uid === uid && marker.revision === rev &&
            Date.now() - Number(marker.at || 0) < 2 * 60 * 1000);
    }
    function activateCloud(row, uid) {
        if (!row) {
            active = false;
            firstUploadArmed = true;
            hasCloud = false;
            revision = null;
            accountReady = true;
            lastPayload = null;
            setMessage('雲端尚無進度。直接建立角色或匯入 JSON，第一次成功存檔就會綁定此 Google 帳號。');
        } else {
            active = true;
            firstUploadArmed = false;
            hasCloud = true;
            revision = Number(row.revision);
            accountReady = true;
            lastPayload = null;
            setMessage('已載入 Google 雲端進度（版本 ' + revision + '），後續自動同步。');
        }
    }
    async function applyCloudAsAuthority(row, uid, epoch) {
        if (!safeToRestore() || accountEpoch !== epoch) return;
        if (row) validate(row.save_data);
        // OAuth callback is the only time guest progress can be swapped.
        // User must acknowledge export risk before anything is replaced.
        if (!prepareReplacement(uid)) {
            accountReady = false;
            setMessage('尚未切換進度。請先匯出訪客 JSON，之後重新登入 Google 帳號。', true);
            return;
        }
        const rev = row ? Number(row.revision) : 0;
        const freshReload = justReloaded(uid, rev);
        if (freshReload) {
            // The earlier request applied the complete cloud JSON just before reload.
            activateCloud(row, uid);
            return;
        }
        const same = row ? matchesCloud(row) : !hasStoredGameState();
        if (!same) {
            // Never upload the current guest/old cache to the signed-in account.
            // On existing Google cloud: download and replace regardless of local revision.
            // Without cloud save: start with an empty account, ready for import or creation.
            restoreEntries(row ? row.save_data.entries : {});
            writeLink(uid, rev);
            markReload(uid, rev);
            setMessage(row ? '正在載入 Google 雲端角色…' : '正在建立空白 Google 遊戲進度…');
            window.location.reload();
            return;
        }
        writeLink(uid, rev);
        activateCloud(row, uid);
    }
    function afterGoogleSignOut() {
        // Signed-in account cache must never become a guest role.
        // The cloud data remains in Supabase. This clears only known game keys.
        try {
            restoreEntries({});
            window.localStorage.removeItem(LINK_KEY);
            if (window.sessionStorage) {
                window.sessionStorage.removeItem(BOOT_KEY);
                window.sessionStorage.removeItem(NOTICE_KEY);
            }
            window.location.reload();
        } catch (e) {
            setMessage('登出後清除暫存進度失敗：' + (e && e.message || '未知錯誤'), true);
        }
    }
    function onProgressSaved() {
        // A successful local save is the canonical signal of unsent progress.
        if (!client || !userId || kicked || insideCloudLocalSave) return;
        if (!accountReady) { pendingProgress = true; return; }
        if (!active && !firstUploadArmed) return;
        if (busy) { pendingUpload = true; return; }
        if (saveScheduled) return;
        saveScheduled = true;
        const epoch = accountEpoch;
        // A backgrounded tab may be suspended immediately. Avoid the old 1.2s delay
        // in that case; a synchronous local save has already completed.
        const delay = document.hidden ? 0 : 200;
        setTimeout(function () {
            saveScheduled = false;
            if (accountEpoch === epoch) uploadCloud(false);
        }, delay);
    }
    function getAuth() { return window.IDLE_GOOGLE_AUTH || null; }
    async function verifiedUser() {
        if (!client) return null;
        const response = await client.auth.getUser();
        if (response.error) throw response.error;
        return response.data && response.data.user ? response.data.user : null;
    }
    async function serverRow(uid) {
        if (!sessionToken || kicked) throw new Error('GAME_SESSION_REQUIRED');
        const r = await client.rpc('read_game_save', { p_session: sessionToken });
        if (r.error) throw r.error;
        return r.data || null;
    }
    async function refreshAccount() {
        const auth = getAuth();
        const possibleClient = auth && typeof auth.getClient === 'function' ? auth.getClient() : null;
        const possibleUser = auth && typeof auth.getUser === 'function' ? auth.getUser() : null;
        const uid = possibleClient && possibleUser && possibleUser.id ? possibleUser.id : null;
        if (!uid || !possibleClient) {
            accountEpoch++;
            client = null; userId = null; revision = null; active = false;
            sessionToken = null;
            firstUploadArmed = false; accountReady = false; hasCloud = false;
            pendingProgress = false; pendingUpload = false; lastPayload = null;
            draw();
            return;
        }
        if (kicked) return;
        if (userId === uid && client === possibleClient) return;
        const epoch = ++accountEpoch;
        client = possibleClient;
        userId = uid;
        active = false; accountReady = false; firstUploadArmed = false; hasCloud = false;
        pendingProgress = false;
        setMessage('正在從雲端載入此 Google 帳號的遊戲進度…');
        try {
            const validUser = await verifiedUser();
            if (epoch !== accountEpoch || !validUser || validUser.id !== uid) return;
            if (!(await claimSession(epoch))) return;
            const row = await serverRow(uid);
            if (epoch !== accountEpoch) return;
            await applyCloudAsAuthority(row, uid, epoch);
            if (epoch !== accountEpoch) return;
            if (!row && accountReady && pendingProgress && firstUploadArmed) {
                pendingProgress = false;
                onProgressSaved();
            }
        } catch (e) {
            if (epoch !== accountEpoch) return;
            if (isSessionReplaced(e)) { markKicked(); return; }
            accountReady = false; // Do not start cloud games against stale local data.
            active = false; firstUploadArmed = false;
            setMessage('無法載入 Google 雲端進度：' + ((e && e.message) || '連線失敗') +
                '。已停止進入遊戲，避免使用錯誤的本機角色。', true);
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
        if (!client || !userId || !sessionToken || kicked || busy || !safeToRestore()) return;
        // Cloud is authoritative; cached browser data never suppresses remote restore.
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
            if (isSessionReplaced(e)) markKicked();
            else setMessage('還原失敗：' + ((e && e.message) || '未知錯誤'), true);
        } finally {
            busy = false; draw();
        }
    }
    async function uploadCloud(manual) {
        if (!client || !userId || !sessionToken || kicked || busy) return;
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
                if (typeof saveGame !== 'function')
                    throw new Error('缺少本機存檔功能，已取消上傳');
                // saveGame calls onProgressSaved; do not cause re-entrant uploads.
                insideCloudLocalSave = true;
                let saved = false;
                try { saved = saveGame() === true; }
                finally { insideCloudLocalSave = false; }
                if (!saved) throw new Error('無法保存進行中的角色，已取消上傳');
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
            // Atomic DB-side session verification and revision compare-and-swap.
            // A kicked client cannot write, even during the five-second polling interval.
            result = await client.rpc('write_game_save', {
                p_session: sessionToken,
                p_expected_revision: row ? row.revision : 0,
                p_data: bundle
            });
            if (result.error) throw result.error;
            nextRevision = Number(result.data);
            if (!Number.isSafeInteger(nextRevision) || nextRevision < 1)
                throw new Error('雲端回傳無效的存檔版本');
            if (epoch !== accountEpoch) return;
            writeLink(uid, nextRevision);
            revision = nextRevision;
            active = true;
            firstUploadArmed = false;
            hasCloud = true;
            lastPayload = json;
            setMessage('已儲存至雲端（版本 ' + nextRevision + '）。每 10 秒自動同步。');
        } catch (e) {
            if (epoch === accountEpoch) {
                if (isSessionReplaced(e)) markKicked();
                else {
                    if (String(e && e.message || '').includes('SAVE_REVISION_CONFLICT')) {
                        active = false; firstUploadArmed = false;
                    }
                    setMessage('雲端同步失敗：' + ((e && e.message) || '未知錯誤'), true);
                }
            }
        } finally {
            busy = false; draw();
            // New local data may have arrived during an in-flight cloud request.
            // Never drop that signal merely because the upload was busy.
            if (pendingUpload) {
                pendingUpload = false;
                if (!kicked && (active || firstUploadArmed)) onProgressSaved();
            }
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
        // Never bind pre-existing local data merely because 60 seconds elapsed.
        // First cloud upload must follow successful import/creation/save event.
        setInterval(function () { if (active) uploadCloud(false); }, INTERVAL_MS);
        // The game already flushes its local save earlier in the registration order.
        // Start network upload without waiting for the next scheduled timer.
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && !kicked && (active || firstUploadArmed))
                uploadCloud(false);
        });
        setInterval(checkSession, SESSION_CHECK_MS);
        draw();
    }

    window.IDLE_CLOUD_SAVE = Object.freeze({
        // Explicitly exported for integration tests; excludes credentials and raw save data.
        keys: KEYS.slice(), validate: validate, onProgressSaved: onProgressSaved,
        canSaveLocally: canSaveLocally, prepareGoogleSignIn: prepareGoogleSignIn,
        afterGoogleSignOut: afterGoogleSignOut
    });
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}());
