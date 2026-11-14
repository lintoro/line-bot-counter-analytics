/**
 * FormulaEngine.gs
 * ------------------------------------------------------------
 * M1～M5 確定性公式計算引擎（100% GAS 原生程式碼計算，嚴禁任何 AI 介入計算）。
 *
 * 統一回傳格式：
 *   { ok: boolean, errorCode: string|null, errorMessage: string|null, moduleId: string, data: object|null }
 *
 * 相依（Config.gs）：SHEET_NAMES, ERR_CODES, CACHE_TTL_SECONDS, sortFloors, decodeFloorCode,
 *                   normalizeCounterId, formatDateYMD, parseNumberOrNull, parseNumberOrZero, readSheetObjects
 *
 * 索引快取 Key（ScriptCache，TTL = CACHE_TTL_SECONDS.INDEX，預設 600 秒）：
 *   IDX_FLOORS / IDX_COUNTERS_BY_FLOOR / IDX_BILLING_YMS / IDX_COUNTER_DIRECTORY
 *   ※ 由 EtlSync.gs 的 clearIndexCache() 於 ETL 完成後統一清除。
 * ------------------------------------------------------------
 */

/** 索引快取 Key 定義（需與 clearIndexCache() 一致） */
var FE_INDEX_CACHE_KEYS = {
  FLOORS: 'IDX_FLOORS',
  COUNTERS_BY_FLOOR: 'IDX_COUNTERS_BY_FLOOR',
  BILLING_YMS: 'IDX_BILLING_YMS',
  COUNTER_DIRECTORY: 'IDX_COUNTER_DIRECTORY'
};

/** 月結表需轉數值的欄位 */
var FE_MONTHLY_NUM_FIELDS = [
  'sales_untaxed', 'sales_tax', 'sales_tax_included',
  'comm_untaxed', 'comm_tax', 'comm_total', 'purchase_total',
  'ar_deduction_untaxed', 'ar_deduction_tax', 'ar_rent_untaxed', 'ar_rent_tax', 'ar_total',
  'min_guarantee_short', 'ap_total_tax_inc'
];

/** 代扣表可為 null 的數值欄位 */
var FE_DEDUCTION_NUM_FIELDS = ['amount_untaxed', 'down_payment', 'monthly_amount', 'installment_periods', 'total_amount'];

/** 標準文案 */
var FE_TEXT = {
  NA_DENOMINATOR: 'N/A (基準期/分母為 0)',
  ZERO_SALES_RATE: '0.00% (當月銷貨為 0)',
  MISSING_AMOUNT: '表格無填寫金額',
  DEFAULT_FLOOR: '未分類樓層',
  DEFAULT_COUNTER_NAME: '未命名專櫃',
  SELF: '自營櫃',
  TENANT: '租戶'
};

/* ============================================================
 * 一、基礎工具（皆為 fe_ 前綴私有函式，避免全域命名衝突）
 * ============================================================ */

/** 取得錯誤碼常數（Config.ERR_CODES 為主，缺漏時使用標準字串） */
function fe_err_(key) {
  if (typeof ERR_CODES !== 'undefined' && ERR_CODES && ERR_CODES[key]) return ERR_CODES[key];
  return 'ERR_' + key;
}

function fe_ok_(moduleId, data) {
  return { ok: true, errorCode: null, errorMessage: null, moduleId: moduleId, data: data };
}

function fe_fail_(moduleId, errorCode, errorMessage, data) {
  return { ok: false, errorCode: errorCode, errorMessage: errorMessage, moduleId: moduleId, data: data || null };
}

/** 四捨五入至小數 2 位（對齊 Excel ROUND 遠離零規則，並消除浮點誤差） */
function fe_round2_(x) {
  var n = Number(x);
  if (!isFinite(n)) return null;
  var sign = n < 0 ? -1 : 1;
  var abs = Math.abs(n);
  var r = Math.round(Number((abs * 100).toPrecision(15))) / 100;
  return r === 0 ? 0 : sign * r;
}

/** 數值轉百分比字串（含正負號選項） */
function fe_pctText_(val, withSign) {
  var r = fe_round2_(val);
  if (r === null) return FE_TEXT.NA_DENOMINATOR;
  var s = r.toFixed(2) + '%';
  if (withSign && r > 0) s = '+' + s;
  return s;
}

/** 安全轉數值（null → 0） */
function fe_num0_(v) {
  if (typeof parseNumberOrZero === 'function') {
    var n = parseNumberOrZero(v);
    return isFinite(n) ? n : 0;
  }
  var x = Number(String(v === null || v === undefined ? '' : v).replace(/[,\s]/g, ''));
  return isFinite(x) ? x : 0;
}

/** 安全轉數值（空白 → null，不補 0） */
function fe_numOrNull_(v) {
  if (typeof parseNumberOrNull === 'function') {
    var n = parseNumberOrNull(v);
    return (n === null || n === undefined || !isFinite(n)) ? null : n;
  }
  if (v === null || v === undefined) return null;
  var s = String(v).replace(/[,\s]/g, '');
  if (s === '') return null;
  var x = Number(s);
  return isFinite(x) ? x : null;
}

/** 專櫃編號標準化 */
function fe_cid_(v) {
  if (typeof normalizeCounterId === 'function') return normalizeCounterId(v);
  if (v === null || v === undefined || String(v).trim() === '') return '';
  return String(v).trim().padStart(5, '0');
}

/** 年月標準化為 6 碼 YYYYMM 字串（無法辨識回傳 ''） */
function fe_normYm_(v) {
  if (typeof normalizeYearMonth === 'function') return normalizeYearMonth(v);
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, 'Asia/Taipei', 'yyyyMM');
  }
  var s = String(v).trim().replace(/[^0-9]/g, '');
  if (s.length < 6) return '';
  return s.slice(0, 6);
}

/** 日期標準化為 YYYY-MM-DD（無值回傳 ''） */
function fe_ymd_(v) {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  try {
    if (typeof formatDateYMD === 'function') {
      var r = formatDateYMD(v);
      if (r) return String(r);
    }
  } catch (e) { /* 忽略，改以原字串回傳 */ }
  return String(v).trim();
}

