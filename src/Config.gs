/**
 * Config.gs
 * ------------------------------------------------------------------
 * 全域設定、常數定義與共用清洗工具。
 * 注意：GAS 所有 .gs 共用同一個全域命名空間，本檔頂層符號不可與其他檔案重複。
 * 本檔私有輔助函式一律以 config 前綴並以底線結尾（例如 configPad2_）。
 * 憑證鐵律：嚴禁硬編碼任何金鑰或試算表 ID，一律由 PropertiesService 讀取。
 */

/** Clean_DB 各分頁名稱 */
const SHEET_NAMES = Object.freeze({
  CONTRACTS: 'Clean_DB_Contracts',
  MONTHLY: 'Clean_DB_Monthly',
  DEDUCTIONS: 'Clean_DB_Deductions',
  DAILY_POS: 'Clean_DB_DailyPOS',
  ETL_FILES: 'ETL_Processed_Files',
  WHITELIST: 'Auth_Whitelist',
  AUDIT_LOG: 'Security_Audit_Log'
});

/** 例外代碼（SDD 5.2 零幻覺防線） */
const ERR_CODES = Object.freeze({
  MISSING_MONTH: 'ERR_MISSING_MONTH',
  NO_COUNTER_RECORD: 'ERR_NO_COUNTER_RECORD',
  DIVIDE_BY_ZERO: 'ERR_DIVIDE_BY_ZERO',
  DUPLICATE_BATCH: 'ERR_DUPLICATE_BATCH',
  NULL_FIELD: 'ERR_NULL_FIELD'
});

/** CacheService 存活秒數 */
const CACHE_TTL_SECONDS = Object.freeze({
  INDEX: 600,
  WHITELIST: 300,
  STATE: 600
});

/** 商場自訂樓層排序 */
const FLOOR_ORDER = Object.freeze([
  'B3', 'B2', 'B1', 'G樓', '1樓', '2樓', '3樓', '4樓', '5樓',
  '6樓', '7樓', '8樓', '9樓', '10樓', '未分類樓層'
]);

/** 未分類樓層預設值 */
const CONFIG_UNCLASSIFIED_FLOOR = '未分類樓層';

/** 預設 Gemini 模型名稱（可由 ScriptProperties 的 GEMINI_MODEL 覆寫） */
const CONFIG_DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * 讀取系統設定（全部來自 ScriptProperties，不含任何硬編碼憑證）。
 * @return {{WEBHOOK_SECRET_KEY:string, LINE_CHANNEL_ACCESS_TOKEN:string, GEMINI_API_KEY:string,
 *           GEMINI_MODEL:string, CLEAN_DB_SPREADSHEET_ID:string, RAW_ERP_DRIVE_FOLDER_ID:string}}
 */
function getAppConfig() {
  const props = PropertiesService.getScriptProperties();
  const read = function (key) {
    const v = props.getProperty(key);
    return v === null || v === undefined ? '' : String(v).trim();
  };
  return {
    WEBHOOK_SECRET_KEY: read('WEBHOOK_SECRET_KEY'),
    LINE_CHANNEL_ACCESS_TOKEN: read('LINE_CHANNEL_ACCESS_TOKEN'),
    GEMINI_API_KEY: read('GEMINI_API_KEY'),
    GEMINI_MODEL: read('GEMINI_MODEL') || CONFIG_DEFAULT_GEMINI_MODEL,
    CLEAN_DB_SPREADSHEET_ID: read('CLEAN_DB_SPREADSHEET_ID'),
    RAW_ERP_DRIVE_FOLDER_ID: read('RAW_ERP_DRIVE_FOLDER_ID')
  };
}

// ------------------------------------------------------------------
// 樓層工具
// ------------------------------------------------------------------

/**
 * 計算樓層排序權重（與 FLOOR_ORDER 一致，並可容納未列舉之樓層如 B4、11樓）。
 * @param {string} floorName
 * @return {number}
 */
