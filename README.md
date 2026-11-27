# Discourse 書庫

從論壇後台匯入此 GitHub 倉庫，即可將書庫掛到現有主題。會員點頁首的書本按鈕，按書名、作者或 ISBN 搜尋，依格式篩選及翻頁，選定其中一個版本後下載。元件及書庫服務可獨立更新，安裝元件後重新整理頁面即可。

## 在論壇後台安裝

1. 進入 **管理 → 外觀 → 主題與元件 → 元件 → 安裝 → 從 Git 倉庫**。舊版的入口在 **管理 → 自訂 → 主題**。
2. 貼上 `https://github.com/ieduer/discourse-zlibrary`，安裝 **Forum Book Library**，在元件頁勾選使用中的主題。也可以先安裝，稍後再啟用。
3. 下方的書庫服務就緒後，在元件設定把 `book_service_path` 填成 `/z-library-api`，儲存並重新整理。留空會隱藏入口。論壇帳號登入後才會顯示書本按鈕。

安裝方式與 [Bilibili 播放器元件](https://github.com/ieduer/discourse-bilibili-inline-player) 相同。[Discourse 官方主題元件安裝文件](https://meta.discourse.org/t/installing-a-theme-or-theme-component/63682)

## 設定共用帳號

主題元件會送到會員的瀏覽器。共用書庫帳密只放在此倉庫 `service/` 的獨立 Cloudflare Worker。已部署服務的論壇只需完成上面的主題元件安裝。

1. 在管理論壇網域的 Cloudflare 帳戶建立書庫 Worker。下列連結會從公開倉庫的 `service/` 目錄建立服務。[從 Cloudflare 部署書庫服務](https://deploy.workers.cloudflare.com/?url=https://github.com/ieduer/discourse-zlibrary/tree/main/service)
2. 在 Worker 的 **Settings → Variables and Secrets** 填寫下表。新增服務、設定路由和更新秘密都在 Cloudflare 完成。
3. 在 **Settings → Domains & Routes → Add → Route** 只掛上書庫的路徑。若論壇位於 `forum.example.org`，區域選 `example.org`，路由填 `forum.example.org/z-library-api/*`。網域需使用 Cloudflare 代理。會員驗證沿用該網域現有的 Discourse 登入。
4. 回到論壇完成安裝步驟 3。用一般會員搜尋並選擇有權取得的版本，核對下載檔名與內容。

| Worker 設定 | 類型 | 填寫內容 |
| --- | --- | --- |
| `FORUM_ORIGIN` | 文字 | 論壇完整 HTTPS 來源，例如 `https://forum.example.org` |
| `ZLIBRARY_ORIGIN` | 文字 | 書庫服務方授權使用且可直接登入 EAPI 的 HTTPS 來源 |
| `ZLIBRARY_EMAIL` | Secret | 此次安裝使用的書庫帳號電子郵件 |
| `ZLIBRARY_PASSWORD` | Secret | 書庫帳號密碼 |
| `SELECTION_SECRET` | Secret | 新產生的隨機密鑰。可用密碼管理器產生 48 個隨機英數字元 |
| `ZLIBRARY_FILE_HOSTS` | 選填文字 | 若書檔使用獨立 CDN，填入供應方確認的下載主機名稱，多個用英文逗號分隔 |

上游一般帳號條款限制自動使用及多人共用。營運論壇的帳號需有服務方授予的相應權限。[上游使用條款](https://zlib.bz/tos)

## 下載與維護

服務每次向論壇的 `/session/current.json` 核對會員身分。選書憑證綁定會員與站點，有效 20 分鐘。搜尋及選版不會取檔，按下載才使用上游下載介面。檔案經 Worker 串流傳回論壇。單檔上限 128 MiB，iOS Discourse Hub 的上限為 25 MiB。帳號或檔案網域設定不全、服務方要求驗證及下載額度用盡時，會員會看到對應訊息。

更新元件可在論壇後台點「檢查更新」。要移除入口，清空 `book_service_path` 或解除元件與主題的關聯。要停用整項服務，再從 Cloudflare 移除該路由。

協定依據 [heartleo/zlib v0.0.16](https://github.com/heartleo/zlib/tree/v0.0.16/internal/zlib)。在倉庫根目錄執行 `node --test test/worker.test.mjs` 可重跑服務測試。GitHub Actions 在隔離的 Discourse 環境匯入元件，以瀏覽器驗證會員搜尋、選版及儲存檔案。[測試紀錄](https://github.com/ieduer/discourse-zlibrary/actions)