/** 文字欄位標準化 */
function fe_str_(v, defVal) {
  var s = (v === null || v === undefined) ? '' : String(v).trim();
  return s === '' ? (defVal === undefined ? '' : defVal) : s;
}

/** 樓層名稱解析：接受樓層原名或短代碼 */
function fe_resolveFloorName_(nameOrCode) {
  var s = fe_str_(nameOrCode, '');
  if (s === '') return '';
  if (typeof FLOOR_ORDER !== 'undefined' && FLOOR_ORDER && FLOOR_ORDER.indexOf(s) >= 0) return s;
  if (typeof decodeFloorCode === 'function') {
    try {
      var d = decodeFloorCode(s);
      if (d) return String(d);
    } catch (e) { /* 忽略 */ }
  }
  return s;
}

/** 年月位移（delta 個月），回傳 YYYYMM；輸入無效回傳 '' */
function shiftBillingYm(ym, deltaMonths) {
  var s = fe_normYm_(ym);
  if (!s) return '';
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(4, 6));
  if (!(m >= 1 && m <= 12)) return '';
  var total = y * 12 + (m - 1) + Number(deltaMonths || 0);
  var ny = Math.floor(total / 12);
  var nm = total - ny * 12 + 1;
  return String(ny) + (nm < 10 ? '0' + nm : String(nm));
}

/** 取得 Asia/Taipei 今日 YYYY-MM-DD */
function fe_todayYmd_() {
  if (typeof getTaipeiTodayYmd === 'function') return getTaipeiTodayYmd();
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
}

/** YYYY-MM-DD 轉 UTC 午夜毫秒（無效回傳 null） */
function fe_ymdToUtcMs_(ymd) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(ymd || '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 判斷布林欄位（支援 true / 'TRUE' / 'true'） */
function fe_bool_(v) {
  if (v === true) return true;
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase() === 'TRUE';
}

/* ============================================================
 * 二、CacheService 索引快取
 * ============================================================ */

function fe_cacheTtl_() {
  if (typeof CACHE_TTL_SECONDS !== 'undefined' && CACHE_TTL_SECONDS && CACHE_TTL_SECONDS.INDEX) {
    return CACHE_TTL_SECONDS.INDEX;
  }
  return 600;
}

function fe_cacheGet_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function fe_cachePut_(key, obj) {
  try {
    var raw = JSON.stringify(obj);
    // CacheService 單筆上限 100KB（以 UTF-8 位元組估算），超過即不快取
    var bytes = encodeURIComponent(raw).replace(/%[0-9A-F]{2}/gi, 'x').length;
    if (bytes > 95000) return;
    CacheService.getScriptCache().put(key, raw, fe_cacheTtl_());
  } catch (e) { /* 快取失敗不影響主流程 */ }
}

/* ============================================================
 * 三、Clean_DB 讀取與標準化
 * ============================================================ */

function fe_readSheet_(sheetKey) {
  try {
    var rows = readSheetObjects(SHEET_NAMES[sheetKey]);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('FormulaEngine 讀取分頁失敗：' + sheetKey + ' ' + e);
    return [];
  }
}

/** 讀取營運中專櫃主檔（標準化後） */
function fe_loadContracts_() {
  var raw = fe_readSheet_('CONTRACTS');
  var seen = {};
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i] || {};
    var cid = fe_cid_(r.counter_id);
    if (!cid || seen[cid]) continue;
    var status = fe_str_(r.status, '營運中');
    if (status !== '營運中') continue;
    seen[cid] = true;
    list.push({
      counter_id: cid,
      counter_name: fe_str_(r.counter_name, FE_TEXT.DEFAULT_COUNTER_NAME),
      version_no: fe_numOrNull_(r.version_no) === null ? 1 : fe_numOrNull_(r.version_no),
      status: status,
      floor_name: fe_str_(r.floor_name, FE_TEXT.DEFAULT_FLOOR),
      area_name: fe_str_(r.area_name, ''),
      booth_no: fe_str_(r.booth_no, '未登錄'),
      category_name: fe_str_(r.category_name, ''),
      op_start_date: fe_ymd_(r.op_start_date),
      op_end_date: fe_ymd_(r.op_end_date),
      commission_type: fe_str_(r.commission_type, '一般抽成'),
      tax_type: fe_str_(r.tax_type, '應稅'),
      regular_rate_summary: fe_str_(r.regular_rate_summary, '表格未設定正品抽成率')
    });
  }
  return list;
}

/** 讀取月結表（標準化後；數值欄位空白轉 0，因 ETL 已依公式計算） */
function fe_loadMonthly_() {
  var raw = fe_readSheet_('MONTHLY');
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i] || {};
    var cid = fe_cid_(r.counter_id);
    var ym = fe_normYm_(r.billing_ym);
    if (!cid || !ym) continue;
    var row = {
      data_source_type: fe_str_(r.data_source_type, 'MONTHLY_SETTLEMENT'),
      billing_ym: ym,
      counter_id: cid,
      counter_name: fe_str_(r.counter_name, FE_TEXT.DEFAULT_COUNTER_NAME),
      floor_name: fe_str_(r.floor_name, FE_TEXT.DEFAULT_FLOOR),
      coop_mode: fe_str_(r.coop_mode, ''),
      category_name: fe_str_(r.category_name, ''),
      expected_pay_date: fe_ymd_(r.expected_pay_date),
      billing_batch: fe_numOrNull_(r.billing_batch) === null ? 1 : fe_numOrNull_(r.billing_batch),
      is_duplicate_anomaly: fe_bool_(r.is_duplicate_anomaly)
    };
    for (var k = 0; k < FE_MONTHLY_NUM_FIELDS.length; k++) {
      var f = FE_MONTHLY_NUM_FIELDS[k];
      row[f] = fe_num0_(r[f]);
    }
    list.push(row);
  }
  return list;
}

