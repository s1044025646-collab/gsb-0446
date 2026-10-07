import { ParsedSentence } from "./nmea";

export interface StoredLine {
  id: number;
  lineNo: number;
  raw: string;
  source: string;
  date: string;
  parsed: ParsedSentence;
}

export interface Candidate {
  type: "GGA" | "RMC";
  count: number;
  lineNos: number[];
  sentence: ParsedSentence;
  raw: string;
}

export interface PairRecord {
  source: string;
  date: string;
  secondOfDay: number;
  gga: Candidate | "CONFLICT" | null;
  rmc: Candidate | "CONFLICT" | null;
  status: "PAIRED_VALID" | "PAIRED_INVALID_FIX" | "PAIRED_COORD_MISMATCH" | "UNPAIRED" | "CONFLICT";
  coordConsistent: boolean | null;
  latDiffDeg: number | null;
  lonDiffDeg: number | null;
}

function keyOf(source: string, date: string, second: number): string {
  return `${source}\u0001${date}${String(second).padStart(5, "0")}`;
}

/**
 * 配对：同一来源 + 同一 UTC 日期 + 同一整数秒。
 * 完全相同原句去重并计数；同键同类型出现不同原句 => 冲突，不参与配对。
 */
export function buildPairs(lines: StoredLine[], toleranceDeg: number): PairRecord[] {
  const okLines = lines.filter((l) => l.parsed.ok && l.parsed.type);
  const groups = new Map<string, Map<string, StoredLine[]>>();
  for (const l of okLines) {
    const k = `${keyOf(l.source, l.date, l.parsed.secondOfDay!)}|${l.parsed.type}`;
    let g = groups.get(k);
    if (!g) { g = new Map(); groups.set(k, g); }
    const arr = g.get(l.raw);
    if (arr) arr.push(l);
    else g.set(l.raw, [l]);
  }

  const candidates = new Map<string, Candidate | "CONFLICT">();
  for (const [k, byRaw] of groups) {
    const sep = k.lastIndexOf("|");
    const baseKey = k.slice(0, sep);
    const type = k.slice(sep + 1) as "GGA" | "RMC";
    if (byRaw.size > 1) {
      candidates.set(k, "CONFLICT");
    } else {
      const [raw, arr] = [...byRaw.entries()][0];
      candidates.set(k, {
        type,
        count: arr.length,
        lineNos: arr.map((l) => l.lineNo).sort((a, b) => a - b),
        sentence: arr[0].parsed,
        raw,
      });
    }
  }

  const pairKeys = new Set<string>();
  for (const k of candidates.keys()) pairKeys.add(k.slice(0, k.lastIndexOf("|")));

  const pairs: PairRecord[] = [];
  for (const base of pairKeys) {
    const gga = candidates.get(base + "|GGA") ?? null;
    const rmc = candidates.get(base + "|RMC") ?? null;
    const sep = base.indexOf("\u0001");
    const source = base.slice(0, sep);
    const rest = base.slice(sep + 1);
    const date = rest.slice(0, 10);
    const secondOfDay = Number(rest.slice(10));

    const conflict = gga === "CONFLICT" || rmc === "CONFLICT";
    const g = gga === "CONFLICT" ? null : gga;
    const r = rmc === "CONFLICT" ? null : rmc;

    let status: PairRecord["status"];
    let coordConsistent: boolean | null = null;
    let latDiffDeg: number | null = null;
    let lonDiffDeg: number | null = null;

    if (conflict) {
      status = "CONFLICT";
    } else if (!g || !r) {
      status = "UNPAIRED";
    } else {
      const gs = g.sentence, rs = r.sentence;
      if (gs.lat != null && gs.lon != null && rs.lat != null && rs.lon != null) {
        latDiffDeg = Math.abs(gs.lat - rs.lat);
        lonDiffDeg = Math.abs(gs.lon - rs.lon);
        coordConsistent = latDiffDeg <= toleranceDeg && lonDiffDeg <= toleranceDeg;
      }
      if (!gs.fixValid || !rs.fixValid) status = "PAIRED_INVALID_FIX";
      else if (coordConsistent !== true) status = "PAIRED_COORD_MISMATCH";
      else status = "PAIRED_VALID";
    }

    pairs.push({
      source, date, secondOfDay,
      gga: gga ?? null, rmc: rmc ?? null,
      status, coordConsistent, latDiffDeg, lonDiffDeg,
    });
  }
  pairs.sort((a, b) =>
    a.source.localeCompare(b.source) ||
    a.date.localeCompare(b.date) ||
    a.secondOfDay - b.secondOfDay
  );
  return pairs;
}
