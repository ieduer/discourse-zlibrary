# Discourse 書庫

會員點論壇頁首的書本按鈕，輸入書名、作者或 ISBN，按格式篩選、翻頁、選擇版本，再下載該版本。論壇後台匯入 Git 主題元件，內建的 Discourse AI 自訂工具與 Automation 在同一論壇代會員處理請求。帳密存於論壇後台的 AI 憑證。執行書庫工具時，語言模型欄位留空。

## 在論壇管理後台安裝

1. 到 **外觀 → 主題與元件 → 元件 → 安裝 → 從 Git 倉庫**，貼上 `https://github.com/ieduer/discourse-zlibrary`，安裝 **Forum Book Library** 並掛到使用中的主題。入口名稱隨介面語言略有不同。[參考元件](https://github.com/ieduer/discourse-bilibili-inline-player)
2. 在後台確認 **Discourse AI** 與 **Automation** 已啟用。建立專用論壇群組 `zlibrary`，在群組的訊息權限允許預期會員發送私訊。群組成員可以閱讀寄到該群組的私訊，因此一般讀者只需發信權限。
3. 在 **AI → Credentials（憑證）** 新增一個憑證，將下列三項作為單一 JSON 值填入。帳號用電子郵件，來源填能登入 EAPI 的服務網域。
   ```json
   {"origin":"https://your-book-service.example","email":"your-account@example.org","password":"your-password"}
   ```
4. 在 **AI → Tools（工具）→ Import** 匯入 [forum-book-tool.json](https://raw.githubusercontent.com/ieduer/discourse-zlibrary/main/native/forum-book-tool.json)。在工具的憑證綁定中，將 `book_account` 選為上一步建立的憑證並儲存。這份匯入檔只含工具程式；站方帳密僅填在憑證欄位。
5. 到 **Automation → 新增**，腳本選 **AI Tool Action**，工具選 **Forum Book Library**，模型留空。觸發器選 **Post created/edited**，動作選 **Created**，主題類型選 **Personal messages**，**Restricted inbox groups** 選 `zlibrary`。儲存並啟用這項自動化。
6. 回到主題元件設定，將 `book_inbox_group` 設為 `zlibrary`，儲存並重新整理頁面。留空時會隱藏書庫。需要關閉時也可從使用中的主題移除元件。

## 下載方式

搜尋與選版在論壇視窗內完成。每次開啟視窗，第一次搜尋會寄一封私訊到書庫群組，後續翻頁及下載沿用這封對話。查詢及結果留在該私訊，系統回覆只會送回發出請求的主題。自訂工具會在伺服器登入書庫。會員按「準備下載」才會向上游取得下載連結，隨後點「下載」儲存檔案。

上游提供獨立下載網域時，瀏覽器直接開啟供應方給該版本的 HTTPS 連結。若要用共用帳號讀取同網域的檔案，已知大小且不超過 2 MiB 的版本可轉成論壇私訊附件，格式與存取權沿用論壇的上傳設定。更大、大小不詳或上游轉址的檔案會使用服務方提供的連結；若該連結還要求讀者個別登入，瀏覽器將要求登入。論壇沒有接收書庫原始帳密的前端欄位。

外掛對照 [heartleo/zlib v0.0.16](https://github.com/heartleo/zlib/tree/v0.0.16/internal/zlib) 的 EAPI。接到 Z-Library 前，站方帳號須有程式存取及多人共用的授權。[上游條款](https://zlib.bz/tos)

## 測試

執行 `node native/pack.mjs --check` 核對匯入檔，再執行 `node --test test/native.test.mjs`。一般程式提交只執行上述檢查。需要驗證論壇安裝與瀏覽器下載時，可在 Actions 手動執行，或在 `main` 的提交訊息中加入 `[forum-ci]`。完整測試使用隔離的 Discourse 與書庫樣本，限時 15 分鐘。[測試紀錄](https://github.com/ieduer/discourse-zlibrary/actions)
