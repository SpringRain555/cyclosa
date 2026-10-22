# ADR-0038 擷取管線不連本機與區網；路徑參數不得帶出資料夾

- 狀態：**已採納**（2026-10-22，未發行）
- 依據：2026-10-22 開 GitHub CodeQL 之後的安全盤點 —— `js/request-forgery`（`fetcher.ts`）與 35 筆 `js/path-injection`，逐筆判讀後留下的兩件真問題
- 補充：ADR-0036（只收自己的頁面送來的請求）—— 那一份擋**進來**的請求，這一份擋爬蟲**送出去**的
- 實作：`src/domain/ingest/address.ts`、`src/infrastructure/fetch/crawler.ts`、`src/application/fetch-policy.ts`、`src/interface/http/param-guard.ts`；
  測試 `tests/domain/address.test.ts`、`tests/infrastructure/crawler-private-address.test.ts`、`tests/interface/param-guard.test.ts`

## 背景

### 一、爬蟲會替外部網頁敲本機

擷取管線抓的網址有三個來源：使用者貼的、找來源的模型交回的、對方伺服器的**轉址**。後兩者都是外部文字決定的。
`fetchOnce` 手動跟轉址（為了每一跳都查 robots 與節流），**但從來沒問過下一跳要去哪裡**：

- 一個網頁回 `302 Location: http://127.0.0.1:7433/api/...` → 爬蟲替它讀 Cyclosa 自己的 API，回應存成快照、送進模型
- 轉到 `http://192.168.1.1/...` → 讀區網裡路由器、NAS 的管理頁（有些舊設備的 GET 會改設定）
- 提示注入讓找來源的模型交回這種網址，效果一樣

ADR-0036 的請求守門擋不到這條：爬蟲送出的請求 `Host` 就是 `127.0.0.1`，方法是 GET。
設定檔不存金鑰的值（只存環境變數名），所以最壞的情況是**專題內容與本機服務的回應被讀進快照與模型**，不是金鑰外洩。

### 二、`:slug` 沒驗就接成路徑

`isUsableSlug` 只在建立與改名時問。Fastify 會把參數裡的 `%2F` 解碼成 `/`，所以
`/api/cases/..%2F..%2Fx/runs` 拿到的 slug 是 `../../x`，接著被 `join(casesDir, slug)` 接成資料夾。
**目前走不出去**：開專題資料庫之前先看 `case.sqlite` 在不在、不會新建。但這個「剛好」沒有寫在任何地方，
下一個接上檔案路徑的端點就不一定了。各種 `:itemId` 也一樣，被接成 `derived/<itemId>.v<n>.json`。

## 決定

### 一、每一跳送出之前，主機名解析出來的**每一個**位址都必須是公開位址

- 放在 `Crawler` 的 gate 裡、**robots 之前**（robots.txt 本身也是送往那台主機的請求）。轉址的每一跳都會經過
- 用 `dns.lookup(host, { all: true })` —— 跟 `fetch` 連線時用的是同一個解析器；**任何一筆**不是公開位址就擋
- 擋下來回 `FETCH_PRIVATE_ADDRESS`（partial），`detail` 帶 `host`、`scope`、`address`，**沒有送任何請求**
- 非公開的定義在 `domain/ingest/address.ts`：loopback、RFC 1918、link-local（含 169.254.169.254）、CGNAT、
  unique local、multicast、保留段；**IPv4 包在 IPv6 裡（`::ffff:127.0.0.1`、NAT64）照裡面的 IPv4 判**；認不得的字面值不放行
- 解析失敗不在這裡擋，照原本的路回 `FETCH_DNS`

**預設不准，`CYCLOSA_FETCH_ALLOW_PRIVATE=1` 放行**。跟同網域間隔一樣是「這台機器上的決定」，所以用環境變數不用設定頁。
使用者自己貼的區網網址也一樣被擋 —— 分辨不出「使用者貼的」與「轉址到的」的時候，偏向擋；要抓自己 NAS 上的東西就設那個變數，或自己下載後用檔案匯入。

### 二、路徑參數在進路由之前驗過（`preValidation`）

- `slug` 必須過 `isUsableSlug`（跟建立專題同一條），否則回 `CASE_NOT_FOUND`（`correlationId: 'bad-slug'`）
- 其他參數不得含 `/`、`\`、NUL，也不得是 `.`／`..`，否則 404。**只擋路徑字元、不驗格式** —— id 有 UUID 也有別的形狀

## 考慮過、沒有選的

| 選項 | 為什麼沒選 |
|---|---|
| **把解析結果釘進連線**（自訂 `undici` dispatcher 的 `lookup`）| 連「檢查與連線之間 DNS 換答案」的 rebinding 也擋得住，但要把 `undici` 列成相依、`fetchOnce` 改走它。先擋住不需要控制 DNS 的那一大類（轉址、模型交回的字面位址）；釘連線列在「什麼情況要重新考慮」 |
| **只擋轉址，不擋第一跳** | 模型交回的網址也是外部文字決定的；而且要把「誰給的網址」一路傳進 `Crawler`，多一個會傳錯的參數 |
| **白名單只准 `https:`** | 很多學術與政府網站仍有 http；而 https 不改變「連到哪裡」 |
| **每個 service 各自驗 slug** | 六十幾條路由，漏一條就是一個洞；守門放在一個地方，新路由自動被保護 |

## 代價

- **TOCTOU**：這裡解析一次、`fetch` 連線時再解析一次，TTL 極短的 DNS rebinding 可以在兩次之間換答案。要做到這一步得控制一個網域的 DNS
- **區網裡的網頁預設抓不到**，包括使用者自己貼的
- e2e 的假網站在 `127.0.0.1`，所以 `vitest.config.ts` 設了 `CYCLOSA_FETCH_ALLOW_PRIVATE=1`；擋的那一條由直接建 `Crawler` 的測試驗

## 什麼情況要重新考慮

- 引進 `undici`（或 Node 提供 `fetch` 的 `lookup` 選項）→ 把解析結果釘進連線，關掉 TOCTOU
- 使用者常常要抓區網內容 → 改成「使用者貼的第一跳可以放行、轉址與模型交回的一律擋」，那時要把來源一路傳進 `Crawler`
