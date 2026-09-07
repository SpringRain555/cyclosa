/**
 * `node:sqlite` 的開檔與 migration。
 *
 * **零原生模組** —— 不引 `better-sqlite3`、不引 `sqlite3`、不引 `sqlite-vec`。
 * 引了就需要編譯工具鏈，而一鍵啟動就沒了（ADR-0002、ADR-0009）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

/** 這一版程式認得的 schema 版本。**比資料庫的版本小就代表資料庫被新版寫過。** */
export const SUPPORTED_SCHEMA_VERSION = 1;

export type OpenOutcome =
  | { readonly kind: 'ok'; readonly db: DatabaseSync }
  /** 資料庫的 schema 比這個程式新 —— **不要用舊版繼續開，會寫壞資料** */
  | { readonly kind: 'schema-too-new'; readonly found: number; readonly supported: number }
  | { readonly kind: 'migrate-failed'; readonly at: string; readonly reason: string };

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
export async function openCaseDatabase(path: string): Promise<OpenOutcome> {
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

export type { DatabaseSync };
