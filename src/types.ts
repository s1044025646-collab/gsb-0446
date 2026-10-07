export type SentenceType = 'GGA' | 'RMC';

export interface LineDiagnostic {
  lineNo: number;
  raw: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export interface ParsedCoordinate {
  raw: string;
  degrees: number;
}

export interface ParsedRecord {
  type: SentenceType;
  timeText: string;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
  dateUtc: string;
  valid: boolean;
  lat: number | null;
  lon: number | null;
  quality: number | null;
  speedKnots: number | null;
  speedMps: number | null;
  status: string | null;
  raw: string;
  lineNo: number;
}
