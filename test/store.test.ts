import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checksum } from "../src/nmea";
import { Store } from "../src/store";

function s(body: string): string {
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, "0")}`;
}

const GGA = s("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,");
const RMC = s("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W");

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmea-")), "t.db");
}

test("请求号幂等：重复导入不重复计数", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("t");
  const text = [GGA, RMC].join("\n") + "\n";
  const r1 = store.importText(ds.id, { requestId: "r1", source: "A", utcDate: "1994-03-23", text });
  const r2 = store.importText(ds.id, { requestId: "r1", source: "A", utcDate: "1994-03-23", text });
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(store.listLines(ds.id).length, 2);
  store.close();
});

test("非法整批结构拒绝且不写半份；合法批次坏行逐行保留", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("t");
  assert.throws(() => store.importText(ds.id, {
    requestId: "x", source: "A", utcDate: "1994-03-23", text: `${GGA}\rbad`,
  }), /CR/);
  assert.throws(() => store.importText(ds.id, {
    requestId: "x2", source: "A", text: GGA,
  }), /utcDate/);
  assert.equal(store.listLines(ds.id).length, 0);
  const r = store.importText(ds.id, {
    requestId: "ok", source: "A", utcDate: "1994-03-23",
    text: [GGA, "$BROKEN,,,", RMC].join("\n"),
  });
  assert.equal(r.total, 3);
  assert.equal(r.ok, 2);
  assert.equal(r.failed, 1);
  const lines = store.listLines(ds.id);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].raw, "$BROKEN,,,");
  assert.equal(lines[1].lineNo, 2);
  store.close();
});

test("重启后仍能查询原始诊断与冻结报告", () => {
  const db = tmpDb();
  let store = new Store(db);
  const ds = store.createDataset("t");
  store.importText(ds.id, {
    requestId: "r", source: "A", utcDate: "1994-03-23",
    text: [GGA, "$BROKEN,,,", RMC].join("\r\n"),
  });
  const report = store.createReport(ds.id, 1e-4);
  store.close();

  store = new Store(db);
  const lines = store.listLines(ds.id);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].diagnostics[0].code, "MISSING_STAR");
  const frozen = store.getReport(report.id);
  assert.equal(frozen.pairs.length, 1);
  assert.equal(frozen.pairs[0].status, "PAIRED_VALID");
  assert.equal(frozen.rulesVersion, store.rulesVersion);
  store.close();
});

test("容差影响配对结论", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("t");
  const rmcNear = s("GPRMC,123519,A,4807.039,N,01131.000,E,022.4,084.4,230394,003.1,W");
  store.importText(ds.id, {
    requestId: "r", source: "A", utcDate: "1994-03-23", text: [GGA, rmcNear].join("\n"),
  });
  assert.equal(store.queryPairs(ds.id, 1e-6)[0].status, "PAIRED_COORD_MISMATCH");
  assert.equal(store.queryPairs(ds.id, 0.001)[0].status, "PAIRED_VALID");
  store.close();
});
