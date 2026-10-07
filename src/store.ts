import { DatabaseSync } from "node:sqlite";
import {
  Diagnostic, MAX_LINES_PER_IMPORT, ParsedSentence, RULES_VERSION, isValidUtcDate, parseLine,
} from "./nmea";
import { PairRecord, StoredLine, buildPairs } from "./pairing";

export class ApiError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

export interface ImportResult {
  importId: number;
  requestId: string;
  duplicate: boolean;
  total: number;
  ok: number;
  failed: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        request_id TEXT NOT NULL,
        source TEXT NOT NULL,
        utc_date TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (dataset_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL,
        import_id INTEGER NOT NULL REFERENCES imports(id),
        line_no INTEGER NOT NULL,
        raw TEXT NOT NULL,
        ok INTEGER NOT NULL,
        diagnostics TEXT NOT NULL,
        parsed TEXT,
        type TEXT,
        source TEXT,
        date TEXT,
        second_of_day INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_lines_dataset ON lines(dataset_id);
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL,
        tolerance_deg REAL NOT NULL,
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('rules_version', ?)")
      .run(RULES_VERSION);
  }

  close(): void {
    this.db.close();
  }

  get rulesVersion(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='rules_version'").get() as { value: string };
    return row.value;
  }

  createDataset(name: string): { id: number; name: string } {
    if (!name || typeof name !== "string") throw new ApiError("BAD_NAME", "数据集名称不能为空");
    const info = this.db
      .prepare("INSERT INTO datasets(name, created_at) VALUES (?, ?)")
      .run(name, new Date().toISOString());
    return { id: Number(info.lastInsertRowid), name };
  }

  listDatasets(): unknown[] {
    return this.db.prepare("SELECT id, name, created_at AS createdAt FROM datasets ORDER BY id").all();
  }

  private requireDataset(id: number): void {
    const row = this.db.prepare("SELECT id FROM datasets WHERE id = ?").get(id);
    if (!row) throw new ApiError("DATASET_NOT_FOUND", `数据集不存在: ${id}`, 404);
  }

