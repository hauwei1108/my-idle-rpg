'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'js', '33-google-auth.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(config, user, sdkPresent = true) {
    const elements = Object.create(null);
    for (const id of ['btn-google-login', 'btn-google-logout', 'google-auth-status', 'btn-start-menu']) {
        elements[id] = {
            textContent: '',
            hidden: id === 'btn-google-logout',
            disabled: false,
            handlers: {},
            addEventListener(name, fn) { this.handlers[name] = fn; },
            click() { if (!this.disabled && !this.hidden && this.handlers.click) return this.handlers.click(); }
        };
    }
    let subscribed = null;
    let requested = null;
    let options = null;
    let signouts = 0;
    const auth = {
        onAuthStateChange(fn) { subscribed = fn; return {data: { subscription: { unsubscribe() {} } }}; },
        async getSession() { return {data: {session: user ? {user} : null}, error: null}; },
        async signInWithOAuth(args) { requested = args; return {error: null}; },
        async signOut() { signouts++; if (subscribed) subscribed('SIGNED_OUT', null); return {error: null}; }
    };
    const win = {
        location: {origin: 'https://hauwei1108.github.io', pathname: '/my-idle-rpg/', protocol: 'https:', hostname: 'hauwei1108.github.io'},
        IDLE_GOOGLE_AUTH_CONFIG: config,
        supabase: sdkPresent ? {createClient(url, key, opts) {
            options = {url, key, opts};
            return {auth};
        }} : undefined
    };
    const document = {
        readyState: 'complete',
        head: {appendChild(node) { if (!sdkPresent) node.handlers.error(); }},
        getElementById(id) { return elements[id] || null; },
        createElement() {
            return {handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }};
        }
    };
    vm.runInNewContext(script, {window: win, document, URL, console, Promise, Error});
    return {
        elements, flush,
        auth,
        get subscribed() { return subscribed; },
        get requested() { return requested; },
        get options() { return options; },
        get signouts() { return signouts; }
    };
}
const CONFIG = {supabaseUrl: 'https://example-project.supabase.co', supabasePublishableKey: 'sb_publishable_for_test'};

test('index keeps the original guest path and includes auth scripts', () => {
    assert.match(index, /onclick="openLoadSelect\(\)"/);
    assert.match(index, /js\/google-auth-config\.js/);
    assert.match(index, /js\/33-google-auth\.js/);
});
test('without credentials Google is disabled while guest play stays available', async () => {
    const h = harness({supabaseUrl: '', supabasePublishableKey: ''});
    await flush();
    assert.equal(h.elements['btn-google-login'].disabled, true);
    assert.equal(h.elements['btn-start-menu'].disabled, false);
    assert.match(h.elements['google-auth-status'].textContent, /訪客模式/);
});
test('rejects secret-like keys in browser configuration', async () => {
    const h = harness({supabaseUrl: CONFIG.supabaseUrl, supabasePublishableKey: 'sb_secret_private'});
    await flush();
    assert.equal(h.elements['btn-google-login'].disabled, true);
});
test('configured login uses Google OAuth, PKCE, and exact Pages redirect URL', async () => {
    const h = harness(CONFIG);
    await flush(); await flush();
    assert.equal(h.options.url, CONFIG.supabaseUrl);
    assert.equal(h.options.opts.auth.flowType, 'pkce');
    assert.equal(h.options.opts.auth.persistSession, true);
    assert.equal(h.options.opts.auth.detectSessionInUrl, true);
    await h.elements['btn-google-login'].click();
    assert.equal(h.requested.provider, 'google');
    assert.equal(h.requested.options.redirectTo, 'https://hauwei1108.github.io/my-idle-rpg/');
});
test('session restores identity safely and logout does not touch saves', async () => {
    const h = harness(CONFIG, {email: '<script>alert(1)</script>@example.test'});
    await flush(); await flush();
    assert.equal(h.elements['btn-google-login'].hidden, true);
    assert.equal(h.elements['btn-google-logout'].hidden, false);
    assert.match(h.elements['google-auth-status'].textContent, /<script>/);
    assert.match(h.elements['google-auth-status'].textContent, /以此帳號的雲端進度為準/);
    await h.elements['btn-google-logout'].click();
    assert.equal(h.signouts, 1);
    assert.equal(h.elements['btn-google-login'].hidden, false);
    assert.equal(h.elements['btn-start-menu'].textContent, '開始遊戲（訪客）');
});
test('SDK load failure leaves the guest game usable', async () => {
    const h = harness(CONFIG, null, false);
    await flush(); await flush();
    assert.equal(h.elements['btn-google-login'].disabled, true);
    assert.equal(h.elements['btn-start-menu'].disabled, false);
    assert.match(h.elements['google-auth-status'].textContent, /登入發生問題/);
});
