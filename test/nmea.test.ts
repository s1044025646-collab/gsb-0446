import assert from "node:assert/strict";
import test from "node:test";
import { checksum, parseDate, parseLine } from "../src/nmea";

// 独立校验和样例（来自 NMEA 0183 公开文档的经典例句，非本项目生成）
const GGA_DOC = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";
const RMC_DOC = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A";

test("校验和：逐字节异或独立样例", () => {
  const body = "GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,";
  // 手工逐步异或核对：用 Buffer 独立实现
  let expected = 0;
  for (const b of Buffer.from(body, "ascii")) expected ^= b;
  assert.equal(checksum(body), expected);
  assert.equal(expected, 0x47);
  assert.ok(parseLine(GGA_DOC, "1994-03-23").ok);
  assert.ok(parseLine(RMC_DOC).ok);
});

test("校验和接受小写十六进制", () => {
  assert.ok(parseLine(GGA_DOC.replace("*47", "*47".toLowerCase()), "1994-03-23").ok);
  assert.ok(parseLine(RMC_DOC.replace("*6A", "*6a")).ok);
});

test("演示坐标换算", () => {
  const p = parseLine(GGA_DOC, "1994-03-23");
  assert.equal(p.lat, 48.1173);
  assert.ok(Math.abs(p.lon! - 11.5166667) < 1e-7);
});

test("坏校验和 / 缺星号 / 坏校验字符 / 非 ASCII / 未知类型 / 字段不足", () => {
  assert.equal(parseLine(GGA_DOC.replace("*47", "*48"), "1994-03-23").diagnostics[0].code, "CHECKSUM_MISMATCH");
  assert.equal(parseLine("$GPGGA,123519", "1994-03-23").diagnostics[0].code, "MISSING_STAR");
  assert.equal(parseLine(GGA_DOC.replace("*47", "*4Z"), "1994-03-23").diagnostics[0].code, "BAD_CHECKSUM_CHAR");
  assert.equal(parseLine(GGA_DOC.replace("N", "北"), "1994-03-23").diagnostics[0].code, "NON_ASCII");
  assert.equal(parseLine("$GPVTG,054.7,T,034.4,M,005.5,N,010.2,K*48").diagnostics[0].code, "UNKNOWN_TYPE");
  assert.equal(parseLine("$GPGGA,123519,4807.038*45", "1994-03-23").diagnostics[0].code, "INSUFFICIENT_FIELDS");
});

test("空字段：无效定位可空坐标，有效定位缺坐标报不一致", () => {
  const invalid = parseLine("$GPRMC,123519,V,,,,,,,230394,,,N*51");
  assert.ok(invalid.ok);
  assert.equal(invalid.fixValid, false);
  assert.equal(invalid.lat, null);
  const bad = parseLine("$GPRMC,123519,A,,,,,,,230394,,,N*46");
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === "INCONSISTENT"));
});

test("GGA 质量 0 表示无效", () => {
  const p = parseLine("$GPGGA,123519,4807.038,N,01131.000,E,0,00,,,M,,M,,*52", "1994-03-23");
  assert.ok(p.ok);
  assert.equal(p.fixValid, false);
});

test("度分误读防护：分钟>=60、极值非零分钟、位数不足", () => {
  const mk = (lat: string) =>
    parseLine(`$GPRMC,123519,A,${lat},N,01131.000,E,022.4,084.4,230394,003.1,W*00`.replace("*00",
      "*" + (() => { let c = 0; const b = `GPRMC,123519,A,${lat},N,01131.000,E,022.4,084.4,230394,003.1,W`; for (const ch of b) c ^= ch.charCodeAt(0); return c.toString(16).toUpperCase().padStart(2, "0"); })()));
  assert.ok(mk("4860.000").diagnostics.some((d) => d.code === "BAD_COORD"));
  assert.ok(mk("9000.001").diagnostics.some((d) => d.code === "BAD_COORD"));
  assert.ok(mk("48.0").diagnostics.some((d) => d.code === "BAD_COORD"));
  assert.ok(mk("9000.000").ok);
});

test("世纪边界与非法日期、闰秒", () => {
  const diags: import("../src/nmea").Diagnostic[] = [];
  assert.equal(parseDate("010180", diags), "1980-01-01");
  assert.equal(parseDate("010179", diags), "2079-01-01");
  assert.equal(parseDate("311299", diags), "1999-12-31");
  assert.equal(parseDate("010100", diags), "2000-01-01");
  assert.equal(parseDate("290299", diags), null); // 1999 非闰年
  assert.equal(parseDate("290200", diags), "2000-02-29");
  const leap = parseLine("$GPRMC,235960,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6C");
  assert.ok(leap.diagnostics.some((d) => d.code === "LEAP_SECOND"));
});

test("GGA 缺显式日期报错；RMC 自带日期", () => {
  assert.ok(parseLine(GGA_DOC).diagnostics.some((d) => d.code === "MISSING_DATE"));
  assert.equal(parseLine(RMC_DOC).date, "1994-03-23");
});

test("小数秒保留展示、整数秒作键", () => {
  const p = parseLine("$GPRMC,123519.75,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*46");
  assert.ok(p.ok);
  assert.equal(p.secondOfDay, 12 * 3600 + 35 * 60 + 19);
  assert.equal(p.timeFraction, ".75");
});

test("RMC 速度节换算米每秒", () => {
  const p = parseLine(RMC_DOC);
  assert.equal(p.speedKnots, 22.4);
  assert.ok(Math.abs(p.speedMps! - 22.4 * 0.514444) < 1e-6);
});
