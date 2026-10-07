export const RULE_VERSION = 'nmea-obs-rules-1.0.0';

/** 速度换算：1 节 = 1852/3600 m/s（国际海里定义） */
export const KNOTS_TO_MPS = 1852 / 3600;

/** 单条原始行（含 $ 与 *HH）的最大字节数 */
export const MAX_LINE_BYTES = 120;
/** 单次导入批次最大行数 */
export const MAX_BATCH_LINES = 10_000;
/** 导入负载最大字节数（约 2MB） */
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
/** 经纬度小数部分（分钟小数）最多允许的位数 */
export const MAX_COORD_FRACTION_DIGITS = 7;
/** 来源标识长度上限 */
export const MAX_SOURCE_LENGTH = 64;

export type ErrorCode =
  | 'BATCH_MALFORMED'
  | 'BATCH_TOO_LARGE'
  | 'TOO_MANY_LINES'
  | 'LINE_TOO_LONG'
  | 'NON_ASCII'
  | 'BAD_LINE_ENDING'
  | 'MISSING_DOLLAR'
  | 'MISSING_STAR'
  | 'BAD_CHECKSUM_HEX'
  | 'CHECKSUM_MISMATCH'
  | 'UNKNOWN_SENTENCE'
  | 'TOO_FEW_FIELDS'
  | 'BAD_TIME'
  | 'BAD_DATE'
  | 'BAD_COORDINATE'
  | 'BAD_HEMI'
  | 'BAD_STATUS'
  | 'BAD_QUALITY'
  | 'BAD_SPEED'
  | 'FIX_INCONSISTENT'
  | 'GGA_DATE_REQUIRED'
  | 'BAD_SOURCE'
  | 'BAD_DATE_PARAM'
  | 'BAD_TOLERANCE'
  | 'BAD_REQUEST_ID'
  | 'NOT_FOUND'
  | 'BAD_JSON';

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BATCH_MALFORMED: '导入批次结构非法：必须是 JSON 对象，含 source、defaultDateUtc、requestId、lines',
  BATCH_TOO_LARGE: '导入负载超过字节上限',
  TOO_MANY_LINES: '导入行数超过上限',
  LINE_TOO_LONG: '单行超过长度上限',
  NON_ASCII: '包含非 ASCII 字节',
  BAD_LINE_ENDING: '只允许行末 CRLF 或 LF',
  MISSING_DOLLAR: '缺少起始美元符 $',
  MISSING_STAR: '缺少分隔星号 *',
  BAD_CHECKSUM_HEX: '校验和不是两个十六进制字符',
  CHECKSUM_MISMATCH: '异或校验和不匹配',
  UNKNOWN_SENTENCE: '未知语句类型：仅支持 GGA 与 RMC',
  TOO_FEW_FIELDS: '字段数不足',
  BAD_TIME: '时间字段非法（hhmmss[.f]，秒不得为 60）',
  BAD_DATE: '日期字段非法或不存在（ddmmyy）',
  BAD_COORDINATE: '坐标字段非法（ddmm.mmmm / dddmm.mmmm，分<60）',
  BAD_HEMI: '方位字段非法（N/S/E/W）',
  BAD_STATUS: 'RMC 状态非法（A/V）',
  BAD_QUALITY: 'GGA 定位质量非法（0-8）',
  BAD_SPEED: '速度字段非法（非负数字）',
  FIX_INCONSISTENT: '有效定位状态却缺失/矛盾坐标或质量',
  GGA_DATE_REQUIRED: 'GGA 语句的导入请求必须显式提供 UTC 日期',
  BAD_SOURCE: 'source 必须为 1-64 字符非空字符串',
  BAD_DATE_PARAM: '日期必须为 YYYY-MM-DD 格式的真实 UTC 日期',
  BAD_TOLERANCE: '角度容差必须为 0-90 之间的有限数字（度）',
  BAD_REQUEST_ID: 'requestId 必须为 1-128 字符非空字符串',
  NOT_FOUND: '资源不存在',
  BAD_JSON: '请求体不是合法 JSON',
};
