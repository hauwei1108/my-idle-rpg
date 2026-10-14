# Google 一鍵登入（第一階段）

本專案維持 GitHub Pages 純靜態部署，使用 Supabase Auth 的 Google OAuth + PKCE。這一版只提供身分登入、重新進站恢復 Session、登出與訪客模式。**不會把角色、共用倉庫、寵物、血盟或遊戲數值上傳到雲端**；登入後仍使用原本瀏覽器的八格本機存檔。

## 第一次部署（管理員操作）

1. 登入 https://supabase.com/dashboard 並建立 Supabase 專案。
2. 前往 Authentication → Providers → Google。依畫面指示啟用 Google provider。
3. 到 https://console.cloud.google.com/auth/clients 建立「Web application」OAuth Client，取得 Google Client ID 與 Client Secret。依 Supabase 的 Google 設定頁，將 Supabase 提供的 callback URL 放入 Google 的 Authorized redirect URIs。通常為 https://PROJECT_REF.supabase.co/auth/v1/callback。Authorized JavaScript origins 加入 https://hauwei1108.github.io （若未來使用自訂網域須補上）。
4. **只在 Supabase Dashboard** 貼上 Google Client ID / Client Secret；絕對不要把 Google Client Secret 放入 GitHub 或前端 JS。
5. Supabase → Authentication → URL Configuration：Site URL 設成 https://hauwei1108.github.io/my-idle-rpg/ ，Redirect URLs 允許同一個完整位址。如果 GitHub Pages 使用其他實際網域或路徑，請改成正式網址。開發時可另外允許 http://localhost:PORT/ 。
6. 修改 js/google-auth-config.js 中兩個空白欄位：
   - supabaseUrl = Supabase → Project Settings → API 所顯示的 Project URL。
   - supabasePublishableKey = Supabase 的 publishable key（sb_publishable_...）；舊型 anon public key 也可使用。
7. 部署後用 Google 登入、重新整理確認 Session 還原，再登出並確認原本角色仍在同一瀏覽器內。

## 安全事項

- **不可**放置 Supabase service_role key、sb_secret_*、Google Client Secret 或任何管理用金鑰。publishable/anon key 會公開出現在瀏覽器；它不是保密憑證。
- Google OAuth 回到首頁；程式以目前 origin + pathname 作為 redirectTo，不使用外部輸入。
- 使用 PKCE 流程。玩家身分只來自 Supabase Auth Session，顯示 Email 時用 textContent 避免 HTML 注入。
- 本機存檔與 OAuth 帳號現在**尚未綁定**：改用另一台電腦登入同一個 Google 帳號，第一階段不會同步角色進度。清除本機儲存空間仍會遺失未匯出的本機進度。
- 登入身份**不是**遊戲反作弊驗證。第二階段如要雲端存檔，必須額外加入資料列權限（RLS）、資料完整性與多裝置衝突策略。
- 設定尚未完成、Supabase 不可用或 CDN 載入失敗時，Google 按鈕會停用，訪客遊玩不受影響。
- 若需要支援桌面打包版（file:// 或 Windows 主程式），必須另設 OAuth deep-link / native callback；目前僅支援 HTTPS 網頁及 localhost。

## 自動測試

使用 Node.js 22 執行：node --test tests/google-auth.test.cjs

現有 CI 會執行 Node.js 語法檢查和休閒模式測試；PR 另加入 Google Auth 靜態測試。