/** 讀取代扣明細（數值欄位空白保留 null） */
function fe_loadDeductions_() {
  var raw = fe_readSheet_('DEDUCTIONS');
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i] || {};
    var cid = fe_cid_(r.counter_id);
    if (!cid) continue;
    var row = {
      counter_id: cid,
      deduct_category: fe_str_(r.deduct_category, ''),
      deduct_item_name: fe_str_(r.deduct_item_name, ''),
      start_ym: fe_normYm_(r.start_ym),
      end_ym: fe_normYm_(r.end_ym)
    };
    for (var k = 0; k < FE_DEDUCTION_NUM_FIELDS.length; k++) {
      var f = FE_DEDUCTION_NUM_FIELDS[k];
      row[f] = fe_numOrNull_(r[f]);
    }
    list.push(row);
  }
  return list;
}

/** 由月結資料取得不重複年月（新 → 舊） */
function fe_uniqueYmsDesc_(monthlyRows) {
  var set = {};
  for (var i = 0; i < monthlyRows.length; i++) set[monthlyRows[i].billing_ym] = true;
  return Object.keys(set).sort(function (a, b) { return Number(b) - Number(a); });
}

/** 缺檔標準文案 */
function fe_missingMonthText_(yms, availableYms) {
  var list = (availableYms && availableYms.length) ? availableYms.join('、') : '（尚無任何已建檔月份，請管理員先執行 ETL 同步）';
  return '📭 查無 ' + yms.join('、') + ' 數據。目前系統已建檔月份為：' + list + '。';
}

/** 查詢專櫃名稱（合約主檔 → 月結表最新一筆） */
function fe_lookupCounterInfo_(cid, contracts, monthly) {
  var info = { counter_id: cid, counter_name: '', floor_name: '', coop_mode: '' };
  var list = contracts || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].counter_id === cid) {
      info.counter_name = list[i].counter_name;
      info.floor_name = list[i].floor_name;
      break;
    }
  }
  if (monthly && (!info.counter_name || !info.floor_name)) {
    var latest = null;
    for (var j = 0; j < monthly.length; j++) {
      var m = monthly[j];
      if (m.counter_id !== cid) continue;
      if (!latest || Number(m.billing_ym) > Number(latest.billing_ym)) latest = m;
    }
    if (latest) {
      if (!info.counter_name) info.counter_name = latest.counter_name;
      if (!info.floor_name) info.floor_name = latest.floor_name;
      info.coop_mode = latest.coop_mode;
    }
  }
  if (!info.counter_name) info.counter_name = FE_TEXT.DEFAULT_COUNTER_NAME;
  if (!info.floor_name) info.floor_name = FE_TEXT.DEFAULT_FLOOR;
  return info;
}

/** 加總多筆月結列（回傳各數值欄位合計，四捨五入至 2 位消除浮點誤差） */
function fe_sumRows_(rows) {
  var t = {};
  for (var k = 0; k < FE_MONTHLY_NUM_FIELDS.length; k++) t[FE_MONTHLY_NUM_FIELDS[k]] = 0;
  for (var i = 0; i < rows.length; i++) {
    for (var k2 = 0; k2 < FE_MONTHLY_NUM_FIELDS.length; k2++) {
      var f = FE_MONTHLY_NUM_FIELDS[k2];
      t[f] += rows[i][f];
    }
  }
  for (var k3 = 0; k3 < FE_MONTHLY_NUM_FIELDS.length; k3++) {
    var f3 = FE_MONTHLY_NUM_FIELDS[k3];
    t[f3] = fe_round2_(t[f3]);
  }
  return t;
}

/* ============================================================
 * 四、快取索引（LINE 互動選單使用）
 * ============================================================ */

/** 取得營運中專櫃之不重複樓層（依商場自訂樓層順序排序） */
function getActiveFloors() {
  var cached = fe_cacheGet_(FE_INDEX_CACHE_KEYS.FLOORS);
  if (Array.isArray(cached)) return cached;
  var contracts = fe_loadContracts_();
  var set = {};
  for (var i = 0; i < contracts.length; i++) set[contracts[i].floor_name] = true;
  var floors = Object.keys(set);
  floors = (typeof sortFloors === 'function') ? sortFloors(floors) : floors.sort();
  fe_cachePut_(FE_INDEX_CACHE_KEYS.FLOORS, floors);
  return floors;
}

/** 取得全館「樓層 → 營運中專櫃清單」對照（內部共用） */
function fe_getCountersByFloorMap_() {
  var cached = fe_cacheGet_(FE_INDEX_CACHE_KEYS.COUNTERS_BY_FLOOR);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) return cached;
  var contracts = fe_loadContracts_();
  var map = {};
  for (var i = 0; i < contracts.length; i++) {
    var c = contracts[i];
    if (!map[c.floor_name]) map[c.floor_name] = [];
    map[c.floor_name].push({ counter_id: c.counter_id, counter_name: c.counter_name, booth_no: c.booth_no, floor_name: c.floor_name });
  }
  Object.keys(map).forEach(function (fl) {
    map[fl].sort(function (a, b) { return a.counter_id < b.counter_id ? -1 : (a.counter_id > b.counter_id ? 1 : 0); });
  });
  fe_cachePut_(FE_INDEX_CACHE_KEYS.COUNTERS_BY_FLOOR, map);
  return map;
}

/** 取得指定樓層營運中專櫃（依 counter_id 升冪） */
function getActiveCountersByFloor(floorName) {
  var fl = fe_resolveFloorName_(floorName);
  var map = fe_getCountersByFloorMap_();
  return (map[fl] || []).slice();
}

/** 取得 Clean_DB_Monthly 已建檔之不重複結帳年月（新 → 舊） */
function getAvailableBillingYMs() {
  var cached = fe_cacheGet_(FE_INDEX_CACHE_KEYS.BILLING_YMS);
  if (Array.isArray(cached)) return cached;
  var yms = fe_uniqueYmsDesc_(fe_loadMonthly_());
  fe_cachePut_(FE_INDEX_CACHE_KEYS.BILLING_YMS, yms);
  return yms;
}

