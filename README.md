# Discourse 書庫

會員可以在公開帖子裡用 `@ZlibBot` 加上書名、作者或 ISBN。機器人會在原帖列出不同版本，每頁先顯示 EPUB。發起搜尋的會員點選版本後，可準備下載，或把 EPUB 附件插入本帖的回覆草稿，確認後再發送。頁首的書本按鈕也可以在私訊裡搜尋。書庫帳密存於論壇後台的 AI 憑證，兩條自動化的語言模型欄位均留空。

## 在論壇管理後台安裝

1. 到 **外觀 → 主題與元件 → 元件 → 安裝 → 從 Git 倉庫**，貼上 `https://github.com/ieduer/discourse-zlibrary`，安裝 **Forum Book Library** 並掛到使用中的主題。入口名稱隨介面語言略有不同。[參考元件](https://github.com/ieduer/discourse-bilibili-inline-player)
2. 在後台確認 **Discourse AI** 與 **Automation** 已啟用。建立專用論壇群組 `zlibrary`，在群組的訊息權限允許預期會員發送私訊。群組成員可以閱讀寄到該群組的私訊，因此一般讀者只需發信權限。
3. 在 **AI → Credentials（憑證）** 新增一個憑證，將下列三項作為單一 JSON 值填入。帳號用電子郵件，來源填能登入 EAPI 的服務網域。
   ```json
   {"origin":"https://your-book-service.example","email":"your-account@example.org","password":"your-password"}
   ```
4. 在 **AI → Tools（工具）→ Import** 匯入 [forum-book-tool.json](https://raw.githubusercontent.com/ieduer/discourse-zlibrary/main/native/forum-book-tool.json)。在工具的憑證綁定中，將 `book_account` 選為上一步建立的憑證並儲存。這份匯入檔只含工具程式；站方帳密僅填在憑證欄位。
5. 確認論壇有一個名為 `ZlibBot` 的非管理員帳號，可以回覆預定開放的分類。在 **Automation** 建立兩條 **AI Tool Action**，工具均選 **Forum Book Library**，模型留空。觸發器均選 **Post created/edited**，動作選 **Created**。私訊規則的主題類型選 **Personal messages**，**Restricted inbox groups** 只選 `zlibrary`。公開規則的主題類型選 **Public topics**，**Post features** 選 **Links**，收件群組留空。已登入會員在帖首提及機器人時，Discourse 會將提及轉為連結，工具會核對機器人名稱後才搜尋。儲存後啟用兩條規則。
6. 回到主題元件設定，將 `book_inbox_group` 設為 `zlibrary`，將 `book_bot_username` 設為論壇帳號的確切名稱，儲存並重新整理。若改用其他機器人帳號，憑證 JSON 內的 `bot_username` 也要改成相同名稱。`book_embed_max_mb` 設定瀏覽器準備檔案的上限，論壇本身的附件上限也適用。要關閉書庫時，停用這兩條自動化，並清空 `book_inbox_group`。

上游服務更換登入網域時，修改憑證內的 `origin`。登入、搜尋和取檔路徑也可以分別填入 `login_path`、`search_path` 和 `file_path`。預設值依序為 `/eapi/user/login`、`/eapi/book/search`、`/eapi/book/{id}/{hash}/file`，取檔路徑須保留 `{id}` 和 `{hash}`。

## 下載方式

從頁首開啟書庫時，搜尋、翻頁和取檔會沿用同一封群組私訊。在公開帖子叫用機器人時，書目與選版連結會顯示在原帖，點選後的取檔請求走群組私訊。每次搜尋的選版連結供搜尋者使用 20 分鐘。會員按「準備下載」或「在本帖嵌入 EPUB」時，論壇才會向上游取得所選版本。瀏覽器若無法直接讀取上游的 EPUB，可先下載檔案，再從同一視窗選取檔案並插入回覆草稿。

上游提供獨立下載網域時，瀏覽器直接開啟供應方給該版本的 HTTPS 連結。若要用共用帳號讀取同網域的檔案，已知大小且不超過 2 MiB 的版本可轉成論壇私訊附件，格式與存取權沿用論壇的上傳設定。更大、大小不詳或上游轉址的檔案會使用服務方提供的連結；若該連結還要求讀者個別登入，瀏覽器將要求登入。論壇沒有接收書庫原始帳密的前端欄位。

外掛對照 [heartleo/zlib v0.0.16](https://github.com/heartleo/zlib/tree/v0.0.16/internal/zlib) 的 EAPI。接到 Z-Library 前，站方帳號須有程式存取及多人共用的授權。[上游條款](https://zlib.bz/tos)

## 測試

執行 `node native/pack.mjs --check` 核對匯入檔，再執行 `node --test test/native.test.mjs`。一般程式提交只執行上述檢查。需要驗證論壇安裝與瀏覽器下載時，可在 Actions 手動執行，或在 `main` 的提交訊息中加入 `[forum-ci]`。完整測試使用隔離的 Discourse 與書庫樣本，限時 15 分鐘。[測試紀錄](https://github.com/ieduer/discourse-zlibrary/actions)
