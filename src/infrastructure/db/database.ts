/**
 * `node:sqlite` 的開檔與 migration。
 *
 * **零原生模組** —— 不引 `better-sqlite3`、不引 `sqlite3`、不引 `sqlite-vec`。
 * 引了就需要編譯工具鏈，而一鍵啟動就沒了（ADR-0002、ADR-0009）。
 */
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

/** 這一版程式認得的 schema 版本。**比資料庫的版本小就代表資料庫被新版寫過。** */
export const SUPPORTED_SCHEMA_VERSION = 9;

export type OpenOutcome =
  | { readonly kind: 'ok'; readonly db: DatabaseSync }
  /**
   * **檔案不存在，而且這一次不是要建立它。**
   *
   * 在這個成員出現之前，兩種情況各有一種壞法：
   *
   * - 資料夾不在 → `new DatabaseSync()` 直接丟例外，呼叫端走不到任何一個分支，
   *   使用者看到 `IO_UNEXPECTED`（500）—— 而我們其實完全知道發生了什麼事
   * - **資料夾在、檔案不在 → 它會悄悄建一個新的空資料庫**，跑完 migration，
   *   然後 `readCase()` 回 null。畫面上答對了（`CASE_NOT_FOUND`），
   *   **資料根裡卻多了一個沒有人要的 `case.sqlite`**。
   *   `historyByHost()`（來源清單的狀態彙整）逐一打開 `cases\` 底下每個資料夾，
   *   所以一個殘留的空資料夾會在每一次打開「來源網站」分頁時被寫進一個檔案 ——
   *   從一個唯讀的畫面裡。
   *
   * 所以預設**不建檔**，要建的那一條（建立專題）明確說 `create: true`。
   */
  | { readonly kind: 'missing' }
  /** 資料庫的 schema 比這個程式新 —— **不要用舊版繼續開，會寫壞資料** */
  | { readonly kind: 'schema-too-new'; readonly found: number; readonly supported: number }
  | { readonly kind: 'migrate-failed'; readonly at: string; readonly reason: string };

export interface OpenOptions {
  /**
   * migration 之前把複本放這裡（`<資料根>\backups\`）。
   *
   * **不給就不備份** —— 新建的專題不需要（它從 0 直接建到最新版，
   * 沒有任何東西可以失去）。
   */
  readonly backupDir?: string | undefined;
  /** 備份檔名的前綴，用專題 slug。 */
  readonly backupLabel?: string | undefined;
  /**
   * **檔案不存在時建一個新的。** 預設 `false` —— 只有建立專題那一條該是 `true`。
   *
   * 反過來的預設（「預設會建，要擋的人自己說」）會讓每一個新呼叫端都繼承那個副作用，
   * 而它沒有症狀：多出來的只是一個空的 `case.sqlite`。
   */
  readonly create?: boolean | undefined;
}

async function migrationFiles(): Promise<string[]> {
  const names = await readdir(MIGRATIONS_DIR);
  return names.filter((n) => n.endsWith('.sql')).sort();
}

/**
 * 開一個專題資料庫，需要時跑 migration。
 *
 * `PRAGMA user_version` 當版本號 —— 不另外開一張 `schema_version` 表：
 * 那張表本身也需要一個 migration 才能存在，是先有雞還是先有蛋。
 */
export async function openCaseDatabase(
  path: string,
  options: OpenOptions & { readonly create: true },
): Promise<Exclude<OpenOutcome, { kind: 'missing' }>>;
export async function openCaseDatabase(path: string, options?: OpenOptions): Promise<OpenOutcome>;
/**
 * 兩個重載把一個不變式交給編譯器：**`create: true` 不會回 `missing`**。
 * 沒有這一層的話，建立專題那一條得寫一個永遠走不到的分支，
 * 而一個走不到的分支遲早會被人填進一句錯的訊息。
 */
export async function openCaseDatabase(
  path: string,
  options: OpenOptions = {},
): Promise<OpenOutcome> {
  if (options.create !== true) {
    try {
      await access(path);
    } catch {
      return { kind: 'missing' };
    }
  }

  const db = new DatabaseSync(path);

  // WAL：讀寫不互相擋。這也是「單一實例只是體驗、不是資料保證」的那條依據
  // （ADR-0020）—— 真正守資料完整性的是 WAL 與交易，不是那條規則。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = row?.user_version ?? 0;

  if (current > SUPPORTED_SCHEMA_VERSION) {
    db.close();
    return { kind: 'schema-too-new', found: current, supported: SUPPORTED_SCHEMA_VERSION };
  }

  if (current < SUPPORTED_SCHEMA_VERSION) {
    // **既有資料庫在 migration 之前先留一份複本**（storage-layout 的 `backups\`）。
    //
    // 用 `VACUUM INTO` 而不是複製檔案：WAL 模式下 `.sqlite` 那一個檔案
    // **不包含還在 `-wal` 裡的交易**，複製它會得到一份少了最後幾筆的資料庫。
    // `VACUUM INTO` 是從這條連線產生的，看得到完整狀態。
    if (current > 0 && options.backupDir !== undefined) {
      try {
        await mkdir(options.backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `${options.backupLabel ?? 'case'}-v${current}-${stamp}.sqlite`;
        db.prepare('VACUUM INTO ?').run(join(options.backupDir, name));
      } catch (e) {
        // **備份失敗就不要 migrate。** 沒有退路的 migration 是這個專案
        // 最不該自己給自己製造的風險。
        db.close();
        return { kind: 'migrate-failed', at: 'backup', reason: String((e as Error).message) };
      }
    }

    const files = await migrationFiles();
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      if (version <= current) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        // **整份 migration 包在一個交易裡。**
        // 中途失敗要回到 migration 前的狀態，而不是留下半套 schema。
        db.exec('BEGIN');
        db.exec(sql);
        db.exec(`PRAGMA user_version = ${version}`);
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ROLLBACK 自己失敗的話沒有更好的辦法了 —— 讓下面的訊息帶著原因出去
        }
        db.close();
        return { kind: 'migrate-failed', at: file, reason: String((e as Error).message) };
      }
    }
  }

  return { kind: 'ok', db };
}

/**
 * 把一組寫入包成一個交易。
 *
 * **v0.4.0 之前不需要這一支** —— 在那之前每個寫入都是單一敘述，
 * 而單一敘述本來就是原子的。裁決不是：建立一條已確認的機器邊要
 * 「INSERT 成待查證 → 寫出處 → UPDATE 成已確認」**三步**
 * （`edge-repo.ts` 解釋了為什麼順序只有這一種），
 * 而中途斷掉會留下一條**看起來還在等人裁決、實際上出處已經齊了**的邊。
 *
 * 用 `BEGIN IMMEDIATE` 而不是 `BEGIN`：後者要等到第一次寫入才拿鎖，
 * 於是「讀完現況 → 依現況決定寫什麼」中間有一個空隙。
 * 墓碑檢查整個就是那個形狀（先查有沒有墓碑，再決定寫不寫），
 * 所以那個空隙正好會讓墓碑失效。
 */
export function withTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = body();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ROLLBACK 自己失敗時沒有更好的辦法 —— 讓原本的例外帶著原因往上走
    }
    throw e;
  }
}

export type { DatabaseSync };