/** 專櫃目錄（營運中合約 + 歷史月結專櫃），供關鍵字搜尋 */
function fe_getCounterDirectory_() {
  var cached = fe_cacheGet_(FE_INDEX_CACHE_KEYS.COUNTER_DIRECTORY);
  if (Array.isArray(cached)) return cached;
  var contracts = fe_loadContracts_();
  var dir = [];
  var seen = {};
  for (var i = 0; i < contracts.length; i++) {
    var c = contracts[i];
    seen[c.counter_id] = true;
    dir.push({ counter_id: c.counter_id, counter_name: c.counter_name, floor_name: c.floor_name, booth_no: c.booth_no, is_active: true });
  }
  var monthly = fe_loadMonthly_();
  var latest = {};
  for (var j = 0; j < monthly.length; j++) {
    var m = monthly[j];
    if (seen[m.counter_id]) continue;
    if (!latest[m.counter_id] || Number(m.billing_ym) > Number(latest[m.counter_id].billing_ym)) latest[m.counter_id] = m;
  }
  Object.keys(latest).forEach(function (cid) {
    var x = latest[cid];
    dir.push({ counter_id: cid, counter_name: x.counter_name, floor_name: x.floor_name, booth_no: '未登錄', is_active: false });
  });
  dir.sort(function (a, b) { return a.counter_id < b.counter_id ? -1 : (a.counter_id > b.counter_id ? 1 : 0); });
  fe_cachePut_(FE_INDEX_CACHE_KEYS.COUNTER_DIRECTORY, dir);
  return dir;
}

/**
 * 依關鍵字搜尋專櫃：精確 counter_id（經 normalizeCounterId）或專櫃名稱部分比對（不分大小寫）。
 * @return {Array<{counter_id, counter_name, floor_name, booth_no, is_active}>} 精確編號命中者排第一；營運中優先。
 */
function findCounterByKeyword(keyword) {
  var kw = fe_str_(keyword, '');
  if (kw === '') return [];
  var dir = fe_getCounterDirectory_();
  var results = [];
  var used = {};
  // 1) 精確編號比對（純數字且 <= 5 碼才嘗試補零）
  if (/^\d{1,5}$/.test(kw)) {
    var cid = fe_cid_(kw);
    for (var i = 0; i < dir.length; i++) {
      if (dir[i].counter_id === cid) { results.push(dir[i]); used[cid] = true; break; }
    }
  }
  // 2) 名稱部分比對（亦支援編號片段）
  var lower = kw.toLowerCase();
  var partial = [];
  for (var j = 0; j < dir.length; j++) {
    var d = dir[j];
    if (used[d.counter_id]) continue;
    if (String(d.counter_name).toLowerCase().indexOf(lower) >= 0) partial.push(d);
  }
  partial.sort(function (a, b) {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return a.counter_id < b.counter_id ? -1 : (a.counter_id > b.counter_id ? 1 : 0);
  });
  return results.concat(partial);
}

/* ============================================================
 * 五、模組 M1：單一專櫃月度營收與帳務速查
 * ============================================================ */

function calcM1SingleCounter(counterId, targetYm) {
  var MOD = 'M1';
  var cid = fe_cid_(counterId);
  var ym = fe_normYm_(targetYm);
  var monthly = fe_loadMonthly_();
  var yms = fe_uniqueYmsDesc_(monthly);

  if (!ym || yms.indexOf(ym) < 0) {
    var shown = ym || fe_str_(targetYm, '（未指定月份）');
    return fe_fail_(MOD, fe_err_('MISSING_MONTH'), fe_missingMonthText_([shown], yms),
      { targetYm: shown, missingYms: [shown], availableYms: yms, counterId: cid });
  }

  var rows = monthly.filter(function (r) { return r.counter_id === cid && r.billing_ym === ym; });
  if (!cid || rows.length === 0) {
    var info0 = fe_lookupCounterInfo_(cid, fe_loadContracts_(), monthly);
    var label = (cid || fe_str_(counterId, '（未指定專櫃）')) + ' ' + info0.counter_name;
    return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'),
      '📭 ' + label + ' 於 ' + ym + ' 無任何帳務紀錄，無法計算。',
      { counterId: cid, counterName: info0.counter_name, targetYm: ym, availableYms: yms });
  }

  rows.sort(function (a, b) { return a.billing_batch - b.billing_batch; });
  var t = fe_sumRows_(rows);
  var first = rows[0];

  // 綜合抽成率（對未稅 / 對含稅）
  var rateVsUntaxed, rateVsTaxIncluded, rateVsUntaxedValue = null, rateVsTaxIncludedValue = null;
  if (t.sales_untaxed <= 0) {
    rateVsUntaxed = FE_TEXT.ZERO_SALES_RATE;
    rateVsTaxIncluded = FE_TEXT.ZERO_SALES_RATE;
  } else {
    rateVsUntaxedValue = fe_round2_(t.comm_total / t.sales_untaxed * 100);
    rateVsUntaxed = rateVsUntaxedValue.toFixed(2) + '%';
    if (t.sales_tax_included > 0) {
      rateVsTaxIncludedValue = fe_round2_(t.comm_total / t.sales_tax_included * 100);
      rateVsTaxIncluded = rateVsTaxIncludedValue.toFixed(2) + '%';
    } else {
      rateVsTaxIncluded = FE_TEXT.NA_DENOMINATOR;
    }
  }

  var payDates = [];
  rows.forEach(function (r) { if (r.expected_pay_date && payDates.indexOf(r.expected_pay_date) < 0) payDates.push(r.expected_pay_date); });

  var dupCount = rows.length;
  var records = rows.map(function (r, idx) {
    var rec = { seq: idx + 1, billing_batch: r.billing_batch, expected_pay_date: r.expected_pay_date, coop_mode: r.coop_mode };
    FE_MONTHLY_NUM_FIELDS.forEach(function (f) { rec[f] = r[f]; });
    return rec;
  });

  return fe_ok_(MOD, {
    counterId: cid,
    counterName: first.counter_name,
    floorName: first.floor_name,
    coopMode: first.coop_mode || '未標示',
    categoryName: first.category_name,
    targetYm: ym,
    duplicateCount: dupCount,
    isDuplicate: dupCount >= 2,
    warningCode: dupCount >= 2 ? fe_err_('DUPLICATE_BATCH') : null,
    warning: dupCount >= 2 ? ('⚠️ 帳務異常預警：本月出現 ' + dupCount + ' 筆紀錄（以下金額為合併加總，並列明各筆）') : null,
    records: records,
    sales: {
      sales_untaxed: t.sales_untaxed,
      sales_tax: t.sales_tax,
      sales_tax_included: t.sales_tax_included
    },
    commission: {
      comm_total: t.comm_total,
      comm_untaxed: t.comm_untaxed,
      comm_tax: t.comm_tax,
      rateVsUntaxed: rateVsUntaxed,
      rateVsTaxIncluded: rateVsTaxIncluded,
      rateVsUntaxedValue: rateVsUntaxedValue,
      rateVsTaxIncludedValue: rateVsTaxIncludedValue
    },
    receivable: {
      ar_total: t.ar_total,
      ar_deduction_untaxed: t.ar_deduction_untaxed,
      ar_rent_untaxed: t.ar_rent_untaxed,
      ar_deduction_tax: t.ar_deduction_tax,
      ar_rent_tax: t.ar_rent_tax,
      ar_tax_total: fe_round2_(t.ar_deduction_tax + t.ar_rent_tax)
    },
    min_guarantee_short: t.min_guarantee_short,
    ap_total_tax_inc: t.ap_total_tax_inc,
    purchase_total: t.purchase_total,
    expected_pay_date: payDates.join('、')
  });
}

