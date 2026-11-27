# Discourse 書庫

會員可以在公開帖子裡用 `@ZlibBot` 加上書名、作者或 ISBN。機器人會在原帖列出不同版本，每頁先顯示 EPUB。直接回覆機器人時，會員可以請它再查一次、指定檔案格式，或提供另一個書名，無須再次輸入帳號。發起搜尋的會員點選版本後，可準備下載，或把 EPUB 附件插入本帖的回覆草稿，確認後再發送。頁首的書本按鈕也可以在私訊裡搜尋。書庫帳密存於論壇後台的 AI 憑證，兩條自動化的語言模型欄位均留空。

## 在論壇管理後台安裝

1. 到 **外觀 → 主題與元件 → 元件 → 安裝 → 從 Git 倉庫**，貼上 `https://github.com/ieduer/discourse-zlibrary`，安裝 **Forum Book Library** 並掛到使用中的主題。入口名稱隨介面語言略有不同。[參考元件](https://github.com/ieduer/discourse-bilibili-inline-player)
2. 在後台確認 **Discourse AI** 與 **Automation** 已啟用。建立專用論壇群組 `zlibrary`，在群組的訊息權限允許預期會員發送私訊。群組成員可以閱讀寄到該群組的私訊，因此一般讀者只需發信權限。
3. 在 **AI → Credentials（憑證）** 新增帳號憑證，將下列三項作為單一 JSON 值填入。帳號用電子郵件，來源填能登入 EAPI 的服務網域。已有帳號憑證的論壇可沿用原有綁定。
   ```json
   {"origin":"https://your-book-service.example","email":"your-account@example.org","password":"your-password"}
   ```
4. 在 **AI → Tools（工具）→ Import** 匯入工具，再將 `book_account` 綁定至帳號憑證。只用帳號憑證時，選 [forum-book-tool.json](https://raw.githubusercontent.com/ieduer/discourse-zlibrary/main/native/forum-book-tool.json)。若要在保留既有帳密的情況下獨立調整官方站點順序，選 [forum-book-tool-origins.json](https://raw.githubusercontent.com/ieduer/discourse-zlibrary/main/native/forum-book-tool-origins.json)，並將 `book_origins` 綁定至另一個憑證，其內容為下方的 JSON 陣列。更新既有工具時，讓原本的兩條自動化繼續指向同一工具。
   ```json
   ["https://z-library.website", "https://z-lib.gd"]
   ```
5. 確認論壇有一個名為 `ZlibBot` 的非管理員帳號，可以回覆預定開放的分類。在 **Automation** 建立兩條 **AI Tool Action**，工具均選 **Forum Book Library**，模型留空。觸發器均選 **Post created/edited**，動作選 **Created**。私訊規則的主題類型選 **Personal messages**，**Restricted inbox groups** 只選 `zlibrary`。公開規則的主題類型選 **Public topics**，**Post features** 和收件群組都留空。更新舊規則時請移除 **Links**，讓直接回覆機器人的純文字帖子也能觸發。工具會核對帖首提及的帳號，或核對會員所回覆的機器人樓層。儲存後啟用兩條規則。
6. 回到主題元件設定，將 `book_inbox_group` 設為 `zlibrary`，將 `book_bot_username` 設為論壇帳號的確切名稱，儲存並重新整理。若改用其他機器人帳號，憑證 JSON 內的 `bot_username` 也要改成相同名稱。`book_embed_max_mb` 設定瀏覽器準備檔案的上限，論壇本身的附件上限也適用。要關閉書庫時，停用這兩條自動化，並清空 `book_inbox_group`。

獨立憑證的第一項是每次搜尋最先使用的站點。可交換順序，或只保留其中一項。使用單一帳號憑證的安裝也可在原 JSON 加入 `origins` 陣列，格式相同。工具依序採用獨立的 `book_origins`、帳號憑證的 `origins`、原有的單一 `origin`。管理員可從範例中的兩個網域及供應方公布的 `z-lib.sk`、`z-library.sk`、`z-lib.fm` 選擇最多三個，逐一填入 HTTPS 網址。登入與書目查詢只連到清單內的站點，錯誤設定會在連線前停止。[供應方公告](https://lib-talk.io/viewtopic.php?t=113)

登入或搜尋受 DNS 查詢失敗或 TCP 無法建立連線影響時，工具才會試下一個已設定站點，每個站點最多一次。若服務回覆帳密錯誤、驗證要求、限流或配額用盡，該次搜尋就會停止。TLS 錯誤、連線後讀取逾時或其他無法判斷的錯誤也會停止搜尋。選定版本後，工具會回到傳回該書目的站點登入，並向它索取下載連結。移除該站點後，會員需要重新搜尋。舊版產生的選版連結沒有記錄站點，啟用站點陣列後也需要重新搜尋。

登入、搜尋和取檔路徑可以在帳號憑證中分別填入 `login_path`、`search_path` 和 `file_path`。預設值依序為 `/eapi/user/login`、`/eapi/book/search`、`/eapi/book/{id}/{hash}/file`，取檔路徑須保留 `{id}` 和 `{hash}`。

## 下載方式

會員可在公開帖的書庫指令或私訊搜尋框中加上 `--site 1` 或 `--site 2`，只查管理員清單中對應的站點。有設定第三站的論壇也接受 `--site 3`。未指定時依序自動嘗試。需要翻頁時可再加 `--page 2`，兩個選項的順序不限。翻頁會保留手動選擇的站點。

從頁首開啟書庫時，搜尋、翻頁和取檔會沿用同一封群組私訊。在公開帖子叫用機器人時，書目與選版連結會顯示在原帖，點選後的取檔請求走群組私訊。每次搜尋的選版連結供搜尋者使用 20 分鐘。會員按「準備下載」或「在本帖嵌入 EPUB」時，論壇才會向上游取得所選版本。瀏覽器若無法直接讀取上游的 EPUB，可先下載檔案，再從同一視窗選取檔案並插入回覆草稿。

上游提供獨立下載網域時，瀏覽器直接開啟供應方給該版本的 HTTPS 連結。若要用共用帳號讀取同網域的檔案，已知大小且不超過 2 MiB 的版本可轉成論壇私訊附件，格式與存取權沿用論壇的上傳設定。更大、大小不詳或上游轉址的檔案會使用服務方提供的連結；若該連結還要求讀者個別登入，瀏覽器將要求登入。論壇沒有接收書庫原始帳密的前端欄位。

外掛對照 [heartleo/zlib v0.0.16](https://github.com/heartleo/zlib/tree/v0.0.16/internal/zlib) 的 EAPI。接到 Z-Library 前，站方帳號須有程式存取及多人共用的授權。[上游條款](https://zlib.bz/tos)

## 測試

執行 `node native/pack.mjs --check` 核對匯入檔，再執行 `node --test test/native.test.mjs`。一般程式提交只執行上述檢查。需要驗證論壇安裝與瀏覽器下載時，可在 Actions 手動執行，或在 `main` 的提交訊息中加入 `[forum-ci]`。完整測試使用隔離的 Discourse 與書庫樣本，限時 15 分鐘。[測試紀錄](https://github.com/ieduer/discourse-zlibrary/actions)

## 根據帖子辨認書名

回覆一篇帖子時，單獨輸入 `@ZlibBot`，或問 `@ZlibBot 這篇出自哪本書？`。機器人會讀取所回覆的樓層。提到「原帖」時會讀取首帖及主題標題。書名號、ISBN、作者、譯者及「選自《書名》」等標註都可以提供書目線索。直接輸入書名、作者或 ISBN 仍可正常選版。

查詢作品出處時，回覆會列出收錄作品的書名和書目來源。若帖中只有篇名及作者，工具會優先使用有出版資料佐證的對照。遇到其他作品，會先確認原文可供匿名讀取，再以篇名及明列的作者向 Wikidata 查詢一次。查詢只接受作者及收錄關係均吻合、且僅對應到一本書的結果。未能確認時，機器人會請讀者補充出處。書庫搜尋只接收辨認出的書名或 ISBN。原帖所列譯者會影響書庫版本的排列，個別版本的出版資料依書庫記錄顯示。
