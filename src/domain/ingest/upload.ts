/**
 * 使用者拖進來的檔案，一個最大多少（2026-10-02）。
 *
 * 原本只有整個 server 的 `bodyLimit`（32 MB），超過時 Fastify 自己丟錯，落到 `IO_UNEXPECTED`
 * （「請把識別碼交出來」）—— 而一份印成圖的 PDF 輕易就是 60–90 MB。上傳是**一次讀進記憶體**
 * （`application/octet-stream`，沒有 multipart），所以上限仍然要有；256 MB 是「一份很大的掃描書」
 * 還放得下、而一台普通的電腦讀進記憶體不會出事的量。
 *
 * **它跟擷取的 `MAX_BYTES`（25 MB，`fetcher.ts`）是兩件事**：那個管的是從網路上抓一份，
 * 這個管的是使用者自己給的 —— 使用者給的東西不該被一個為了網路而設的上限擋掉。
 */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** 這個大小超過上傳上限嗎。不知道大小（`null`）的一律先收，由 server 的 `bodyLimit` 當最後一道。 */
export function exceedsUploadLimit(size: number | null): boolean {
  return size !== null && Number.isFinite(size) && size > MAX_UPLOAD_BYTES;
}
