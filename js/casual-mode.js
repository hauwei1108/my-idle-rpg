/* Independent local-only casual mode. Normal mode remains byte-for-byte equivalent in multiplier calls. */
(function () {
  'use strict';
  var KEY = 'my_idle_rpg_casual_mode_v1';
  var current = false;
  try { current = localStorage.getItem(KEY) === 'on'; } catch (_) {}
  var values = Object.freeze({ exp: 50, drop: 500, damage: 5, taken: 0.2, gold: 50, speed: 3, enhance: 1 });
  window.casualMultiplier = function (key) {
    return current && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : 1;
  };
  // Hit is an additive stat, not a multiplier; applies equally to melee and ranged attacks.
  window.casualHitBonus = function () { return current ? 30 : 0; };
  window.casualModeEnabled = function () { return current; };
  window.setCasualMode = function (enabled) {
    current = !!enabled;
    try { localStorage.setItem(KEY, current ? 'on' : 'off'); } catch (_) {}
    var btn = document.getElementById('casual-mode-toggle');
    if (btn) { btn.textContent = current ? '休閒模式：開啟' : '休閒模式：關閉'; btn.setAttribute('aria-pressed', String(current)); }
  };
  function render() {
    if (!document.body || document.getElementById('casual-mode-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'casual-mode-toggle';
    btn.type = 'button';
    btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:100000;background:#183153;color:#fff;border:1px solid #e9c46a;border-radius:8px;padding:9px 13px;font-size:14px;cursor:pointer';
    btn.title = '休閒：經驗×50、掉寶×500、物理傷害×5、物理受傷20%、金幣×50、攻速×3、強化100%。切換後立即影響後續計算。';
    btn.addEventListener('click', function () { window.setCasualMode(!current); });
    document.body.appendChild(btn);
    window.setCasualMode(current);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
