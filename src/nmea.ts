import {
  MAX_COORD_FRACTION_DIGITS,
  MAX_LINE_BYTES,
  KNOTS_TO_MPS,
} from './constants.js';
import type { ParsedCoordinate, ParsedRecord, SentenceType } from './types.js';

export interface ParseFailure {
  ok: false;
  errorCode: string;
  message: string;
}
export interface ParseSuccess {
  ok: true;
  record: Omit<ParsedRecord, 'dateUtc' | 'lineNo'>;
}
export type LineParseResult = ParseFailure | ParseSuccess;

/**
 * 对 $ 与 * 之间（不含二者，含逗号）的全部 ASCII 字节逐字节异或。
 */
export function xorChecksum(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum ^= body.charCodeAt(i);
  }
  return sum;
}

export function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

function parseTime(text: string): { hour: number; minute: number; second: number; fraction: string } | null {
  const m = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, fraction: m[4] ?? '' };
}

/** ddmmyy，00-79 -> 2000-2079，80-99 -> 1980-1999；拒绝不存在的日期。 */
export function parseNmeaDate(text: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const yy = Number(m[3]);
  if (day === 0 || month === 0 || month > 12) return null;
  const year = yy <= 79 ? 2000 + yy : 1900 + yy;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > dim) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * 纬度 ddmm.mmmm / 经度 dddmm.mmmm，分必须 <60；
 * 纬度 90、经度 180 只允许零分。返回带方位符号的十进制度。
 */
export function parseCoord(raw: string, hemi: string, isLat: boolean): number | null {
  const numeric = /^(\d{2,5})(?:\.(\d+))?$/.exec(raw);
  if (!numeric) return null;
  if ((numeric[2] ?? '').length > MAX_COORD_FRACTION_DIGITS) return null;
  const intPart = numeric[1] as string;
  const degLen = isLat ? 2 : 3;
  if (intPart.length !== degLen) return null;
  const deg = Number(intPart.slice(0, degLen));
  const minutes = Number(intPart.slice(degLen));
  if (minutes >= 60) return null;
  const maxDeg = isLat ? 90 : 180;
  if (deg > maxDeg) return null;
  if (deg === maxDeg && minutes !== 0) return null;
  if (numeric[2] && deg === maxDeg && Number((numeric[2] as string).replace(/0+$/, '')) > 0) return null;
  const frac = numeric[2] ? Number('0.' + numeric[2]) : 0;
  const decimal = deg + (minutes + frac) / 60;
  if (isLat) {
    if (hemi === 'N') return decimal;
    if (hemi === 'S') return -decimal;
  } else {
    if (hemi === 'E') return decimal;
    if (hemi === 'W') return -decimal;
  }
  return null;
}

function hemiOk(hemi: string, isLat: boolean): boolean {
  return isLat ? hemi === 'N' || hemi === 'S' : hemi === 'E' || hemi === 'W';
}

function fail(errorCode: string, message: string): ParseFailure {
  return { ok: false, errorCode, message };
}

/**
 * 解析单行（不含行尾）。rawLine 必须已是 ASCII 且长度受限。
 * 不自动修复正文；保留空字段语义（split 不丢空列）。
 */
export function parseLine(rawLine: string): LineParseResult {
  if (rawLine.length > MAX_LINE_BYTES) return fail('LINE_TOO_LONG', `行长度超过 ${MAX_LINE_BYTES} 字节`);
  if (!isAscii(rawLine)) return fail('NON_ASCII', '包含非 ASCII 字节');
  if (!rawLine.startsWith('$')) return fail('MISSING_DOLLAR', '缺少起始 $');
  const star = rawLine.lastIndexOf('*');
  if (star < 0) return fail('MISSING_STAR', '缺少 *');
  const body = rawLine.slice(1, star);
  const hex = rawLine.slice(star + 1);
  if (!/^[0-9a-fA-F]{2}$/.test(hex)) return fail('BAD_CHECKSUM_HEX', '校验和须为两个十六进制字符');
  if (body.length === 0) return fail('UNKNOWN_SENTENCE', '正文为空');
  const expected = xorChecksum(body);
  if (expected !== parseInt(hex, 16)) return fail('CHECKSUM_MISMATCH', `校验和应为 ${expected.toString(16).padStart(2, '0').toUpperCase()}`);

  const fields = body.split(',');
  const address = fields[0] ?? '';
  let type: SentenceType | null = null;
  if (address.endsWith('GGA')) type = 'GGA';
  else if (address.endsWith('RMC')) type = 'RMC';
  if (!type) return fail('UNKNOWN_SENTENCE', `仅支持 GGA 与 RMC：${address || '(空)'}`);

  if (type === 'GGA') return parseGga(fields, rawLine);
  return parseRmc(fields, rawLine);
}

