/* Google sign-in for the static GitHub Pages build.
 * Identity only (Phase 1). Game saves and shared local data are NOT synchronized.
 * OAuth is handled by Supabase Auth with PKCE and browser-persisted sessions.
 */
(function () {
    'use strict';

    const SDK_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js';
    const ids = {
        login: 'btn-google-login',
        logout: 'btn-google-logout',
        status: 'google-auth-status',
        start: 'btn-start-menu'
    };
    let client = null;
    let user = null;
    let phase = 'unconfigured';
    let lastError = '';
    // Public app integration surface: no tokens or keys are exposed here.
    window.IDLE_GOOGLE_AUTH = Object.freeze({ getClient: function () { return client; }, getUser: function () { return user; } });

    function element(name) { return document.getElementById(ids[name]); }

    function validConfig(config) {
        if (!config || typeof config.supabaseUrl !== 'string' ||
            typeof config.supabasePublishableKey !== 'string') return false;
        const key = config.supabasePublishableKey.trim();
        if (!key || key.startsWith('sb_secret_') || key.toLowerCase().includes('service_role')) return false;
        try {
            const url = new URL(config.supabaseUrl);
            return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password &&
                !url.search && !url.hash;
        } catch (_) { return false; }
    }

    function render() {
        const login = element('login');
        const logout = element('logout');
        const status = element('status');
        const start = element('start');
        if (!login || !logout || !status || !start) return;

        const busy = phase === 'loading' || phase === 'signing-in' || phase === 'signing-out';
        login.hidden = !!user;
        login.disabled = !client || busy || phase !== 'ready';
        login.textContent = phase === 'loading' ? 'Google 登入初始化中…' :
            phase === 'signing-in' ? '正在前往 Google…' : '使用 Google 帳號登入';
        logout.hidden = !user;
        logout.disabled = busy;
        start.textContent = user ? '開始遊戲（已登入）' : '開始遊戲（訪客）';

        if (lastError) status.textContent = 'Google 登入發生問題：' + lastError + '。你仍可使用本機角色。';
        else if (user) status.textContent = '已登入：' +
            (typeof user.email === 'string' && user.email ? user.email : 'Google 使用者') +
            '。本階段不會上傳本機存檔。';
        else if (phase === 'unconfigured') status.textContent =
            '尚未設定 Google 登入；訪客模式與本機存檔正常可用。';
        else if (phase === 'loading') status.textContent = '正在連線至帳號驗證服務…';
        else if (phase === 'signing-in') status.textContent = '登入中，請稍候…';
        else status.textContent = '尚未登入。可選擇 Google 登入或以訪客身份遊玩；存檔均保留在本機。';
        if (typeof window.dispatchEvent === 'function' && typeof window.Event === 'function')
            window.dispatchEvent(new window.Event('idle-google-auth-change'));
    }

    function loadSdk() {
        if (window.supabase && typeof window.supabase.createClient === 'function')
            return Promise.resolve(window.supabase);
        return new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.src = SDK_SRC;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.addEventListener('load', function () {
                if (window.supabase && typeof window.supabase.createClient === 'function')
                    resolve(window.supabase);
                else reject(new Error('登入程式庫無法初始化'));
            });
            script.addEventListener('error', function () {
                reject(new Error('無法下載登入程式庫，請確認網路或稍後重試'));
            });
            document.head.appendChild(script);
        });
    }

    async function signIn() {
        if (!client || phase !== 'ready' || user) return;
        if (window.location.protocol !== 'https:' &&
            window.location.hostname !== 'localhost' &&
            window.location.hostname !== '127.0.0.1') {
            lastError = '必須從 HTTPS 網站或 localhost 執行';
            render();
            return;
        }
        phase = 'signing-in';
        lastError = '';
        render();
        try {
            // Exact site origin/path (including /my-idle-rpg/ on GitHub Pages).
            // No external input is accepted for redirectTo.
            const redirectTo = new URL(window.location.pathname, window.location.origin).href;
            const result = await client.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: redirectTo }
            });
            if (result && result.error) throw result.error;
        } catch (e) {
            lastError = (e && e.message) || '無法啟動登入';
        } finally {
            // On success the SDK navigates to Google; this also handles browser blockers.
            phase = 'ready';
            render();
        }
    }

    async function signOut() {
        if (!client || !user || phase !== 'ready') return;
        phase = 'signing-out';
        lastError = '';
        render();
        try {
            const result = await client.auth.signOut();
            if (result && result.error) throw result.error;
            user = null;
        } catch (e) {
            lastError = (e && e.message) || '登出失敗';
        } finally {
            phase = 'ready';
            render();
        }
    }

    async function init() {
        const login = element('login');
        const logout = element('logout');
        if (!login || !logout || !element('status') || !element('start')) return;
        login.addEventListener('click', signIn);
        logout.addEventListener('click', signOut);

        const config = window.IDLE_GOOGLE_AUTH_CONFIG;
        if (!validConfig(config)) {
            phase = 'unconfigured';
            render();
            return;
        }

        phase = 'loading';
        render();
        try {
            const sdk = await loadSdk();
            client = sdk.createClient(config.supabaseUrl.trim(), config.supabasePublishableKey.trim(), {
                auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
            });
            client.auth.onAuthStateChange(function (_event, session) {
                user = session && session.user ? session.user : null;
                render();
            });
            const result = await client.auth.getSession();
            if (result && result.error) throw result.error;
            user = result && result.data && result.data.session ? result.data.session.user : null;
            phase = 'ready';
            render();
        } catch (e) {
            client = null;
            phase = 'error';
            lastError = (e && e.message) || '初始化失敗';
            render();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
}());