/* ============================================================
 * 六、模組 M2：全館 / 樓層彙總與 Top 10
 * ============================================================ */

/** 正規化範圍參數 */
function fe_normScope_(scope) {
  var s = fe_str_(scope, 'ALL').toUpperCase();
  if (s === 'ALL_STORE' || s === 'STORE') return 'ALL';
  if (s === 'FLOOR' || s === 'COUNTER') return s;
  return 'ALL';
}

/** 依專櫃彙總後產出群組統計與 Top 10 */
function fe_buildGroupStats_(groupKey, label, rows) {
  var byCounter = {};
  var order = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!byCounter[r.counter_id]) {
      byCounter[r.counter_id] = { counter_id: r.counter_id, counter_name: r.counter_name, floor_name: r.floor_name, rows: [] };
      order.push(r.counter_id);
    }
    byCounter[r.counter_id].rows.push(r);
  }
  var counters = order.map(function (cid) {
    var c = byCounter[cid];
    var t = fe_sumRows_(c.rows);
    return {
      counterId: cid, counterName: c.counter_name, floorName: c.floor_name,
      sales_untaxed: t.sales_untaxed, sales_tax_included: t.sales_tax_included,
      comm_total: t.comm_total, ar_total: t.ar_total, recordCount: c.rows.length
    };
  });
  var total = fe_sumRows_(rows);
  counters.sort(function (a, b) {
    if (b.sales_untaxed !== a.sales_untaxed) return b.sales_untaxed - a.sales_untaxed;
    return a.counterId < b.counterId ? -1 : (a.counterId > b.counterId ? 1 : 0);
  });
  var top10 = counters.slice(0, 10).map(function (c, idx) {
    var share = total.sales_untaxed > 0 ? fe_round2_(c.sales_untaxed / total.sales_untaxed * 100) : null;
    return {
      rank: idx + 1, counterId: c.counterId, counterName: c.counterName, floorName: c.floorName,
      sales_untaxed: c.sales_untaxed, sales_tax_included: c.sales_tax_included, comm_total: c.comm_total,
      sharePctValue: share,
      sharePct: share === null ? FE_TEXT.NA_DENOMINATOR : share.toFixed(2) + '%',
      isDuplicate: c.recordCount >= 2
    };
  });
  return {
    groupKey: groupKey,
    label: label,
    counterCount: counters.length,
    sum_sales_untaxed: total.sales_untaxed,
    sum_sales_tax_included: total.sales_tax_included,
    sum_comm_total: total.comm_total,
    sum_ar_total: total.ar_total,
    top10: top10
  };
}

function calcM2SummaryAndTop10(scope, floorName, targetYm, includeCombined) {
  var MOD = 'M2';
  var sc = fe_normScope_(scope);
  if (sc === 'COUNTER') sc = 'ALL';
  var ym = fe_normYm_(targetYm);
  var fl = sc === 'FLOOR' ? fe_resolveFloorName_(floorName) : '';
  var comb = includeCombined === true || includeCombined === 1 || includeCombined === '1' || includeCombined === 'true';
  var monthly = fe_loadMonthly_();
  var yms = fe_uniqueYmsDesc_(monthly);

  if (!ym || yms.indexOf(ym) < 0) {
    var shown = ym || fe_str_(targetYm, '（未指定月份）');
    return fe_fail_(MOD, fe_err_('MISSING_MONTH'), fe_missingMonthText_([shown], yms),
      { scope: sc, floorName: fl, targetYm: shown, missingYms: [shown], availableYms: yms, includeCombined: comb });
  }

  var rows = monthly.filter(function (r) { return r.billing_ym === ym && (sc !== 'FLOOR' || r.floor_name === fl); });
  if (rows.length === 0) {
    return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'),
      '📭 ' + (sc === 'FLOOR' ? (fl || '指定樓層') : '全館') + ' 於 ' + ym + ' 無任何帳務紀錄，無法計算。',
      { scope: sc, floorName: fl, targetYm: ym, availableYms: yms, includeCombined: comb });
  }

  var selfRows = rows.filter(function (r) { return r.coop_mode === FE_TEXT.SELF; });
  var tenantRows = rows.filter(function (r) { return r.coop_mode === FE_TEXT.TENANT; });
  var otherRows = rows.filter(function (r) { return r.coop_mode !== FE_TEXT.SELF && r.coop_mode !== FE_TEXT.TENANT; });

  var dupMap = {};
  rows.forEach(function (r) { dupMap[r.counter_id] = (dupMap[r.counter_id] || 0) + 1; });
  var duplicateCounters = Object.keys(dupMap).filter(function (k) { return dupMap[k] >= 2; })
    .map(function (k) { return { counterId: k, count: dupMap[k] }; });

  var data = {
    scope: sc,
    floorName: fl,
    scopeLabel: sc === 'FLOOR' ? fl : '全館',
    targetYm: ym,
    includeCombined: comb,
    selfOperated: fe_buildGroupStats_('SELF_OPERATED', '自營櫃', selfRows),
    tenant: fe_buildGroupStats_('TENANT_COUNTER', '專櫃(租戶)', tenantRows),
    other: otherRows.length ? fe_buildGroupStats_('OTHER', '未標示配合方式', otherRows) : null,
    combined: comb ? fe_buildGroupStats_('ALL_COMBINED', '全店合併', rows) : null,
    duplicateCounters: duplicateCounters,
    warningCode: duplicateCounters.length ? fe_err_('DUPLICATE_BATCH') : null,
    warning: duplicateCounters.length ? ('⚠️ 帳務異常預警：本月有 ' + duplicateCounters.length + ' 櫃出現 2 筆以上紀錄（已依專櫃合併加總）') : null
  };
  return fe_ok_(MOD, data);
}