function configFloorRank_(floorName) {
  const name = String(floorName === null || floorName === undefined ? '' : floorName).trim();
  if (name === CONFIG_UNCLASSIFIED_FLOOR || name === '') return 999999;
  let m = name.match(/^B(\d+)(?:樓|F)?$/i);
  if (m) return 1000 - Number(m[1]) * 10;
  if (/^G(?:樓|F)?$/i.test(name)) return 1000;
  m = name.match(/^(\d+)(?:樓|F)$/i);
  if (m) return 1000 + Number(m[1]) * 10;
  return 500000; // 其他非標準樓層名稱排在標準樓層之後、未分類之前
}

/**
 * 依商場自訂順序排序樓層（去重、去空白）。
 * @param {string[]} floors
 * @return {string[]}
 */
function sortFloors(floors) {
  const seen = {};
  const list = [];
  (floors || []).forEach(function (f) {
    const name = String(f === null || f === undefined ? '' : f).trim();
    if (name === '' || seen[name]) return;
    seen[name] = true;
    list.push(name);
  });
  return list.sort(function (a, b) {
    const ra = configFloorRank_(a);
    const rb = configFloorRank_(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b, 'zh-Hant');
  });
}

/**
 * 樓層名稱轉短代碼（供 Postback data 使用，避免超過 300 字元）。
 * 例：'B1'→'B1'、'G樓'→'G'、'8樓'→'8F'、'未分類樓層'→'UNK'；無法辨識者原樣回傳。
 * @param {string} floorName
 * @return {string}
 */
function encodeFloorCode(floorName) {
  const name = String(floorName === null || floorName === undefined ? '' : floorName).trim();
  if (name === '' || name === CONFIG_UNCLASSIFIED_FLOOR) return 'UNK';
  let m = name.match(/^B(\d+)(?:樓|F)?$/i);
  if (m) return 'B' + Number(m[1]);
  if (/^G(?:樓|F)?$/i.test(name)) return 'G';
  m = name.match(/^(\d+)(?:樓|F)$/i);
  if (m) return Number(m[1]) + 'F';
  return name;
}

/**
 * 短代碼還原為樓層名稱（encodeFloorCode 的反函式）。
 * @param {string} floorCode
 * @return {string}
 */
function decodeFloorCode(floorCode) {
  const code = String(floorCode === null || floorCode === undefined ? '' : floorCode).trim();
  if (code === '' || code.toUpperCase() === 'UNK') return CONFIG_UNCLASSIFIED_FLOOR;
  let m = code.match(/^B(\d+)$/i);
  if (m) return 'B' + Number(m[1]);
  if (/^G$/i.test(code)) return 'G樓';
  m = code.match(/^(\d+)F$/i);
  if (m) return Number(m[1]) + '樓';
  return code;
}

// ------------------------------------------------------------------
// 共用清洗工具
// ------------------------------------------------------------------

/**
 * 專櫃編號標準化：空值回傳 ''，否則補足 5 碼前導零（防範 'null0' 陷阱）。
 * @param {*} rawVal
 * @return {string}
 */
function normalizeCounterId(rawVal) {
  if (rawVal === null || rawVal === undefined) return '';
  const s = String(rawVal).trim();
  if (s === '') return '';
  return s.padStart(5, '0');
}

/** 兩位數補零 */
function configPad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 由年/月/日數字組成 YYYY-MM-DD，非法日期回傳 '' */
function configBuildYmd_(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return '';
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return y + '-' + configPad2_(m) + '-' + configPad2_(d);
}

