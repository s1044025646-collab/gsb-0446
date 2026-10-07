/** NMEA 0183 严格解析：仅支持 GGA 与 RMC。规则版本变更需递增。 */
export const RULES_VERSION = "1.0.0";

/** 节 -> 米/秒 换算常数（1 节 = 1852 m / 3600 s，取常用六位有效数字） */
export const KNOT_TO_MPS = 0.514444;

export const MAX_LINE_LEN = 512;
export const MAX_LINES_PER_IMPORT = 100000;
export const COORD_DECIMALS = 7;

export interface Diagnostic {
  code: string;
  message: string;
}

export interface ParsedSentence {
  ok: boolean;
  diagnostics: Diagnostic[];
  type?: "GGA" | "RMC";
  timeRaw?: string;
  secondOfDay?: number;
  timeFraction?: string;
  lat?: number | null;
  lon?: number | null;
  fixValid?: boolean;
  quality?: number;
  numSats?: number | null;
  hdop?: number | null;
  status?: string;
  speedKnots?: number | null;
  speedMps?: number | null;
  date?: string;
}

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

export function roundCoord(v: number): number {
  const f = Math.pow(10, COORD_DECIMALS);
  return Math.round(v * f) / f;
}

/** 校验和：'$' 之后、'*' 之前所有 ASCII 字节逐字节异或（含逗号）。 */
export function checksum(body: string): number {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs;
}

function parseTime(raw: string, diags: Diagnostic[]):
  { secondOfDay: number; fraction: string } | null {
  const m = /^(\d{2})(\d{2})(\d{2})(\.\d+)?$/.exec(raw);
  if (!m) {
    diags.push(diag("BAD_TIME", `时间格式非法: '${raw}'，应为 hhmmss[.fff]`));
    return null;
  }
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
  if (hh > 23 || mm > 59) {
    diags.push(diag("BAD_TIME", `时间越界: '${raw}'`));
    return null;
  }
  if (ss > 59) {
    diags.push(diag("LEAP_SECOND", `拒绝闰秒或非法秒值: '${raw}'`));
    return null;
  }
  return { secondOfDay: hh * 3600 + mm * 60 + ss, fraction: m[4] ?? "" };
}

