# Google 帳號自動綁定進度與後登入優先

## 使用者操作

1. Google 一鍵登入後，檢查是否已有雲端存檔。
2. **沒有雲端存檔：** 直接在任一空欄位「匯入進度」或「建立角色」。遊戲本機存檔／匯入成功後，自動把原本的 8 格角色與共用資料打包成一份 JSON 上傳並綁定此 Google 帳號，無須另外按「上傳」。
3. **已有雲端存檔、裝置沒有任何本機遊戲資料：** 自動下載並還原原本的 JSON，重新載入遊戲。
4. **已有雲端存檔、裝置也有本機進度：** 不擅自覆蓋。提示下載雲端或手動處理衝突；還原前需確認並下載本機備份。
5. 綁定成功後，成功存檔時觸發同步，並每 60 秒再同步一次。網路問題不影響本機進度，但不能聲稱已完成雲端備份。

## 後登入優先

同一 Google/Supabase 帳號僅保留 **一個**有效遊戲連線：
- 每次登入或重新整理時建立新的高熵 UUID，透過 `claim_game_session` 記錄最後的連線，取代前一個。
- 舊裝置／分頁每 **5 秒**查詢 `game_session_alive`，發現被取代就停止遊戲、禁止本機 `saveGame()`，覆蓋畫面並顯示重新登入按鈕。
- 真正雲端存檔讀寫透過 `read_game_save` / `write_game_save` RPC：即使舊分頁尚未完成輪詢，舊 UUID 也不能再讀寫雲端存檔。
- `write_game_save` 會在資料庫交易中鎖定登入連線並檢查 revision，防止踢人與寫入同時競爭。
- 不主動呼叫 Supabase 全域 signOut（那會影響新裝置）；畫面阻擋代表**遊戲連線**失效，不等於 Google OAuth 權杖在 Google 平台撤銷。
- 若原連線已離線，網路恢復後才會發現自己被踢。伺服器仍會拒絕舊 UUID 的資料操作；無法完全避免純離線的本機暫存變更。

## 資料格式／保護

沿用原本的本機 `_lzGet`/`_lzSet` 和 JSON 存檔。每個 `auth.uid()` 在 `game_saves` 對應一個 JSONB `save_data`，包含八格角色、倉庫、寵物、圖鑑、血盟、潘朵拉、傭兵索引等。僅明確列出的遊戲資料鍵被同步；不包含 Supabase Auth token、舊備份檔、分頁暫態鎖。

Supabase 表格啟用 RLS，未授權匿名使用者沒有存取權。完成新的 session-RPC migration 後，`authenticated` 也不能直接修改 `game_saves`，只能經過有效 session 驗證的 RPC。存檔大小約束 12MB 且 revision 版本比較。此架構不是伺服器防作弊設計。

SQL：
- `supabase/migrations/20261014_create_game_saves.sql`
- `supabase/migrations/20261014_latest_game_session.sql`

單元測試：`node --test tests/cloud-save.test.cjs`。