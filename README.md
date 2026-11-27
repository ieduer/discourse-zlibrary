# Discourse Z-Library

這個外掛在論壇側欄加入「書庫」。已登入的會員可以按書名、作者或 ISBN 搜尋，按格式篩選，選定一個版本後下載。論壇伺服器使用管理員在安裝時設定的帳號，所有下載共用該帳號的額度。

對接 Z-Library 前，營運方需取得涵蓋程式存取及多人共用的授權。一般帳號條款第 7 節禁止自動建立帳號，第 15 節禁止讓他人使用同一帳號。倉庫內的安裝測試使用模擬書目與檔案，可以在沒有真實帳號的環境執行。[上游使用條款](https://zlib.bz/tos)

## 安裝在自管 Discourse

本版以 Discourse `v2026.10.2`、Ruby 3.4 和標準 `discourse_docker` 單容器為目標。外掛以 Ruby 實作 [heartleo/zlib v0.0.16 的 EAPI 協定](https://github.com/heartleo/zlib/tree/v0.0.16/internal/zlib)，直接使用論壇現有的 HTTPS、登入和翻譯元件。共用帳號只在伺服器端使用。

1. 選定 [外掛倉庫](https://github.com/ieduer/discourse-zlibrary/commits/main/) 中要安裝的提交，記下完整的 40 位 Git SHA。
2. 把下列三項併入 `/var/discourse/containers/app.yml` **已有的** `env` 區段。網域填入管理員已確認能直接登入 EAPI 的 HTTPS 來源。電子郵件和密碼填入此次安裝使用的帳號。

   ```yaml
   env:
     ZLIBRARY_ORIGIN: 'https://YOUR-ACCOUNT-DOMAIN'
     ZLIBRARY_EMAIL: 'YOUR-ACCOUNT-EMAIL'
     ZLIBRARY_PASSWORD: 'YOUR-ACCOUNT-PASSWORD'
   ```

   如果密碼由主機上的密鑰檔管理，第三項可以改用 `ZLIBRARY_PASSWORD_FILE`，值為容器內的絕對路徑。該檔由 Discourse 服務帳號讀取，只含密碼一行。請將帶有帳密的安裝設定留在伺服器的私有設定中。

3. 在已有的 `hooks.after_code` 陣列加入下列項目，將 `REVIEWED_COMMIT_SHA` 換成第一步記下的提交。每次重建都會安裝同一個版本。

   ```yaml
   hooks:
     after_code:
       - exec:
           cd: $home/plugins
           cmd:
             - git clone https://github.com/ieduer/discourse-zlibrary.git
             - git -C discourse-zlibrary checkout --detach REVIEWED_COMMIT_SHA
   ```

4. 依論壇的正常發布程序重建應用程式容器。標準單容器安裝在 `/var/discourse` 執行 `./launcher rebuild app`。外掛預設停用，可先安裝，再補上第 2 步的帳號設定。管理員確認設定後，在論壇後台開啟 `zlibrary_enabled`。
5. 用一般會員登入後開啟側欄「書庫」，也可直接進入 `/z-library`。搜尋一本已知有權下載的書，選定版本，再核對下載的檔名、格式與檔案內容。

## 設定及維護

管理員可以在外掛設定中切換 `zlibrary_enabled`，或調整 `zlibrary_max_download_mb`。單檔預設上限為 128 MiB。結果會顯示上游提供的作者、出版資訊、語言、格式和檔案大小。只搜尋、翻頁或選擇版本不會呼叫上游取檔介面。

伺服器在第一次操作時以安裝帳密登入，將上游工作階段留在應用程式程序記憶體。上游明確拒絕既有工作階段時，外掛重新登入一次。額度用盡或上游要求另外驗證時，會員會看到對應提示。變更安裝環境變數後需重新載入應用容器。上游網域若只有轉址功能，請改填實際提供 EAPI 的來源。

下載使用與論壇同源的 POST 請求。伺服器先確認會員身分與所選版本，再透過 Discourse 的外連位址檢查讀取檔案。檔案暫存於匿名暫存檔，檢查長度後分塊交給瀏覽器儲存。瀏覽器完成接收後才會開啟儲存流程。中斷和超限會關閉暫存檔。外掛沒有資料庫遷移。

如要停用，可先關閉 `zlibrary_enabled`。完整移除時，從建置設定移除對應的 Git 步驟與帳號設定，再依原發布程序重建。

## 驗證

在外掛目錄執行 `ruby test/client_test.rb` 進行離線協定測試。在具備完整測試環境的 Discourse 原始碼目錄，將外掛放入 `plugins/discourse-zlibrary` 後執行以下指令。

```sh
LOAD_PLUGINS=1 bundle exec rspec plugins/discourse-zlibrary/spec/requests/books_spec.rb
LOAD_PLUGINS=1 bundle exec rspec plugins/discourse-zlibrary/spec/system/book_search_spec.rb
```

對照的上游提交為 `1484717de019f2f4b8bff6cb862f88d0acdc8c56`。[登入與搜尋](https://github.com/heartleo/zlib/blob/v0.0.16/internal/zlib/eapi.go) · [下載連結解析](https://github.com/heartleo/zlib/blob/v0.0.16/internal/zlib/eapi_book.go) · [Discourse 自管外掛安裝文件](https://meta.discourse.org/t/install-plugins-on-a-self-hosted-site/19157)