/* ============================================================
 * 七、模組 M3：跨期比較（MoM / YoY）三線並陳
 * ============================================================ */

/** 單一指標成長比較 */
function fe_compareMetric_(curr, base) {
  var c = (curr === null || curr === undefined) ? null : fe_round2_(curr);
  var b = (base === null || base === undefined) ? null : fe_round2_(base);
  if (c === null || b === null) {
    return { curr: c, base: b, diff: null, growthValue: null, growthPct: 'N/A (該期無帳務紀錄)' };
  }
  var diff = fe_round2_(c - b);
  if (b > 0) {
    var g = fe_round2_((c - b) / b * 100);
    return { curr: c, base: b, diff: diff, growthValue: g, growthPct: fe_pctText_(g, true) };
  }
  return { curr: c, base: b, diff: diff, growthValue: null, growthPct: FE_TEXT.NA_DENOMINATOR };
}

/** 三指標比較（未稅營收 / 含稅總額 / 抽成額合計） */
function fe_compareTotals_(currTotals, baseTotals) {
  return {
    sales_untaxed: fe_compareMetric_(currTotals ? currTotals.sales_untaxed : null, baseTotals ? baseTotals.sales_untaxed : null),
    sales_tax_included: fe_compareMetric_(currTotals ? currTotals.sales_tax_included : null, baseTotals ? baseTotals.sales_tax_included : null),
    comm_total: fe_compareMetric_(currTotals ? currTotals.comm_total : null, baseTotals ? baseTotals.comm_total : null)
  };
}

function fe_countCounters_(rows) {
  var s = {};
  rows.forEach(function (r) { s[r.counter_id] = true; });
  return Object.keys(s).length;
}

/** 佔比（%），分母 <= 0 回傳 null */
function fe_share_(part, whole) {
  return whole > 0 ? fe_round2_(part / whole * 100) : null;
}