/** 字段索引：0 地址 1 时间 2 纬度 3 N/S 4 经度 5 E/W 6 质量 7 卫星数 8 HDOP 9 高程 ... */
function parseGga(fields: string[], raw: string): LineParseResult {
  if (fields.length < 10) return fail('TOO_FEW_FIELDS', `GGA 至少 10 个字段，实际 ${fields.length}`);
  const timeText = fields[1] ?? '';
  const latRaw = fields[2] ?? '';
  const latHemi = fields[3] ?? '';
  const lonRaw = fields[4] ?? '';
  const lonHemi = fields[5] ?? '';
  const qualityText = fields[6] ?? '';

  const tm = parseTime(timeText);
  if (!tm) return fail('BAD_TIME', `GGA 时间非法：${timeText || '(空)'}`);
  if (!/^[0-8]$/.test(qualityText)) return fail('BAD_QUALITY', `GGA 质量须为 0-8：${qualityText || '(空)'}`);
  const quality = Number(qualityText);

  const bothEmpty = latRaw === '' && lonRaw === '' && latHemi === '' && lonHemi === '';
  if (quality === 0) {
    let lat: number | null = null;
    let lon: number | null = null;
    if (bothEmpty) {
      return { ok: true, record: baseRecord('GGA', timeText, tm, false, null, null, quality, null, null, raw, null) };
    }
    if (!hemiOk(latHemi, true) || !hemiOk(lonHemi, false)) return fail('BAD_HEMI', '方位字段须为 N/S 与 E/W');
    lat = parseCoord(latRaw, latHemi, true);
    lon = parseCoord(lonRaw, lonHemi, false);
    if (lat === null || lon === null) return fail('BAD_COORDINATE', '无效定位下坐标无法解析');
    return { ok: true, record: baseRecord('GGA', timeText, tm, false, lat, lon, quality, null, null, raw, null) };
  }

  if (bothEmpty) return fail('FIX_INCONSISTENT', 'GGA 质量非 0（有效定位）但坐标为空');
  if (!hemiOk(latHemi, true)) return fail('BAD_HEMI', `纬度方位须为 N/S：${latHemi || '(空)'}`);
  if (!hemiOk(lonHemi, false)) return fail('BAD_HEMI', `经度方位须为 E/W：${lonHemi || '(空)'}`);
  const lat = parseCoord(latRaw, latHemi, true);
  const lon = parseCoord(lonRaw, lonHemi, false);
  if (lat === null) return fail('BAD_COORDINATE', `纬度无法解析：${latRaw}`);
  if (lon === null) return fail('BAD_COORDINATE', `经度无法解析：${lonRaw}`);
  return { ok: true, record: baseRecord('GGA', timeText, tm, true, lat, lon, quality, null, null, raw, null) };
}

/** 0 地址 1 时间 2 状态 3 纬度 4 N/S 5 经度 6 E/W 7 速度(节) 8 航向 9 日期 */
function parseRmc(fields: string[], raw: string): LineParseResult {
  if (fields.length < 10) return fail('TOO_FEW_FIELDS', `RMC 至少 10 个字段，实际 ${fields.length}`);
  const timeText = fields[1] ?? '';
  const status = fields[2] ?? '';
  const latRaw = fields[3] ?? '';
  const latHemi = fields[4] ?? '';
  const lonRaw = fields[5] ?? '';
  const lonHemi = fields[6] ?? '';
  const speedText = fields[7] ?? '';
  const dateText = fields[9] ?? '';

  const tm = parseTime(timeText);
  if (!tm) return fail('BAD_TIME', `RMC 时间非法：${timeText || '(空)'}`);
  if (status !== 'A' && status !== 'V') return fail('BAD_STATUS', `RMC 状态须为 A/V：${status || '(空)'}`);
  const date = parseNmeaDate(dateText);
  if (!date) return fail('BAD_DATE', `RMC 日期非法：${dateText || '(空)'}`);

  let speedKnots: number | null = null;
  if (speedText !== '') {
    if (!/^\d+(?:\.\d+)?$/.test(speedText)) return fail('BAD_SPEED', `速度须为非负数字：${speedText}`);
    speedKnots = Number(speedText);
    if (!Number.isFinite(speedKnots)) return fail('BAD_SPEED', '速度不是有限数');
  }
  const speedMps = speedKnots === null ? null : speedKnots * KNOTS_TO_MPS;

  const bothEmpty = latRaw === '' && lonRaw === '' && latHemi === '' && lonHemi === '';
  if (status === 'V') {
    let lat: number | null = null;
    let lon: number | null = null;
    if (!bothEmpty) {
      if (!hemiOk(latHemi, true) || !hemiOk(lonHemi, false)) return fail('BAD_HEMI', '方位字段须为 N/S 与 E/W');
      lat = parseCoord(latRaw, latHemi, true);
      lon = parseCoord(lonRaw, lonHemi, false);
      if (lat === null || lon === null) return fail('BAD_COORDINATE', '无效定位下坐标无法解析');
    }
    return { ok: true, record: baseRecord('RMC', timeText, tm, false, lat, lon, null, speedKnots, speedMps, raw, status, date) };
  }

  if (bothEmpty) return fail('FIX_INCONSISTENT', 'RMC 状态 A（有效定位）但坐标为空');
  if (!hemiOk(latHemi, true)) return fail('BAD_HEMI', `纬度方位须为 N/S：${latHemi || '(空)'}`);
  if (!hemiOk(lonHemi, false)) return fail('BAD_HEMI', `经度方位须为 E/W：${lonHemi || '(空)'}`);
  const lat = parseCoord(latRaw, latHemi, true);
  const lon = parseCoord(lonRaw, lonHemi, false);
  if (lat === null) return fail('BAD_COORDINATE', `纬度无法解析：${latRaw}`);
  if (lon === null) return fail('BAD_COORDINATE', `经度无法解析：${lonRaw}`);
  return { ok: true, record: baseRecord('RMC', timeText, tm, true, lat, lon, null, speedKnots, speedMps, raw, status, date) };
}

function baseRecord(
  type: SentenceType,
  timeText: string,
  tm: { hour: number; minute: number; second: number; fraction: string },
  valid: boolean,
  lat: number | null,
  lon: number | null,
  quality: number | null,
  speedKnots: number | null,
  speedMps: number | null,
  raw: string,
  status: string | null,
  rmcDate?: string,
) {
  return {
    type,
    timeText,
    hour: tm.hour,
    minute: tm.minute,
    second: tm.second,
    fraction: tm.fraction,
    valid,
    lat,
    lon,
    quality,
    speedKnots,
    speedMps,
    status,
    rmcDate: rmcDate ?? null,
    raw,
  };
}

export { type ParsedCoordinate };