/** ddmmyy -> YYYY-MM-DD；yy 00-79 => 2000-2079，80-99 => 1980-1999。 */
export function parseDate(raw: string, diags: Diagnostic[]): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!m) {
    diags.push(diag("BAD_DATE", `日期格式非法: '${raw}'，应为 ddmmyy`));
    return null;
  }
  const dd = Number(m[1]), mo = Number(m[2]), yy = Number(m[3]);
  const year = yy <= 79 ? 2000 + yy : 1900 + yy;
  const t = Date.UTC(year, mo - 1, dd);
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== dd) {
    diags.push(diag("BAD_DATE", `不存在的日期: '${raw}'`));
    return null;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(mo)}-${p(dd)}`;
}

/** 校验显式 UTC 日期参数 YYYY-MM-DD 且为真实日期。 */
export function isValidUtcDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * 解析度分坐标。latKind=true 用 ddmm.mmmm（<=90），否则 dddmm.mmmm（<=180）。
 * 极点度数只允许零分钟。
 */
function parseCoord(raw: string, hemi: string, latKind: boolean, diags: Diagnostic[]): number | null {
  if (!/^\d+\.\d+$/.test(raw) && !/^\d+$/.test(raw)) {
    diags.push(diag("BAD_COORD", `坐标格式非法: '${raw}'`));
    return null;
  }
  const dot = raw.indexOf(".");
  const intPart = dot === -1 ? raw : raw.slice(0, dot);
  const minIntDigits = latKind ? 2 : 3;
  if (intPart.length < minIntDigits + 2) {
    diags.push(diag("BAD_COORD", `坐标位数不足: '${raw}'`));
    return null;
  }
  const degRaw = intPart.slice(0, intPart.length - 2);
  const minRaw = intPart.slice(intPart.length - 2) + (dot === -1 ? "" : raw.slice(dot));
  const deg = Number(degRaw);
  const min = Number(minRaw);
  const limit = latKind ? 90 : 180;
  if (min >= 60) {
    diags.push(diag("BAD_COORD", `分钟必须小于 60: '${raw}'`));
    return null;
  }
  if (deg > limit || (deg === limit && min !== 0)) {
    diags.push(diag("BAD_COORD", `度数越界: '${raw}'（${latKind ? "纬" : "经"}度上限 ${limit}，极值仅允许零分钟）`));
    return null;
  }
  const expect = latKind ? ["N", "S"] : ["E", "W"];
  if (!expect.includes(hemi)) {
    diags.push(diag("BAD_HEMISPHERE", `半球标记非法: '${hemi}'`));
    return null;
  }
  const sign = hemi === "S" || hemi === "W" ? -1 : 1;
  return roundCoord(sign * (deg + min / 60));
}

/**
 * 解析单行（不含行尾 CRLF/LF）。返回诊断列表；ok=false 时不参与配对。
 * @param explicitDate GGA 必需的显式 UTC 日期（YYYY-MM-DD）；RMC 忽略。
 */
export function parseLine(raw: string, explicitDate?: string): ParsedSentence {
  const diagnostics: Diagnostic[] = [];
  const fail = (): ParsedSentence => ({ ok: false, diagnostics });

  if (raw.length > MAX_LINE_LEN) {
    diagnostics.push(diag("LINE_TOO_LONG", `行长超过 ${MAX_LINE_LEN}`));
    return fail();
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) {
      diagnostics.push(diag("NON_ASCII", `行含非 ASCII 字符（位置 ${i}）`));
      return fail();
    }
  }
  if (!raw.startsWith("$")) {
    diagnostics.push(diag("BAD_FORMAT", "行必须以 '$' 开头"));
    return fail();
  }
  const star = raw.indexOf("*");
  if (star === -1) {
    diagnostics.push(diag("MISSING_STAR", "缺少 '*' 校验分隔符"));
    return fail();
  }
  const hh = raw.slice(star + 1);
  if (!/^[0-9A-Fa-f]{2}$/.test(hh)) {
    diagnostics.push(diag("BAD_CHECKSUM_CHAR", `校验和字符非法: '${hh}'，应为两个十六进制字符`));
    return fail();
  }
  const body = raw.slice(1, star);
  if (checksum(body) !== parseInt(hh, 16)) {
    diagnostics.push(diag("CHECKSUM_MISMATCH", `校验和不匹配: 期望 ${checksum(body).toString(16).toUpperCase().padStart(2, "0")}，实际 ${hh.toUpperCase()}`));
    return fail();
  }

  const fields = body.split(",");
  const head = fields[0];
  if (head.length < 5) {
    diagnostics.push(diag("BAD_FORMAT", `句头非法: '${head}'`));
    return fail();
  }
  const type = head.slice(-3);
  if (type !== "GGA" && type !== "RMC") {
    diagnostics.push(diag("UNKNOWN_TYPE", `不支持的语句类型: '${type}'（仅支持 GGA/RMC）`));
    return fail();
  }

  if (type === "GGA") return parseGga(fields, diagnostics, explicitDate);
  return parseRmc(fields, diagnostics);
}

function parseGga(fields: string[], diagnostics: Diagnostic[], explicitDate?: string): ParsedSentence {
  // $--GGA,time,lat,NS,lon,EW,quality,numSV,HDOP,alt,M,geoid,M,age,station
  if (fields.length < 7) {
    diagnostics.push(diag("INSUFFICIENT_FIELDS", `GGA 字段不足: ${fields.length - 1}，至少需要 6`));
    return { ok: false, diagnostics };
  }
  if (!explicitDate || !isValidUtcDate(explicitDate)) {
    diagnostics.push(diag("MISSING_DATE", "GGA 需要导入参数显式提供合法 UTC 日期 (YYYY-MM-DD)"));
    return { ok: false, diagnostics };
  }
  const [, timeRaw, latRaw, ns, lonRaw, ew, qualityRaw] = fields;
  const time = parseTime(timeRaw, diagnostics);
  const quality = qualityRaw === "" ? NaN : Number(qualityRaw);
  if (!Number.isInteger(quality) || quality < 0 || quality > 8) {
    diagnostics.push(diag("BAD_QUALITY", `GGA 质量指示非法: '${qualityRaw}'`));
  }
  const fixValid = Number.isInteger(quality) && quality > 0;
  let lat: number | null = null, lon: number | null = null;
  const coordsEmpty = latRaw === "" && lonRaw === "" && ns === "" && ew === "";
  if (coordsEmpty) {
    if (fixValid) {
      diagnostics.push(diag("INCONSISTENT", "定位状态有效但坐标为空"));
    }
  } else {
    if (latRaw === "" || lonRaw === "") {
      diagnostics.push(diag("INCONSISTENT", "经纬度只给出一半"));
    } else {
      lat = parseCoord(latRaw, ns, true, diagnostics);
      lon = parseCoord(lonRaw, ew, false, diagnostics);
    }
  }
  const numSats = fields[7] !== undefined && fields[7] !== "" ? Number(fields[7]) : null;
  const hdop = fields[8] !== undefined && fields[8] !== "" ? Number(fields[8]) : null;
  if (!time || diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true, diagnostics, type: "GGA",
    timeRaw, secondOfDay: time.secondOfDay, timeFraction: time.fraction,
    lat, lon, fixValid, quality, numSats, hdop, date: explicitDate,
  };
}

function parseRmc(fields: string[], diagnostics: Diagnostic[]): ParsedSentence {
  // $--RMC,time,status,lat,NS,lon,EW,speed,course,date,magvar,magEW[,mode]
  if (fields.length < 11) {
    diagnostics.push(diag("INSUFFICIENT_FIELDS", `RMC 字段不足: ${fields.length - 1}，至少需要 10`));
    return { ok: false, diagnostics };
  }
  const [, timeRaw, status, latRaw, ns, lonRaw, ew, speedRaw, , dateRaw] = fields;
  const time = parseTime(timeRaw, diagnostics);
  if (status !== "A" && status !== "V") {
    diagnostics.push(diag("BAD_STATUS", `RMC 状态非法: '${status}'，应为 A 或 V`));
  }
  const fixValid = status === "A";
  const date = parseDate(dateRaw, diagnostics);
  let lat: number | null = null, lon: number | null = null;
  const coordsEmpty = latRaw === "" && lonRaw === "" && ns === "" && ew === "";
  if (coordsEmpty) {
    if (fixValid) {
      diagnostics.push(diag("INCONSISTENT", "定位状态有效但坐标为空"));
    }
  } else {
    if (latRaw === "" || lonRaw === "") {
      diagnostics.push(diag("INCONSISTENT", "经纬度只给出一半"));
    } else {
      lat = parseCoord(latRaw, ns, true, diagnostics);
      lon = parseCoord(lonRaw, ew, false, diagnostics);
    }
  }
  let speedKnots: number | null = null, speedMps: number | null = null;
  if (speedRaw !== "") {
    speedKnots = Number(speedRaw);
    if (!Number.isFinite(speedKnots) || speedKnots < 0) {
      diagnostics.push(diag("BAD_SPEED", `速度非法: '${speedRaw}'`));
      speedKnots = null;
    } else {
      speedMps = Math.round(speedKnots * KNOT_TO_MPS * 1e6) / 1e6;
    }
  }
  if (!time || !date || diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true, diagnostics, type: "RMC",
    timeRaw, secondOfDay: time.secondOfDay, timeFraction: time.fraction,
    lat, lon, fixValid, status, speedKnots, speedMps, date,
  };
}