function calcM3PeriodComparison(scope, targetIdOrFloor, targetYm, baseYm) {
  var MOD = 'M3';
  var sc = fe_normScope_(scope);
  var ym1 = fe_normYm_(targetYm);
  var ym2 = fe_normYm_(baseYm);
  var monthly = fe_loadMonthly_();
  var yms = fe_uniqueYmsDesc_(monthly);

  var missing = [];
  var s1 = ym1 || fe_str_(targetYm, '（未指定比較月份）');
  var s2 = ym2 || fe_str_(baseYm, '（未指定基準月份）');
  if (!ym1 || yms.indexOf(ym1) < 0) missing.push(s1);
  if (!ym2 || yms.indexOf(ym2) < 0) missing.push(s2);
  if (missing.length) {
    return fe_fail_(MOD, fe_err_('MISSING_MONTH'), fe_missingMonthText_(missing, yms),
      { scope: sc, targetYm: s1, baseYm: s2, missingYms: missing, availableYms: yms });
  }

  var fl = sc === 'FLOOR' ? fe_resolveFloorName_(targetIdOrFloor) : '';
  var cid = sc === 'COUNTER' ? fe_cid_(targetIdOrFloor) : '';

  // 大盤線範圍：FLOOR 依該樓層；ALL / COUNTER 為全館
  var inMarket = function (r) { return sc !== 'FLOOR' || r.floor_name === fl; };
  var currRows = monthly.filter(function (r) { return r.billing_ym === ym1 && inMarket(r); });
  var baseRows = monthly.filter(function (r) { return r.billing_ym === ym2 && inMarket(r); });

  if (sc === 'FLOOR' && currRows.length === 0 && baseRows.length === 0) {
    return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'),
      '📭 ' + (fl || '指定樓層') + ' 於 ' + ym1 + ' 與 ' + ym2 + ' 皆無任何帳務紀錄，無法計算。',
      { scope: sc, floorName: fl, targetYm: ym1, baseYm: ym2, availableYms: yms });
  }

  var buildLine = function (key, label, filterFn) {
    var c = currRows.filter(filterFn);
    var b = baseRows.filter(filterFn);
    var ct = fe_sumRows_(c);
    var bt = fe_sumRows_(b);
    return {
      lineKey: key,
      label: label,
      currCounterCount: fe_countCounters_(c),
      baseCounterCount: fe_countCounters_(b),
      metrics: fe_compareTotals_(ct, bt),
      _currTotals: ct,
      _baseTotals: bt
    };
  };

  var selfLine = buildLine('SELF_OPERATED', '自營櫃總計', function (r) { return r.coop_mode === FE_TEXT.SELF; });
  var tenantLine = buildLine('TENANT_COUNTER', '專櫃(租戶)總計', function (r) { return r.coop_mode === FE_TEXT.TENANT; });
  var allLine = buildLine('ALL_COMBINED', '全店合併總計', function () { return true; });

  // 結構位移（以未稅營收計算自營 / 專櫃佔比，單位 ppt）
  var selfCurrShare = fe_share_(selfLine._currTotals.sales_untaxed, allLine._currTotals.sales_untaxed);
  var selfBaseShare = fe_share_(selfLine._baseTotals.sales_untaxed, allLine._baseTotals.sales_untaxed);
  var tenantCurrShare = fe_share_(tenantLine._currTotals.sales_untaxed, allLine._currTotals.sales_untaxed);
  var tenantBaseShare = fe_share_(tenantLine._baseTotals.sales_untaxed, allLine._baseTotals.sales_untaxed);
  var pptText = function (c, b) {
    if (c === null || b === null) return FE_TEXT.NA_DENOMINATOR;
    var d = fe_round2_(c - b);
    return (d > 0 ? '+' : '') + d.toFixed(2) + ' ppt';
  };
  var shareText = function (v) { return v === null ? FE_TEXT.NA_DENOMINATOR : v.toFixed(2) + '%'; };
  allLine.structureShift = {
    basis: 'sales_untaxed',
    selfShareCurr: selfCurrShare, selfShareBase: selfBaseShare,
    tenantShareCurr: tenantCurrShare, tenantShareBase: tenantBaseShare,
    selfShareCurrText: shareText(selfCurrShare), selfShareBaseText: shareText(selfBaseShare),
    tenantShareCurrText: shareText(tenantCurrShare), tenantShareBaseText: shareText(tenantBaseShare),
    selfShiftPpt: (selfCurrShare === null || selfBaseShare === null) ? null : fe_round2_(selfCurrShare - selfBaseShare),
    tenantShiftPpt: (tenantCurrShare === null || tenantBaseShare === null) ? null : fe_round2_(tenantCurrShare - tenantBaseShare),
    selfShiftText: pptText(selfCurrShare, selfBaseShare),
    tenantShiftText: pptText(tenantCurrShare, tenantBaseShare)
  };

  [selfLine, tenantLine, allLine].forEach(function (l) { delete l._currTotals; delete l._baseTotals; });

  // 單櫃區塊
  var counterBlock = null;
  if (sc === 'COUNTER') {
    var cCurr = monthly.filter(function (r) { return r.counter_id === cid && r.billing_ym === ym1; });
    var cBase = monthly.filter(function (r) { return r.counter_id === cid && r.billing_ym === ym2; });
    var info = fe_lookupCounterInfo_(cid, fe_loadContracts_(), monthly);
    if (!cid || (cCurr.length === 0 && cBase.length === 0)) {
      return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'),
        '📭 ' + (cid || fe_str_(targetIdOrFloor, '（未指定專櫃）')) + ' ' + info.counter_name + ' 於 ' + ym1 + ' 與 ' + ym2 + ' 皆無任何帳務紀錄，無法計算。',
        { scope: sc, counterId: cid, counterName: info.counter_name, targetYm: ym1, baseYm: ym2, availableYms: yms });
    }
    var sample = cCurr[0] || cBase[0];
    counterBlock = {
      counterId: cid,
      counterName: sample.counter_name || info.counter_name,
      floorName: sample.floor_name || info.floor_name,
      coopMode: sample.coop_mode || '未標示',
      hasCurr: cCurr.length > 0,
      hasBase: cBase.length > 0,
      currRecordCount: cCurr.length,
      baseRecordCount: cBase.length,
      metrics: fe_compareTotals_(cCurr.length ? fe_sumRows_(cCurr) : null, cBase.length ? fe_sumRows_(cBase) : null),
      note: (!cCurr.length ? ('該櫃於 ' + ym1 + ' 無帳務紀錄') : (!cBase.length ? ('該櫃於 ' + ym2 + ' 無帳務紀錄') : null))
    };
  }

  var mode = (ym2 === shiftBillingYm(ym1, -1)) ? 'MoM' : ((ym2 === shiftBillingYm(ym1, -12)) ? 'YoY' : 'CUSTOM');

  return fe_ok_(MOD, {
    scope: sc,
    floorName: fl,
    counterId: cid,
    scopeLabel: sc === 'FLOOR' ? fl : (sc === 'COUNTER' ? '單櫃（大盤：全館）' : '全館'),
    targetYm: ym1,
    baseYm: ym2,
    compareMode: mode,
    counterBlock: counterBlock,
    lines: [selfLine, tenantLine, allLine]
  });
}

/* ============================================================
 * 八、模組 M4：合約效期與正品抽成條件
 * ============================================================ */

/** 計算到期預警 */
function fe_contractAlert_(opEndDate, todayYmd) {
  var endMs = fe_ymdToUtcMs_(opEndDate);
  var todayMs = fe_ymdToUtcMs_(todayYmd);
  if (endMs === null || todayMs === null) {
    return { remainingDays: null, alertLevel: 'UNKNOWN', alertText: '表格無紀錄（營運截止日未填寫）' };
  }
  var days = Math.floor((endMs - todayMs) / 86400000);
  if (days < 0) return { remainingDays: days, alertLevel: 'OVERDUE', alertText: '🚨 合約已逾期 ' + Math.abs(days) + ' 天（請確認續約狀態）' };
  if (days <= 90) return { remainingDays: days, alertLevel: 'WARNING', alertText: '⚠️ 合約將於 ' + days + ' 天後到期' };
  return { remainingDays: days, alertLevel: 'NORMAL', alertText: '✅ 合約有效（剩餘 ' + days + ' 天）' };
}

function fe_contractView_(c, todayYmd) {
  var a = fe_contractAlert_(c.op_end_date, todayYmd);
  return {
    counterId: c.counter_id,
    counterName: c.counter_name,
    floorName: c.floor_name,
    areaName: c.area_name,
    boothNo: c.booth_no,
    categoryName: c.category_name,
    versionNo: c.version_no,
    status: c.status,
    opStartDate: c.op_start_date,
    opEndDate: c.op_end_date,
    commissionType: c.commission_type,
    taxType: c.tax_type,
    regularRateSummary: c.regular_rate_summary,
    remainingDays: a.remainingDays,
    alertLevel: a.alertLevel,
    alertText: a.alertText
  };
}

