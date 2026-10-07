import assert from "node:assert/strict";
import test from "node:test";
import { parseLine } from "../src/nmea";
import { StoredLine, buildPairs } from "../src/pairing";
import { checksum } from "../src/nmea";

function s(body: string): string {
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, "0")}`;
}

let nextId = 1;
function line(raw: string, source: string, utcDate?: string, lineNo = nextId++): StoredLine {
  const parsed = parseLine(raw, utcDate);
  return { id: lineNo, lineNo, raw, source, date: parsed.date ?? "", parsed };
}

const GGA = "GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,";
const RMC = "GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W";

test("同秒配对成功且坐标一致", () => {
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(RMC), "A"),
  ], 1e-4);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, "PAIRED_VALID");
  assert.equal(pairs[0].coordConsistent, true);
});

test("不同来源与不同日期绝不串用", () => {
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(RMC), "B"),
    line(s("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,240394,003.1,W"), "A"),
  ], 1e-4);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every((p) => p.status === "UNPAIRED"));
});

test("完全相同原句去重并计数", () => {
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(GGA), "A", "1994-03-23"),
    line(s(RMC), "A"),
  ], 1e-4);
  assert.equal(pairs[0].status, "PAIRED_VALID");
  const g = pairs[0].gga as { count: number };
  assert.equal(g.count, 2);
});

test("同键同类型不同原句 => 冲突", () => {
  const gga2 = "GPGGA,123519,4807.039,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,";
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(gga2), "A", "1994-03-23"),
    line(s(RMC), "A"),
  ], 1e-4);
  assert.equal(pairs[0].status, "CONFLICT");
});

test("坐标不一致 => PAIRED_COORD_MISMATCH，保留两份坐标", () => {
  const rmcFar = "GPRMC,123519,A,4807.500,N,01131.000,E,022.4,084.4,230394,003.1,W";
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(rmcFar), "A"),
  ], 1e-4);
  assert.equal(pairs[0].status, "PAIRED_COORD_MISMATCH");
  const g = pairs[0].gga as { sentence: { lat: number } };
  const r = pairs[0].rmc as { sentence: { lat: number } };
  assert.equal(g.sentence.lat, 48.1173);
  assert.equal(r.sentence.lat, 48.125);
});

test("无效定位配对 => PAIRED_INVALID_FIX", () => {
  const rmcV = "GPRMC,123519,V,,,,,,,230394,,,N";
  const pairs = buildPairs([
    line(s(GGA), "A", "1994-03-23"),
    line(s(rmcV), "A"),
  ], 1e-4);
  assert.equal(pairs[0].status, "PAIRED_INVALID_FIX");
});

test("日志顺序变化分组结论不变", () => {
  const rmcFar = "GPRMC,123519,A,4807.500,N,01131.000,E,022.4,084.4,230394,003.1,W";
  const a = [
    line(s(GGA), "A", "1994-03-23"),
    line(s(RMC), "A"),
    line(s(rmcFar), "B"),
    line(s(GGA), "B", "1994-03-23"),
  ];
  const b = [...a].reverse();
  assert.deepEqual(buildPairs(a, 1e-4), buildPairs(b, 1e-4));
});

test("跨午夜：不同日期导入不配对", () => {
  const ggaLate = "GPGGA,235959,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,";
  const rmcEarly = "GPRMC,000000,A,4807.038,N,01131.000,E,022.4,084.4,240394,003.1,W";
  const pairs = buildPairs([
    line(s(ggaLate), "A", "1994-03-23"),
    line(s(rmcEarly), "A"),
  ], 1e-4);
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every((p) => p.status === "UNPAIRED"));
});