  /**
   * 导入文本。整体结构非法（参数错误、超上限、行尾非法）=> 全部拒绝；
   * 结构合法时逐行解析，坏行作为诊断保留。requestId 幂等。
   */
  importText(
    datasetId: number,
    opts: { requestId: string; source: string; utcDate?: string; text: string },
  ): ImportResult {
    this.requireDataset(datasetId);
    const { requestId, source, utcDate, text } = opts;
    if (!requestId || typeof requestId !== "string") {
      throw new ApiError("BAD_REQUEST_ID", "缺少请求号 requestId");
    }
    if (!source || typeof source !== "string") {
      throw new ApiError("BAD_SOURCE", "缺少来源 source（不从 talker 标记推断）");
    }
    if (utcDate !== undefined && !isValidUtcDate(utcDate)) {
      throw new ApiError("BAD_DATE", `utcDate 非法: '${utcDate}'，应为真实存在的 YYYY-MM-DD`);
    }
    if (typeof text !== "string") {
      throw new ApiError("BAD_TEXT", "text 必须为字符串");
    }
    if (utcDate === undefined && /\$..GGA/.test(text)) {
      throw new ApiError("BAD_DATE", "批次含 GGA 语句，必须显式提供 utcDate (YYYY-MM-DD)");
    }

    const dup = this.db
      .prepare("SELECT id FROM imports WHERE dataset_id = ? AND request_id = ?")
      .get(datasetId, requestId) as { id: number } | undefined;
    if (dup) {
      const stats = this.statsForImport(dup.id);
      return { importId: dup.id, requestId, duplicate: true, ...stats };
    }

    // 行尾校验：只允许 CRLF 或 LF；孤立的 \r 拒绝整批
    if (/\r(?!\n)/.test(text)) {
      throw new ApiError("BAD_LINE_ENDING", "存在孤立的 CR，仅允许 CRLF 或 LF 行尾");
    }
    const rawLines = text.replace(/\r\n/g, "\n").split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    if (rawLines.length === 0) throw new ApiError("EMPTY_BATCH", "导入内容为空");
    if (rawLines.length > MAX_LINES_PER_IMPORT) {
      throw new ApiError("TOO_MANY_LINES", `行数超过上限 ${MAX_LINES_PER_IMPORT}`);
    }

    const insImport = this.db.prepare(
      "INSERT INTO imports(dataset_id, request_id, source, utc_date, created_at) VALUES (?,?,?,?,?)",
    );
    const insLine = this.db.prepare(
      `INSERT INTO lines(dataset_id, import_id, line_no, raw, ok, diagnostics, parsed, type, source, date, second_of_day)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );

    let ok = 0, failed = 0;
    this.db.exec("BEGIN");
    try {
      const info = insImport.run(datasetId, requestId, source, utcDate ?? null, new Date().toISOString());
      const importId = Number(info.lastInsertRowid);
      rawLines.forEach((raw, idx) => {
        const parsed: ParsedSentence = parseLine(raw, utcDate);
        const date = parsed.ok ? parsed.date! : null;
        insLine.run(
          datasetId, importId, idx + 1, raw, parsed.ok ? 1 : 0,
          JSON.stringify(parsed.diagnostics),
          parsed.ok ? JSON.stringify(parsed) : null,
          parsed.ok ? parsed.type! : null,
          source, date,
          parsed.ok ? parsed.secondOfDay! : null,
        );
        if (parsed.ok) ok++; else failed++;
      });
      this.db.exec("COMMIT");
      return { importId, requestId, duplicate: false, total: rawLines.length, ok, failed };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private statsForImport(importId: number): { total: number; ok: number; failed: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(ok) AS ok FROM lines WHERE import_id = ?")
      .get(importId) as { total: number; ok: number };
    return { total: row.total, ok: row.ok ?? 0, failed: row.total - (row.ok ?? 0) };
  }

  listLines(datasetId: number): Array<{
    id: number; lineNo: number; raw: string; ok: boolean;
    diagnostics: Diagnostic[]; parsed: ParsedSentence | null; source: string;
  }> {
    this.requireDataset(datasetId);
    const rows = this.db
      .prepare(
        `SELECT l.id, l.line_no AS lineNo, l.raw, l.ok, l.diagnostics, l.parsed, i.source
         FROM lines l JOIN imports i ON i.id = l.import_id
         WHERE l.dataset_id = ? ORDER BY l.id`,
      )
      .all(datasetId) as unknown as Array<{
        id: number; lineNo: number; raw: string; ok: number;
        diagnostics: string; parsed: string | null; source: string;
      }>;
    return rows.map((r) => ({
      id: r.id, lineNo: r.lineNo, raw: r.raw, ok: r.ok === 1,
      diagnostics: JSON.parse(r.diagnostics),
      parsed: r.parsed ? JSON.parse(r.parsed) : null,
      source: r.source,
    }));
  }

  private storedLines(datasetId: number): StoredLine[] {
    return this.listLines(datasetId)
      .filter((l) => l.ok && l.parsed)
      .map((l) => ({
        id: l.id, lineNo: l.lineNo, raw: l.raw, source: l.source,
        date: l.parsed!.date!, parsed: l.parsed!,
      }));
  }

  /** 生成并冻结一份报告（可配置角度容差，单位：度）。 */
  createReport(datasetId: number, toleranceDeg: number): { id: number; pairs: PairRecord[] } {
    this.requireDataset(datasetId);
    if (!Number.isFinite(toleranceDeg) || toleranceDeg < 0 || toleranceDeg > 1) {
      throw new ApiError("BAD_TOLERANCE", "容差必须为 [0, 1] 区间内的度数");
    }
    const pairs = buildPairs(this.storedLines(datasetId), toleranceDeg);
    const info = this.db
      .prepare(
        "INSERT INTO reports(dataset_id, tolerance_deg, rules_version, created_at, result) VALUES (?,?,?,?,?)",
      )
      .run(datasetId, toleranceDeg, RULES_VERSION, new Date().toISOString(), JSON.stringify(pairs));
    return { id: Number(info.lastInsertRowid), pairs };
  }

  getReport(reportId: number): { id: number; datasetId: number; toleranceDeg: number; rulesVersion: string; createdAt: string; pairs: PairRecord[] } {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE id = ?")
      .get(reportId) as { id: number; dataset_id: number; tolerance_deg: number; rules_version: string; created_at: string; result: string } | undefined;
    if (!row) throw new ApiError("REPORT_NOT_FOUND", `报告不存在: ${reportId}`, 404);
    return {
      id: row.id, datasetId: row.dataset_id, toleranceDeg: row.tolerance_deg,
      rulesVersion: row.rules_version, createdAt: row.created_at,
      pairs: JSON.parse(row.result),
    };
  }

  /** 查询配对（不落库，使用给定或默认容差）。 */
  queryPairs(datasetId: number, toleranceDeg = 1e-4, filters: { source?: string; date?: string; second?: number } = {}): PairRecord[] {
    let pairs = buildPairs(this.storedLines(datasetId), toleranceDeg);
    if (filters.source) pairs = pairs.filter((p) => p.source === filters.source);
    if (filters.date) pairs = pairs.filter((p) => p.date === filters.date);
    if (filters.second !== undefined) pairs = pairs.filter((p) => p.secondOfDay === filters.second);
    return pairs;
  }
}