/**
 * @param {string|null} counterId 單櫃查詢時之專櫃編號
 * @param {boolean} expiringOnly true 時查詢全館剩餘天數 <= 90（含已逾期）之合約
 * @param {string=} todayYmdOverride 測試用：指定今日 YYYY-MM-DD
 */
function calcM4ContractAndCommission(counterId, expiringOnly, todayYmdOverride) {
  var MOD = 'M4';
  var today = fe_ymdToUtcMs_(todayYmdOverride) !== null ? String(todayYmdOverride).slice(0, 10) : fe_todayYmd_();
  var contracts = fe_loadContracts_();

  if (expiringOnly === true || expiringOnly === 'true' || expiringOnly === 1 || expiringOnly === '1') {
    var items = contracts.map(function (c) { return fe_contractView_(c, today); })
      .filter(function (v) { return v.remainingDays !== null && v.remainingDays <= 90; })
      .sort(function (a, b) { return a.remainingDays - b.remainingDays; });
    return fe_ok_(MOD, {
      mode: 'EXPIRING',
      todayYmd: today,
      count: items.length,
      overdueCount: items.filter(function (v) { return v.alertLevel === 'OVERDUE'; }).length,
      warningCount: items.filter(function (v) { return v.alertLevel === 'WARNING'; }).length,
      items: items
    });
  }

  var cid = fe_cid_(counterId);
  var hit = null;
  for (var i = 0; i < contracts.length; i++) {
    if (contracts[i].counter_id === cid) { hit = contracts[i]; break; }
  }
  if (!cid || !hit) {
    return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'),
      '📭 ' + (cid || fe_str_(counterId, '（未指定專櫃）')) + ' 查無營運中合約紀錄，無法查詢合約與抽成條件。',
      { mode: 'SINGLE', counterId: cid, todayYmd: today });
  }
  return fe_ok_(MOD, { mode: 'SINGLE', todayYmd: today, contract: fe_contractView_(hit, today) });
}

/* ============================================================
 * 九、模組 M5：專櫃代扣款明細檢核
 * ============================================================ */

/** 數值或缺值標記（M5 專用：null → 「表格無填寫金額」） */
function fe_amountOrMissing_(v) {
  if (v === null || v === undefined) return FE_TEXT.MISSING_AMOUNT;
  var r = fe_round2_(v);
  var neg = r < 0;
  var parts = Math.abs(r).toFixed(2).split('.');
  var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var dec = parts[1] === '00' ? '' : '.' + parts[1];
  return (neg ? '-' : '') + '$' + intPart + dec;
}

function calcM5DeductionDetails(counterId, targetYm) {
  var MOD = 'M5';
  var cid = fe_cid_(counterId);
  var ym = fe_normYm_(targetYm);
  if (!ym) {
    var yms0 = getAvailableBillingYMs();
    var shown = fe_str_(targetYm, '（未指定月份）');
    return fe_fail_(MOD, fe_err_('MISSING_MONTH'), fe_missingMonthText_([shown], yms0),
      { counterId: cid, targetYm: shown, missingYms: [shown], availableYms: yms0 });
  }
  var monthly = fe_loadMonthly_();
  var contracts = fe_loadContracts_();
  var info = fe_lookupCounterInfo_(cid, contracts, monthly);
  if (!cid) {
    return fe_fail_(MOD, fe_err_('NO_COUNTER_RECORD'), '📭 未指定專櫃編號，無法查詢代扣款明細。', { counterId: '', targetYm: ym });
  }

  var ymNum = Number(ym);
  var deductions = fe_loadDeductions_().filter(function (d) {
    return d.counter_id === cid && d.start_ym !== '' && d.end_ym !== '' &&
      Number(d.start_ym) <= ymNum && ymNum <= Number(d.end_ym);
  });

  var hasNull = false;
  var items = deductions.map(function (d, idx) {
    FE_DEDUCTION_NUM_FIELDS.forEach(function (f) { if (d[f] === null) hasNull = true; });
    return {
      seq: idx + 1,
      deductCategory: d.deduct_category || '未標示',
      deductItemName: d.deduct_item_name || '未命名項目',
      startYm: d.start_ym,
      endYm: d.end_ym,
      amount_untaxed: d.amount_untaxed,
      down_payment: d.down_payment,
      monthly_amount: d.monthly_amount,
      installment_periods: d.installment_periods,
      total_amount: d.total_amount,
      display: {
        amount_untaxed: fe_amountOrMissing_(d.amount_untaxed),
        down_payment: fe_amountOrMissing_(d.down_payment),
        monthly_amount: fe_amountOrMissing_(d.monthly_amount),
        installment_periods: d.installment_periods === null ? FE_TEXT.MISSING_AMOUNT : (String(d.installment_periods) + ' 期'),
        total_amount: fe_amountOrMissing_(d.total_amount)
      }
    };
  });

  var mRows = monthly.filter(function (r) { return r.counter_id === cid && r.billing_ym === ym; });
  var monthlyCheck;
  if (mRows.length === 0) {
    monthlyCheck = {
      hasRecord: false,
      ar_deduction_untaxed: null,
      recordCount: 0,
      note: '該櫃於 ' + ym + ' 無月結紀錄（Clean_DB_Monthly），無法交叉核對代扣款未稅合計。'
    };
  } else {
    var t = fe_sumRows_(mRows);
    monthlyCheck = {
      hasRecord: true,
      ar_deduction_untaxed: t.ar_deduction_untaxed,
      recordCount: mRows.length,
      note: '月結表代扣款未稅合計：' + fe_amountOrMissing_(t.ar_deduction_untaxed) + (mRows.length >= 2 ? '（⚠️ 本月出現 ' + mRows.length + ' 筆月結紀錄，已合併加總）' : '')
    };
  }

  return fe_ok_(MOD, {
    counterId: cid,
    counterName: info.counter_name,
    floorName: info.floor_name,
    targetYm: ym,
    itemCount: items.length,
    items: items,
    hasNullField: hasNull,
    nullFieldCode: hasNull ? fe_err_('NULL_FIELD') : null,
    monthlyCheck: monthlyCheck
  });
}