/** Excel 序列值轉 YYYY-MM-DD（UTC 基準，避免時區位移） */
function configExcelSerialToYmd_(n) {
  const dt = new Date(Math.round((Number(n) - 25569) * 86400000));
  if (isNaN(dt.getTime())) return '';
  return configBuildYmd_(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 判斷是否為 Date 物件（跨 vm 情境亦可判斷） */
function configIsDate_(val) {
  return Object.prototype.toString.call(val) === '[object Date]';
}

/**
 * 日期格式化為 'YYYY-MM-DD'。
 * 支援：Date 物件（GAS 本地時區即專案時區 Asia/Taipei）、Excel 序列值（20000..90000）、
 *       'YYYY/MM/DD'、'YYYY-MM-DD'、'YYYY.MM.DD'（可帶時間）、'YYYYMMDD'。
 * 無法解析時回傳 ''。
 * @param {*} val
 * @return {string}
 */
function formatDateYMD(val) {
  if (val === null || val === undefined) return '';
  if (configIsDate_(val)) {
    if (isNaN(val.getTime())) return '';
    return configBuildYmd_(val.getFullYear(), val.getMonth() + 1, val.getDate());
  }
  if (typeof val === 'number') {
    if (val >= 20000 && val <= 90000) return configExcelSerialToYmd_(val);
    return '';
  }
  const s = String(val).trim();
  if (s === '') return '';
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 90000) return configExcelSerialToYmd_(n);
    if (/^\d{8}$/.test(s)) return configBuildYmd_(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8));
    return '';
  }
  const m = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
  if (m) return configBuildYmd_(m[1], m[2], m[3]);
  return '';
}

/**
 * 年月標準化為 'YYYYMM' 6 碼字串（支援 202610、'2026/10'、'2026-10'、Date、Excel 序列值）。
 * 無法解析時回傳 ''。
 * @param {*} val
 * @return {string}
 */
function normalizeYearMonth(val) {
  if (val === null || val === undefined) return '';
  if (configIsDate_(val)) {
    if (isNaN(val.getTime())) return '';
    return val.getFullYear() + configPad2_(val.getMonth() + 1);
  }
  const s = String(val).trim().replace(/\.0+$/, '');
  if (s === '') return '';
  let m = s.match(/^(\d{4})(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return m[1] + m[2];
  m = s.match(/^(\d{4})[\/\-.年](\d{1,2})(?:月)?(?:[\/\-.]\d{1,2})?/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return m[1] + configPad2_(Number(m[2]));
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 90000) return configExcelSerialToYmd_(n).replace(/-/g, '').slice(0, 6);
  }
  return '';
}

/**
 * 數值解析：移除千分位逗號與空白；空白 / null / undefined / NaN 回傳 null。
 * @param {*} val
 * @return {?number}
 */
function parseNumberOrNull(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isFinite(val) ? val : null;
  if (typeof val === 'boolean') return null;
  const s = String(val).replace(/[,\s\u3000]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * 數值解析：同 parseNumberOrNull，但無效值回傳 0。
 * @param {*} val
 * @return {number}
 */
function parseNumberOrZero(val) {
  const n = parseNumberOrNull(val);
  return n === null ? 0 : n;
}

/**
 * 取得台北時區今日日期 'YYYY-MM-DD'。
 * @return {string}
 */
function getTaipeiTodayYmd() {
  const now = new Date();
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    try {
      return Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
    } catch (err) {
      // 若格式化失敗則改用 UTC+8 手動換算
    }
  }
  const tpe = new Date(now.getTime() + 8 * 3600000);
  return configBuildYmd_(tpe.getUTCFullYear(), tpe.getUTCMonth() + 1, tpe.getUTCDate());
}

// ------------------------------------------------------------------
// 試算表存取工具
// ------------------------------------------------------------------

/**
 * 開啟 Clean_DB 中繼試算表。
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getCleanDbSpreadsheet() {
  const id = getAppConfig().CLEAN_DB_SPREADSHEET_ID;
  if (!id) {
    throw new Error('尚未設定指令碼屬性 CLEAN_DB_SPREADSHEET_ID，請至「專案設定 > 指令碼屬性」新增。');
  }
  return SpreadsheetApp.openById(id);
}

/**
 * 批次讀取分頁並轉為物件陣列（key 為第 1 列表頭欄名）。
 * 分頁不存在或僅有表頭時回傳 []；全空白列自動略過。
 * @param {string} sheetName
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet=} optSpreadsheet 可選，預設開啟 Clean_DB
 * @return {Object[]}
 */
function readSheetObjects(sheetName, optSpreadsheet) {
  const ss = optSpreadsheet || getCleanDbSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    let hasValue = false;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      const v = row[c] === undefined ? '' : row[c];
      if (v !== '' && v !== null) hasValue = true;
      obj[headers[c]] = v;
    }
    if (hasValue) out.push(obj);
  }
  return out;
}
