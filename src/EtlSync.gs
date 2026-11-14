/**
 * EtlSync.gs
 * ------------------------------------------------------------------
 * 增量 ETL 引擎：掃描 Google Drive 指定資料夾中的 4 類 ERP 匯出報表，
 * 經 Drive API v3 轉檔（.xlsx → 暫存 Google 試算表，finally 強制刪除）後清洗寫入 Clean_DB。
 *
 * 設計重點：
 * 1. 純資料列解析函式（parse* / build*）僅依賴 Config.gs 清洗工具，可直接餵入 2D 陣列離線測試。
 * 2. 有效資料列一律以「項次(Col 0) 為正整數 且 專櫃編號(Col 1) 非空」判定，不寫死起始列。
 * 3. 樓層回填採全量（含已撤櫃 / 已作廢）合約表 → 抽成表 → 代扣表 → '未分類樓層'。
 * 本檔私有輔助函式一律以 etl 前綴並以底線結尾。
 */

/** Clean_DB 各分頁表頭（精確對齊 SDD 3.2） */
const SHEET_HEADERS = Object.freeze({
  Clean_DB_Contracts: Object.freeze([
    'counter_id', 'counter_name', 'version_no', 'status', 'floor_name', 'area_name', 'booth_no',
    'category_name', 'op_start_date', 'op_end_date', 'commission_type', 'tax_type', 'regular_rate_summary'
  ]),
  Clean_DB_Monthly: Object.freeze([
    'data_source_type', 'billing_ym', 'counter_id', 'counter_name', 'floor_name', 'coop_mode', 'category_name',
    'sales_untaxed', 'sales_tax', 'sales_tax_included', 'comm_untaxed', 'comm_tax', 'comm_total',
    'purchase_total', 'ar_deduction_untaxed', 'ar_deduction_tax', 'ar_rent_untaxed', 'ar_rent_tax', 'ar_total',
    'min_guarantee_short', 'ap_total_tax_inc', 'expected_pay_date', 'billing_batch', 'is_duplicate_anomaly'
  ]),
  Clean_DB_Deductions: Object.freeze([
    'counter_id', 'deduct_category', 'deduct_item_name', 'start_ym', 'end_ym', 'amount_untaxed',
    'down_payment', 'monthly_amount', 'installment_periods', 'total_amount'
  ]),
  Clean_DB_DailyPOS: Object.freeze([
    'data_source_type', 'pos_date', 'counter_id', 'coop_mode', 'sales_untaxed', 'sales_tax_included', 'tx_count'
  ]),
  ETL_Processed_Files: Object.freeze([
    'file_id', 'file_name', 'report_type', 'billing_ym', 'last_modified_time', 'synced_at'
  ]),
  Auth_Whitelist: Object.freeze([
    'line_user_id', 'manager_name', 'department', 'is_active', 'created_at'
  ]),
  Security_Audit_Log: Object.freeze([
    'timestamp', 'line_user_id', 'event_type', 'raw_payload', 'reject_reason'
  ])
});

/** 需設為純文字格式 '@' 的欄位（防止前導零流失與日期字串被自動轉型） */
const ETL_TEXT_COLUMNS = Object.freeze({
  Clean_DB_Contracts: ['counter_id', 'booth_no', 'op_start_date', 'op_end_date'],
  Clean_DB_Monthly: ['billing_ym', 'counter_id', 'expected_pay_date'],
  Clean_DB_Deductions: ['counter_id', 'start_ym', 'end_ym'],
  Clean_DB_DailyPOS: ['pos_date', 'counter_id'],
  ETL_Processed_Files: ['file_id', 'billing_ym', 'last_modified_time', 'synced_at'],
  Auth_Whitelist: ['line_user_id'],
  Security_Audit_Log: ['timestamp', 'line_user_id']
});

/** 由 ETL 全權管理（可覆寫表頭）的分頁；白名單與稽核日誌屬人工維護，不覆寫既有表頭 */
const ETL_MANAGED_SHEETS = Object.freeze([
  'Clean_DB_Contracts', 'Clean_DB_Monthly', 'Clean_DB_Deductions', 'Clean_DB_DailyPOS', 'ETL_Processed_Files'
]);

/** 4 類 ERP 報表類型代碼 */
const ETL_REPORT_TYPES = Object.freeze({
  CONTRACT: 'CONTRACT_STATUS',
  COMMISSION: 'COMMISSION',
  DEDUCTION: 'DEDUCTION',
  MONTHLY: 'MONTHLY_SETTLEMENT',
  UNKNOWN: 'UNKNOWN'
});

/** FormulaEngine 使用之索引快取 Key（ETL 完成後必須清除） */
const ETL_INDEX_CACHE_KEYS = Object.freeze([
  'IDX_FLOORS', 'IDX_COUNTERS_BY_FLOOR', 'IDX_BILLING_YMS', 'IDX_COUNTER_DIRECTORY'
]);

/** ETL 單次執行時間預算（GAS 上限 6 分鐘，預留 1 分鐘收尾） */
const ETL_MAX_RUNTIME_MS = 5 * 60 * 1000;

/** 支援的來源 MIME 類型 */
const ETL_MIME = Object.freeze({
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  XLS: 'application/vnd.ms-excel',
  GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet'
});

/** 預設值 */
const ETL_DEFAULTS = Object.freeze({
  COUNTER_NAME: '未命名專櫃',
  FLOOR: '未分類樓層',
  BOOTH: '未登錄',
  COMMISSION_TYPE: '一般抽成',
  TAX_TYPE: '應稅',
  NO_RATE: '表格未設定正品抽成率',
  ACTIVE_STATUS: '營運中'
});

// ==================================================================
// 一、通用小工具（私有）
// ==================================================================

/** 安全轉為去頭尾空白字串 */
function etlStr_(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/** 取 row[idx] 並轉字串 */
function etlCell_(row, idx) {
  return row && idx < row.length ? etlStr_(row[idx]) : '';
}

/** 取 row[idx] 原始值 */
function etlRaw_(row, idx) {
  return row && idx < row.length ? row[idx] : '';
}

/** 數值四捨五入至小數 2 位，消除浮點誤差 */
function etlRound2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** 多個欄位以 parseNumberOrZero 加總後四捨五入 */
function etlSumCols_(row, indexes) {
  let total = 0;
  for (let i = 0; i < indexes.length; i++) total += parseNumberOrZero(etlRaw_(row, indexes[i]));
  return etlRound2_(total);
}

/** 將多個連續空白壓縮為單一空白 */
function etlCollapseSpaces_(s) {
  return etlStr_(s).replace(/[\s\u3000]+/g, ' ');
}

/** 判斷傳入資料是否為原始 2D 陣列（需先解析） */
function etlIsRaw2D_(rows) {
  if (!Array.isArray(rows)) return false;
  for (let i = 0; i < rows.length; i++) {
    if (Array.isArray(rows[i])) return true;
  }
  return false;
}

/** 若為 2D 陣列則以 parser 解析，否則視為已解析之物件陣列 */
function etlEnsureParsed_(rows, parser) {
  if (!rows) return [];
  return etlIsRaw2D_(rows) ? parser(rows) : rows.filter(function (r) { return r && typeof r === 'object'; });
}

/** 穩定排序（保留原始相對順序） */
function etlStableSort_(arr, cmp) {
  return arr
    .map(function (v, i) { return { v: v, i: i }; })
    .sort(function (a, b) { return cmp(a.v, b.v) || a.i - b.i; })
    .map(function (x) { return x.v; });
}

/** 字串降冪比較（空字串視為最小） */
function etlCmpDesc_(a, b) {
  const sa = etlStr_(a);
  const sb = etlStr_(b);
  if (sa === sb) return 0;
  return sa < sb ? 1 : -1;
}

/** 錯誤訊息文字化 */
function etlErrMsg_(err) {
  return err && err.message ? err.message : String(err);
}

// ==================================================================
// 二、有效列判定與 4 類報表解析（純函式，可離線測試）
// ==================================================================

/**
 * 有效資料列判定：項次為正整數（>= 1）且專櫃編號非空。
 * 自動剔除雙層表頭、空白列與表尾「合計 / 列印人員 / 頁碼 1/1」。
 * @param {Array} row
 * @return {boolean}
 */
function isValidErpDataRow(row) {
  if (!Array.isArray(row) || row.length < 2) return false;
  const seqRaw = row[0];
  if (seqRaw === null || seqRaw === undefined || etlStr_(seqRaw) === '') return false;
  const seq = Number(typeof seqRaw === 'string' ? seqRaw.trim() : seqRaw);
  return Number.isInteger(seq) && seq >= 1 && normalizeCounterId(row[1]) !== '';
}

/**
 * 解析《合約狀態清單》。
 * Col 1 counter_id, 2 counter_name, 5 version_no, 6 category_name, 9 status, 12 合約截止日,
 * 13 op_start_date, 14 op_end_date, 15 booth_no, 16 floor_name, 17 area_name
 * @param {Array[]} values 原始 2D 陣列
 * @return {Object[]}
 */
function parseContractStatusRows(values) {
  return (values || []).filter(isValidErpDataRow).map(function (row) {
    return {
      seq: Number(row[0]),
      counter_id: normalizeCounterId(row[1]),
      counter_name: etlCell_(row, 2),
      version_no: parseNumberOrNull(etlRaw_(row, 5)),
      category_name: etlCell_(row, 6),
      status: etlCell_(row, 9),
      contract_end_date: formatDateYMD(etlRaw_(row, 12)),
      op_start_date: formatDateYMD(etlRaw_(row, 13)),
      op_end_date: formatDateYMD(etlRaw_(row, 14)),
      booth_no: etlCell_(row, 15),
      floor_name: etlCell_(row, 16),
      area_name: etlCell_(row, 17)
    };
  });
}

/**
 * 正品抽成率解析：支援 15、'15'、'15%'；儲存格若為百分比格式之小數（0 < n < 1，如 0.15）則換算為 15。
 * @param {*} val
 * @return {?number}
 */
function etlParseRate_(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    const hasPercent = val.indexOf('%') >= 0;
    const n = parseNumberOrNull(val.replace(/%/g, ''));
    if (n === null) return null;
    return hasPercent ? etlRound2_(n) : (n > 0 && n < 1 ? etlRound2_(n * 100) : etlRound2_(n));
  }
  const n = parseNumberOrNull(val);
  if (n === null) return null;
  return n > 0 && n < 1 ? etlRound2_(n * 100) : etlRound2_(n);
}

/**
 * 解析《專櫃契約抽成報表》。
 * Col 1 counter_id, 2 counter_name, 3 floor_name, 4 area_name, 5 category_name, 12 commission_type,
 * 13 抽成類別名稱, 14 tax_type, 15 start_date, 16 end_date, 17 正品
 * @param {Array[]} values
 * @return {Object[]}
 */
function parseCommissionRows(values) {
  return (values || []).filter(isValidErpDataRow).map(function (row) {
    return {
      seq: Number(row[0]),
      counter_id: normalizeCounterId(row[1]),
      counter_name: etlCell_(row, 2),
      floor_name: etlCell_(row, 3),
      area_name: etlCell_(row, 4),
      category_name: etlCell_(row, 5),
      commission_type: etlCell_(row, 12),
      commission_category_name: etlCollapseSpaces_(etlRaw_(row, 13)),
      tax_type: etlCell_(row, 14),
      start_date: formatDateYMD(etlRaw_(row, 15)),
      end_date: formatDateYMD(etlRaw_(row, 16)),
      regular_rate: etlParseRate_(etlRaw_(row, 17))
    };
  });
}

/**
 * 解析《專櫃契約代扣款報表》（含水平合併儲存格，採固定欄位索引）。
 * Col 1 counter_id, 2 counter_name, 5 floor_name, 8 area_name, 9 category_name, 18 deduct_category,
 * 19 deduct_item_name, 20 start_ym, 21 end_ym, 22 amount_untaxed, 24 down_payment, 25 monthly_amount,
 * 26 installment_periods, 27 total_amount（數值空白一律存 null，不補 0）
 * @param {Array[]} values
 * @return {Object[]}
 */
function parseDeductionRows(values) {
  return (values || []).filter(isValidErpDataRow).map(function (row) {
    return {
      seq: Number(row[0]),
      counter_id: normalizeCounterId(row[1]),
      counter_name: etlCell_(row, 2),
      floor_name: etlCell_(row, 5),
      area_name: etlCell_(row, 8),
      category_name: etlCell_(row, 9),
      deduct_category: etlCell_(row, 18),
      deduct_item_name: etlCollapseSpaces_(etlRaw_(row, 19)),
      start_ym: normalizeYearMonth(etlRaw_(row, 20)),
      end_ym: normalizeYearMonth(etlRaw_(row, 21)),
      amount_untaxed: parseNumberOrNull(etlRaw_(row, 22)),
      down_payment: parseNumberOrNull(etlRaw_(row, 24)),
      monthly_amount: parseNumberOrNull(etlRaw_(row, 25)),
      installment_periods: parseNumberOrNull(etlRaw_(row, 26)),
      total_amount: parseNumberOrNull(etlRaw_(row, 27))
    };
  });
}

/**
 * 由《專櫃結帳彙總表》標題列（如「結帳年月:202610 ~ 202610」）擷取單一結帳年月，作為 Col 3 空白時的備援。
 * @param {Array[]} values
 * @return {string} 'YYYYMM' 或 ''
 */
function etlExtractTitleYm_(values) {
  const limit = Math.min((values || []).length, 8);
  for (let r = 0; r < limit; r++) {
    const row = values[r] || [];
    for (let c = 0; c < Math.min(row.length, 3); c++) {
      const m = etlStr_(row[c]).match(/結帳年月\s*[:：]\s*(\d{6})(?:\s*[~～\-]\s*(\d{6}))?/);
      if (m) return !m[2] || m[1] === m[2] ? m[1] : '';
    }
  }
  return '';
}

/**
 * 解析《專櫃結帳彙總表》並計算雙軌公式（尚未回填樓層與重複標記）。
 * @param {Array[]} values
 * @return {Object[]}
 */
function parseMonthlySettlementRows(values) {
  const titleYm = etlExtractTitleYm_(values);
  return (values || []).filter(isValidErpDataRow).map(function (row) {
    return {
      seq: Number(row[0]),
      data_source_type: 'MONTHLY_SETTLEMENT',
      billing_ym: normalizeYearMonth(etlRaw_(row, 3)) || titleYm,
      counter_id: normalizeCounterId(row[1]),
      counter_name: etlCell_(row, 2),
      coop_mode: etlCell_(row, 31),
      category_name: etlCell_(row, 27),
      sales_untaxed: etlSumCols_(row, [4, 6]),
      sales_tax: etlSumCols_(row, [5]),
      sales_tax_included: etlSumCols_(row, [4, 5, 6]),
      comm_untaxed: etlSumCols_(row, [7, 9]),
      comm_tax: etlSumCols_(row, [8]),
      comm_total: etlSumCols_(row, [10]),
      purchase_total: etlSumCols_(row, [14]),
      ar_deduction_untaxed: etlSumCols_(row, [15, 17]),
      ar_deduction_tax: etlSumCols_(row, [16]),
      ar_rent_untaxed: etlSumCols_(row, [18]),
      ar_rent_tax: etlSumCols_(row, [19]),
      ar_total: etlSumCols_(row, [20]),
      min_guarantee_short: etlSumCols_(row, [21]),
      ap_total_tax_inc: etlSumCols_(row, [22]),
      expected_pay_date: formatDateYMD(etlRaw_(row, 23)),
      billing_batch: parseNumberOrNull(etlRaw_(row, 28)) || 1
    };
  });
}

/**
 * 依檔名判斷報表類型。
 * @param {string} fileName
 * @return {string} ETL_REPORT_TYPES 之一
 */
function detectReportTypeByName(fileName) {
  const name = etlStr_(fileName);
  if (name.indexOf('合約狀態清單') >= 0) return ETL_REPORT_TYPES.CONTRACT;
  if (name.indexOf('代扣款') >= 0) return ETL_REPORT_TYPES.DEDUCTION;
  if (name.indexOf('抽成報表') >= 0) return ETL_REPORT_TYPES.COMMISSION;
  if (name.indexOf('結帳彙總') >= 0) return ETL_REPORT_TYPES.MONTHLY;
  return ETL_REPORT_TYPES.UNKNOWN;
}

/**
 * 依表頭內容判斷報表類型（檔名無法辨識時的備援）。
 * @param {Array[]} values
 * @return {string} ETL_REPORT_TYPES 之一
 */
function detectReportTypeByHeaders(values) {
  const limit = Math.min((values || []).length, 12);
  let text = '';
  for (let r = 0; r < limit; r++) text += '|' + (values[r] || []).map(etlStr_).join('|');
  if (text.indexOf('租戶配合方式') >= 0 || text.indexOf('結帳帳次') >= 0) return ETL_REPORT_TYPES.MONTHLY;
  if (text.indexOf('扣款類別') >= 0 || text.indexOf('扣款項目名稱') >= 0) return ETL_REPORT_TYPES.DEDUCTION;
  if (text.indexOf('抽成類別名稱') >= 0) return ETL_REPORT_TYPES.COMMISSION;
  if (text.indexOf('租戶狀況') >= 0) return ETL_REPORT_TYPES.CONTRACT;
  return ETL_REPORT_TYPES.UNKNOWN;
}

// ==================================================================
// 三、跨表樓層對照與 Clean_DB 資料建構（純函式，可離線測試）
// ==================================================================

/**
 * 以全量（含已撤櫃 / 已作廢）合約表、抽成表、代扣表建立樓層與名稱對照表。
 * 樓層優先級：合約表 Col 16 → 抽成表 Col 3 → 代扣表 Col 5 → '未分類樓層'。
 * 同一表內同櫃多筆時，以期間最新者（截止日 / 結束月份降冪）之非空值優先。
 * 參數可為原始 2D 陣列或 parse* 解析後的物件陣列。
 * @param {Array} allContractRows
 * @param {Array} allCommissionRows
 * @param {Array} allDeductionRows
 * @return {{floorMap:Object<string,string>, nameMap:Object<string,string>}}
 */
function buildFloorLookupMap(allContractRows, allCommissionRows, allDeductionRows) {
  const contracts = etlStableSort_(etlEnsureParsed_(allContractRows, parseContractStatusRows), function (a, b) {
    return etlCmpDesc_(a.contract_end_date, b.contract_end_date) ||
      (parseNumberOrZero(b.version_no) - parseNumberOrZero(a.version_no));
  });
  const commissions = etlStableSort_(etlEnsureParsed_(allCommissionRows, parseCommissionRows), function (a, b) {
    return etlCmpDesc_(a.end_date, b.end_date) || etlCmpDesc_(a.start_date, b.start_date);
  });
  const deductions = etlStableSort_(etlEnsureParsed_(allDeductionRows, parseDeductionRows), function (a, b) {
    return etlCmpDesc_(a.end_ym, b.end_ym) || etlCmpDesc_(a.start_ym, b.start_ym);
  });

  const floorMap = {};
  const nameMap = {};
  const fill = function (list) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const cid = normalizeCounterId(r.counter_id);
      if (!cid) continue;
      const fl = etlStr_(r.floor_name);
      const nm = etlStr_(r.counter_name);
      if (fl && fl !== ETL_DEFAULTS.FLOOR && !floorMap[cid]) floorMap[cid] = fl;
      if (nm && !nameMap[cid]) nameMap[cid] = nm;
    }
  };
  // 依優先級依序填入：先到先得
  fill(contracts);
  fill(commissions);
  fill(deductions);

  // 所有出現過的專櫃皆需有樓層值，找不到者標為未分類
  [contracts, commissions, deductions].forEach(function (list) {
    list.forEach(function (r) {
      const cid = normalizeCounterId(r.counter_id);
      if (cid && !floorMap[cid]) floorMap[cid] = ETL_DEFAULTS.FLOOR;
    });
  });
  return { floorMap: floorMap, nameMap: nameMap };
}

/**
 * 查詢樓層（找不到回傳 '未分類樓層'）。
 * @param {{floorMap:Object}} floorLookup
 * @param {string} counterId
 * @return {string}
 */
function lookupFloorName(floorLookup, counterId) {
  const cid = normalizeCounterId(counterId);
  const map = floorLookup && floorLookup.floorMap ? floorLookup.floorMap : {};
  return (cid && map[cid]) ? map[cid] : ETL_DEFAULTS.FLOOR;
}

/** 抽成率數字格式化（最多 2 位小數、去除多餘 0） */
function etlFormatRateNumber_(n) {
  return String(etlRound2_(n));
}

/**
 * 依今日日期挑選某櫃適用之抽成紀錄：
 * 優先取有效期間涵蓋 todayYmd 者；若無則 fallback 取最新期間（終止日→開始日降冪最大者）之全部紀錄。
 * @param {Object[]} rows 同一櫃之抽成紀錄
 * @param {string} todayYmd
 * @return {Object[]}
 */
function etlPickCommissionRows_(rows, todayYmd) {
  if (!rows || rows.length === 0) return [];
  const covering = rows.filter(function (r) {
    const s = etlStr_(r.start_date);
    const e = etlStr_(r.end_date);
    return (s === '' || s <= todayYmd) && (e === '' || todayYmd <= e);
  });
  if (covering.length > 0) return covering;
  const sorted = etlStableSort_(rows.slice(), function (a, b) {
    return etlCmpDesc_(a.end_date, b.end_date) || etlCmpDesc_(a.start_date, b.start_date);
  });
  const best = sorted[0];
  return rows.filter(function (r) {
    return etlStr_(r.end_date) === etlStr_(best.end_date) && etlStr_(r.start_date) === etlStr_(best.start_date);
  });
}

/**
 * 彙整正品抽成率字串，例如 "(1) 寢具: 15% / (2) 日韓食品: 12%"；正品為空者略過，全無則回傳預設文字。
 * @param {Object[]} pickedRows
 * @return {string}
 */
function buildRegularRateSummary(pickedRows) {
  const seen = {};
  const parts = [];
  (pickedRows || []).forEach(function (r) {
    if (r.regular_rate === null || r.regular_rate === undefined || r.regular_rate === '') return;
    const rate = Number(r.regular_rate);
    if (!isFinite(rate)) return;
    const name = etlCollapseSpaces_(r.commission_category_name);
    const seg = (name ? name + ': ' : '') + etlFormatRateNumber_(rate) + '%';
    if (seen[seg]) return;
    seen[seg] = true;
    parts.push(seg);
  });
  return parts.length > 0 ? parts.join(' / ') : ETL_DEFAULTS.NO_RATE;
}

/**
 * 建立 Clean_DB_Contracts 資料：
 * 僅留 status === '營運中'；同 counter_id 依合約截止日降冪、再依版本編號降冪取最新 1 筆；
 * 彙整抽成表有效期間涵蓋今日（無則 fallback 最新期間）之正品抽成率。
 * @param {Array} allContractRows 原始 2D 陣列或已解析物件
 * @param {Array} allCommissionRows 原始 2D 陣列或已解析物件
 * @param {{floorMap:Object, nameMap:Object}=} floorLookup 若未提供則以合約 + 抽成表即時建立
 * @param {string=} todayYmd 'YYYY-MM-DD'，預設為台北今日
 * @return {Object[]} 依 counter_id 升冪排序
 */
function buildCleanContracts(allContractRows, allCommissionRows, floorLookup, todayYmd) {
  const contracts = etlEnsureParsed_(allContractRows, parseContractStatusRows);
  const commissions = etlEnsureParsed_(allCommissionRows, parseCommissionRows);
  const lookup = floorLookup || buildFloorLookupMap(contracts, commissions, []);
  const today = formatDateYMD(todayYmd) || getTaipeiTodayYmd();

  // 抽成紀錄依專櫃分組
  const commByCid = {};
  commissions.forEach(function (r) {
    const cid = normalizeCounterId(r.counter_id);
    if (!cid) return;
    (commByCid[cid] = commByCid[cid] || []).push(r);
  });

  // 營運中合約：依截止日、版本降冪後，每櫃取第 1 筆
  const active = etlStableSort_(contracts.filter(function (r) {
    return etlStr_(r.status) === ETL_DEFAULTS.ACTIVE_STATUS && normalizeCounterId(r.counter_id) !== '';
  }), function (a, b) {
    return etlCmpDesc_(a.contract_end_date, b.contract_end_date) ||
      (parseNumberOrZero(b.version_no) - parseNumberOrZero(a.version_no));
  });

  const picked = {};
  const order = [];
  active.forEach(function (r) {
    const cid = normalizeCounterId(r.counter_id);
    if (picked[cid]) return;
    picked[cid] = r;
    order.push(cid);
  });

  const nameMap = lookup && lookup.nameMap ? lookup.nameMap : {};
  return order.sort().map(function (cid) {
    const c = picked[cid];
    const commRows = commByCid[cid] || [];
    const chosen = etlPickCommissionRows_(commRows, today);
    const firstComm = chosen[0] || commRows[0] || {};
    const contractFloor = etlStr_(c.floor_name);
    const version = parseNumberOrNull(c.version_no);
    return {
      counter_id: cid,
      counter_name: etlStr_(c.counter_name) || etlStr_(nameMap[cid]) || etlStr_(firstComm.counter_name) || ETL_DEFAULTS.COUNTER_NAME,
      version_no: version === null ? 1 : version,
      status: ETL_DEFAULTS.ACTIVE_STATUS,
      floor_name: contractFloor || lookupFloorName(lookup, cid),
      area_name: etlStr_(c.area_name) || etlStr_(firstComm.area_name),
      booth_no: etlStr_(c.booth_no) || ETL_DEFAULTS.BOOTH,
      category_name: etlStr_(c.category_name) || etlStr_(firstComm.category_name),
      op_start_date: formatDateYMD(c.op_start_date),
      op_end_date: formatDateYMD(c.op_end_date),
      commission_type: etlStr_(firstComm.commission_type) || ETL_DEFAULTS.COMMISSION_TYPE,
      tax_type: etlStr_(firstComm.tax_type) || ETL_DEFAULTS.TAX_TYPE,
      regular_rate_summary: buildRegularRateSummary(chosen)
    };
  });
}

/**
 * 建立 Clean_DB_Deductions 資料（僅保留 SDD 3.2 定義之 10 欄，數值空白存 null）。
 * @param {Array} rawDeductionRows 原始 2D 陣列或已解析物件
 * @return {Object[]}
 */
function buildCleanDeductionRows(rawDeductionRows) {
  return etlEnsureParsed_(rawDeductionRows, parseDeductionRows)
    .filter(function (r) { return normalizeCounterId(r.counter_id) !== ''; })
    .map(function (r) {
      return {
        counter_id: normalizeCounterId(r.counter_id),
        deduct_category: etlStr_(r.deduct_category),
        deduct_item_name: etlStr_(r.deduct_item_name),
        start_ym: normalizeYearMonth(r.start_ym),
        end_ym: normalizeYearMonth(r.end_ym),
        amount_untaxed: parseNumberOrNull(r.amount_untaxed),
        down_payment: parseNumberOrNull(r.down_payment),
        monthly_amount: parseNumberOrNull(r.monthly_amount),
        installment_periods: parseNumberOrNull(r.installment_periods),
        total_amount: parseNumberOrNull(r.total_amount)
      };
    });
}

/**
 * 標記同 billing_ym + counter_id 出現 >= 2 筆之列 is_duplicate_anomaly = true（就地修改並回傳）。
 * @param {Object[]} monthlyRows
 * @return {Object[]}
 */
function markDuplicateAnomalies(monthlyRows) {
  const counts = {};
  (monthlyRows || []).forEach(function (r) {
    const key = etlStr_(r.billing_ym) + '|' + normalizeCounterId(r.counter_id);
    counts[key] = (counts[key] || 0) + 1;
  });
  (monthlyRows || []).forEach(function (r) {
    const key = etlStr_(r.billing_ym) + '|' + normalizeCounterId(r.counter_id);
    r.is_duplicate_anomaly = counts[key] >= 2;
  });
  return monthlyRows || [];
}

/**
 * 建立 Clean_DB_Monthly 資料：雙軌公式計算、全量樓層回填、名稱補齊與重複帳次標記。
 * 結帳年月無法辨識之列將被略過（無法供查詢）。
 * @param {Array} rawMonthlyRows 原始 2D 陣列或 parseMonthlySettlementRows 結果
 * @param {{floorMap:Object, nameMap:Object}=} floorLookup
 * @return {Object[]}
 */
function buildCleanMonthlyRows(rawMonthlyRows, floorLookup) {
  const parsed = etlEnsureParsed_(rawMonthlyRows, parseMonthlySettlementRows);
  const nameMap = floorLookup && floorLookup.nameMap ? floorLookup.nameMap : {};
  const rows = [];
  parsed.forEach(function (r) {
    const cid = normalizeCounterId(r.counter_id);
    const ym = normalizeYearMonth(r.billing_ym);
    if (!cid || !ym) return;
    const out = {};
    SHEET_HEADERS.Clean_DB_Monthly.forEach(function (h) {
      out[h] = r[h] === undefined ? '' : r[h];
    });
    out.data_source_type = etlStr_(r.data_source_type) || 'MONTHLY_SETTLEMENT';
    out.billing_ym = ym;
    out.counter_id = cid;
    out.counter_name = etlStr_(r.counter_name) || etlStr_(nameMap[cid]) || ETL_DEFAULTS.COUNTER_NAME;
    out.floor_name = lookupFloorName(floorLookup, cid);
    out.coop_mode = etlStr_(r.coop_mode);
    out.category_name = etlStr_(r.category_name);
    out.expected_pay_date = formatDateYMD(r.expected_pay_date);
    out.billing_batch = parseNumberOrNull(r.billing_batch) || 1;
    out.is_duplicate_anomaly = false;
    rows.push(out);
  });
  return markDuplicateAnomalies(rows);
}

/**
 * 增量合併月結資料：新檔涵蓋之 billing_ym 整月覆寫既有資料，其餘月份保留。
 * @param {Object[]} existingRows Clean_DB_Monthly 既有資料
 * @param {Object[]} newRows buildCleanMonthlyRows 結果
 * @return {Object[]} 合併後（已重新標記重複帳次）
 */
function mergeMonthlyRows(existingRows, newRows) {
  const replaceYms = {};
  (newRows || []).forEach(function (r) { replaceYms[normalizeYearMonth(r.billing_ym)] = true; });
  const kept = (existingRows || []).filter(function (r) {
    const ym = normalizeYearMonth(r.billing_ym);
    return ym && !replaceYms[ym];
  });
  return markDuplicateAnomalies(kept.concat(newRows || []));
}

// ==================================================================
// 四、試算表寫入工具
// ==================================================================

/**
 * 冪等建立 Clean_DB 所有分頁與表頭，並將關鍵欄位設為純文字格式 '@'。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet=} ss 預設為 getCleanDbSpreadsheet()
 * @return {{created:string[], headerFixed:string[]}}
 */
function initCleanDbSheets(ss) {
  const book = ss || getCleanDbSpreadsheet();
  const created = [];
  const headerFixed = [];
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    const headers = SHEET_HEADERS[name];
    let sheet = book.getSheetByName(name);
    if (!sheet) {
      sheet = book.insertSheet(name);
      created.push(name);
    }
    const lastCol = sheet.getLastColumn();
    const current = lastCol > 0
      ? sheet.getRange(1, 1, 1, Math.max(lastCol, headers.length)).getValues()[0].map(etlStr_)
      : [];
    const isBlank = current.every(function (v) { return v === ''; });
    const matches = headers.every(function (h, i) { return current[i] === h; });
    if (isBlank || (!matches && ETL_MANAGED_SHEETS.indexOf(name) >= 0)) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
      if (!isBlank) headerFixed.push(name);
    } else if (!matches) {
      Logger.log('[ETL] 分頁「' + name + '」表頭與規格不一致（屬人工維護分頁，未自動覆寫），請手動確認。');
    }
    etlApplyTextFormat_(sheet, name, 2, Math.max(sheet.getMaxRows() - 1, 1));
    try {
      sheet.setFrozenRows(1);
    } catch (err) {
      // 凍結失敗不影響功能
    }
  });
  return { created: created, headerFixed: headerFixed };
}

/**
 * 將指定分頁的文字欄位設為 '@' 純文字格式。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} sheetName
 * @param {number} startRow
 * @param {number} numRows
 */
function etlApplyTextFormat_(sheet, sheetName, startRow, numRows) {
  const headers = SHEET_HEADERS[sheetName] || [];
  const textCols = ETL_TEXT_COLUMNS[sheetName] || [];
  if (numRows < 1) return;
  textCols.forEach(function (col) {
    const idx = headers.indexOf(col);
    if (idx < 0) return;
    sheet.getRange(startRow, idx + 1, numRows, 1).setNumberFormat('@');
  });
}

/**
 * 以表頭順序整批覆寫分頁資料（保留第 1 列表頭；null / undefined 寫入 ''）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} sheetName
 * @param {Object[]} objects
 * @return {number} 寫入筆數
 */
function etlOverwriteSheet_(ss, sheetName, objects) {
  const headers = SHEET_HEADERS[sheetName];
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
  }
  const list = objects || [];
  if (list.length === 0) return 0;
  const textCols = ETL_TEXT_COLUMNS[sheetName] || [];
  const data = list.map(function (o) {
    return headers.map(function (h) {
      const v = o[h];
      if (v === null || v === undefined) return '';
      // 文字欄位一律轉字串，確保前導零與 YYYYMM 不被轉型
      return textCols.indexOf(h) >= 0 ? String(v) : v;
    });
  });
  etlApplyTextFormat_(sheet, sheetName, 2, data.length);
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  return data.length;
}

/**
 * 清除 FormulaEngine 索引快取（ETL 完成後呼叫）。
 */
function clearIndexCache() {
  try {
    CacheService.getScriptCache().removeAll(ETL_INDEX_CACHE_KEYS.slice());
  } catch (err) {
    Logger.log('[ETL] 清除索引快取失敗：' + etlErrMsg_(err));
  }
}

// ==================================================================
// 五、Google Drive 檔案存取（Drive API v3 轉檔）
// ==================================================================

/**
 * 列出資料夾內支援的報表檔（.xlsx / .xls / Google 試算表）。
 * @param {string} folderId
 * @return {Object[]} [{id, name, mimeType, lastModified(ISO), file}]
 */
function etlListSourceFiles_(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const iter = folder.getFiles();
  const out = [];
  while (iter.hasNext()) {
    const f = iter.next();
    try {
      if (typeof f.isTrashed === 'function' && f.isTrashed()) continue;
    } catch (err) {
      // 忽略
    }
    const mime = etlStr_(f.getMimeType());
    if (mime !== ETL_MIME.XLSX && mime !== ETL_MIME.XLS && mime !== ETL_MIME.GOOGLE_SHEETS) continue;
    const updated = f.getLastUpdated();
    out.push({
      id: f.getId(),
      name: f.getName(),
      mimeType: mime,
      lastModified: updated && typeof updated.toISOString === 'function' ? updated.toISOString() : etlStr_(updated),
      file: f
    });
  }
  return out;
}

/**
 * 刪除暫存轉檔試算表（Drive v3：Files.remove / Files.delete；失敗時改丟垃圾桶）。
 * @param {string} tempFileId
 */
function etlDeleteTempFile_(tempFileId) {
  if (!tempFileId) return;
  try {
    if (Drive.Files && typeof Drive.Files.remove === 'function') {
      Drive.Files.remove(tempFileId);
    } else {
      Drive.Files['delete'](tempFileId);
    }
  } catch (err) {
    Logger.log('[ETL] Drive API 刪除暫存檔失敗，改以 DriveApp 移至垃圾桶：' + etlErrMsg_(err));
    try {
      DriveApp.getFileById(tempFileId).setTrashed(true);
    } catch (err2) {
      Logger.log('[ETL] 暫存檔清除失敗（請手動刪除 ' + tempFileId + '）：' + etlErrMsg_(err2));
    }
  }
}

/**
 * 讀取來源檔第一個工作表的全部儲存格值。
 * .xlsx / .xls 以 Drive.Files.create 轉為暫存 Google 試算表，並於 finally 強制刪除暫存檔。
 * @param {{id:string, name:string, mimeType:string, file:Object}} fileInfo
 * @return {Array[]}
 */
function etlLoadFileValues_(fileInfo) {
  const sheetsMime = (typeof MimeType !== 'undefined' && MimeType && MimeType.GOOGLE_SHEETS) || ETL_MIME.GOOGLE_SHEETS;
  if (fileInfo.mimeType === ETL_MIME.GOOGLE_SHEETS) {
    return SpreadsheetApp.openById(fileInfo.id).getSheets()[0].getDataRange().getValues();
  }
  let tempFileId = null;
  try {
    const blob = fileInfo.file ? fileInfo.file.getBlob() : DriveApp.getFileById(fileInfo.id).getBlob();
    const created = Drive.Files.create({
      name: '[ETL_TMP] ' + fileInfo.name,
      mimeType: sheetsMime
    }, blob);
    tempFileId = created && created.id ? created.id : null;
    if (!tempFileId) throw new Error('Drive.Files.create 未回傳暫存檔 ID：' + fileInfo.name);
    return SpreadsheetApp.openById(tempFileId).getSheets()[0].getDataRange().getValues();
  } finally {
    // 不論成功或拋錯，皆強制刪除暫存轉檔試算表，避免塞爆雲端硬碟
    etlDeleteTempFile_(tempFileId);
  }
}

/**
 * 判斷檔案是否已處理且未異動（比對 file_id + last_modified_time）。
 * @param {Object} fileInfo
 * @param {Object<string,Object>} processedMap
 * @return {boolean}
 */
function etlIsUnchanged_(fileInfo, processedMap) {
  const rec = processedMap[fileInfo.id];
  if (!rec) return false;
  const stored = rec.last_modified_time;
  if (etlStr_(stored) === etlStr_(fileInfo.lastModified)) return true;
  const t1 = new Date(stored).getTime();
  const t2 = new Date(fileInfo.lastModified).getTime();
  return isFinite(t1) && isFinite(t2) && t1 === t2;
}

// ==================================================================
// 六、增量 ETL 主程序
// ==================================================================

/**
 * 增量同步並清洗 ERP 報表（可設定時間驅動觸發器或由管理員手動執行）。
 * 流程：LockService 併發鎖 → 掃描資料夾 → 比對 ETL_Processed_Files → 轉檔讀取 →
 *       全量樓層對照 → 覆寫 Contracts / Deductions → 月結依年月增量覆寫 → 更新索引 → 清除快取。
 * @return {{ok:boolean, message:string, changedFiles:Object[], skippedCount:number, errors:string[],
 *           contractsCount:?number, deductionsCount:?number, monthlyCount:?number, monthlyYms:string[]}}
 */
function syncAndCleanErpReports() {
  const startMs = Date.now();
  const summary = {
    ok: false,
    message: '',
    changedFiles: [],
    skippedCount: 0,
    errors: [],
    contractsCount: null,
    deductionsCount: null,
    monthlyCount: null,
    monthlyYms: []
  };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    summary.message = '另一個 ETL 同步作業正在執行中，請稍後再試。';
    Logger.log('[ETL] ' + summary.message);
    return summary;
  }

  try {
    const cfg = getAppConfig();
    if (!cfg.RAW_ERP_DRIVE_FOLDER_ID) {
      throw new Error('尚未設定指令碼屬性 RAW_ERP_DRIVE_FOLDER_ID。');
    }
    const ss = getCleanDbSpreadsheet();
    initCleanDbSheets(ss);

    // 1) 讀取增量索引
    const processedRows = readSheetObjects(SHEET_NAMES.ETL_FILES, ss);
    const processedMap = {};
    processedRows.forEach(function (r) {
      const id = etlStr_(r.file_id);
      if (id) processedMap[id] = r;
    });

    // 2) 掃描資料夾並判斷報表類型
    const files = etlListSourceFiles_(cfg.RAW_ERP_DRIVE_FOLDER_ID);
    const valuesCache = {};
    const loadValues = function (fi) {
      if (!valuesCache[fi.id]) valuesCache[fi.id] = etlLoadFileValues_(fi);
      return valuesCache[fi.id];
    };

    const changed = [];
    files.forEach(function (fi) {
      const unchanged = etlIsUnchanged_(fi, processedMap);
      let type = detectReportTypeByName(fi.name);
      if (type === ETL_REPORT_TYPES.UNKNOWN && unchanged) {
        type = etlStr_(processedMap[fi.id].report_type) || ETL_REPORT_TYPES.UNKNOWN;
      }
      fi.reportType = type;
      if (unchanged) {
        summary.skippedCount++;
      } else {
        changed.push(fi);
      }
    });

    if (changed.length === 0) {
      summary.ok = true;
      summary.message = '沒有新增或異動的報表檔，略過同步。';
      Logger.log('[ETL] ' + summary.message);
      return summary;
    }

    // 3) 檔名無法辨識之異動檔，改以表頭內容判斷
    changed.forEach(function (fi) {
      if (fi.reportType !== ETL_REPORT_TYPES.UNKNOWN) return;
      try {
        fi.reportType = detectReportTypeByHeaders(loadValues(fi));
      } catch (err) {
        fi.loadError = etlErrMsg_(err);
        summary.errors.push('讀取檔案失敗「' + fi.name + '」：' + fi.loadError);
      }
    });

    // 4) 主檔（合約 / 抽成 / 代扣）各取最新修改之檔案
    const byNewest = function (a, b) { return etlCmpDesc_(a.lastModified, b.lastModified); };
    const latestOf = function (type) {
      const list = files.filter(function (f) { return f.reportType === type && !f.loadError; }).sort(byNewest);
      return list.length > 0 ? list[0] : null;
    };
    const masterTypes = [ETL_REPORT_TYPES.CONTRACT, ETL_REPORT_TYPES.COMMISSION, ETL_REPORT_TYPES.DEDUCTION];
    const masterChanged = changed.some(function (f) { return masterTypes.indexOf(f.reportType) >= 0; });
    const masterValues = {};
    const masterFile = {};
    masterTypes.forEach(function (type) {
      const fi = latestOf(type);
      masterFile[type] = fi;
      masterValues[type] = null;
      if (!fi) return;
      try {
        masterValues[type] = loadValues(fi);
      } catch (err) {
        fi.loadError = etlErrMsg_(err);
        summary.errors.push('讀取主檔失敗「' + fi.name + '」：' + fi.loadError);
      }
    });

    const contractParsed = masterValues[ETL_REPORT_TYPES.CONTRACT] ? parseContractStatusRows(masterValues[ETL_REPORT_TYPES.CONTRACT]) : [];
    const commissionParsed = masterValues[ETL_REPORT_TYPES.COMMISSION] ? parseCommissionRows(masterValues[ETL_REPORT_TYPES.COMMISSION]) : [];
    const deductionParsed = masterValues[ETL_REPORT_TYPES.DEDUCTION] ? parseDeductionRows(masterValues[ETL_REPORT_TYPES.DEDUCTION]) : [];
    const floorLookup = buildFloorLookupMap(contractParsed, commissionParsed, deductionParsed);

    // 5) 主檔異動時重建 Contracts 與 Deductions（全量覆寫）
    if (masterChanged) {
      if (masterValues[ETL_REPORT_TYPES.CONTRACT]) {
        const cleanContracts = buildCleanContracts(contractParsed, commissionParsed, floorLookup, getTaipeiTodayYmd());
        summary.contractsCount = etlOverwriteSheet_(ss, SHEET_NAMES.CONTRACTS, cleanContracts);
      }
      if (masterValues[ETL_REPORT_TYPES.DEDUCTION]) {
        summary.deductionsCount = etlOverwriteSheet_(ss, SHEET_NAMES.DEDUCTIONS, buildCleanDeductionRows(deductionParsed));
      }
    }

    // 6) 月結報表：依修改時間由舊到新增量覆寫（同年月以較新檔為準）
    const monthlyChanged = changed
      .filter(function (f) { return f.reportType === ETL_REPORT_TYPES.MONTHLY && !f.loadError; })
      .sort(function (a, b) { return -byNewest(a, b); });
    const handledMonthly = {};
    let monthlyRows = null;
    if (monthlyChanged.length > 0 || masterChanged) {
      monthlyRows = readSheetObjects(SHEET_NAMES.MONTHLY, ss).map(function (r) {
        r.counter_id = normalizeCounterId(r.counter_id);
        r.billing_ym = normalizeYearMonth(r.billing_ym);
        return r;
      });
    }
    monthlyChanged.forEach(function (fi) {
      if (Date.now() - startMs > ETL_MAX_RUNTIME_MS) {
        summary.errors.push('已達執行時間預算，「' + fi.name + '」將於下次同步處理。');
        return;
      }
      try {
        const newRows = buildCleanMonthlyRows(loadValues(fi), floorLookup);
        const yms = {};
        newRows.forEach(function (r) { yms[r.billing_ym] = true; });
        fi.billingYms = Object.keys(yms).sort();
        monthlyRows = mergeMonthlyRows(monthlyRows, newRows);
        handledMonthly[fi.id] = true;
      } catch (err) {
        fi.loadError = etlErrMsg_(err);
        summary.errors.push('處理月結報表失敗「' + fi.name + '」：' + fi.loadError);
      }
    });

    if (monthlyRows) {
      // 主檔更新後，以最新全量樓層對照回填既有月結資料之樓層與空白名稱
      if (masterChanged) {
        monthlyRows.forEach(function (r) {
          const cid = r.counter_id;
          if (floorLookup.floorMap[cid]) r.floor_name = floorLookup.floorMap[cid];
          if (!etlStr_(r.counter_name) && floorLookup.nameMap[cid]) r.counter_name = floorLookup.nameMap[cid];
        });
      }
      monthlyRows = markDuplicateAnomalies(monthlyRows.filter(function (r) {
        return r.counter_id && r.billing_ym;
      }));
      monthlyRows = etlStableSort_(monthlyRows, function (a, b) {
        return etlCmpDesc_(a.billing_ym, b.billing_ym) || (a.counter_id < b.counter_id ? -1 : (a.counter_id > b.counter_id ? 1 : 0));
      });
      summary.monthlyCount = etlOverwriteSheet_(ss, SHEET_NAMES.MONTHLY, monthlyRows);
      const ymSet = {};
      monthlyRows.forEach(function (r) { ymSet[r.billing_ym] = true; });
      summary.monthlyYms = Object.keys(ymSet).sort().reverse();
    }

    // 7) 更新增量索引（僅記錄成功處理之檔案）
    const syncedAt = new Date().toISOString();
    changed.forEach(function (fi) {
      if (fi.loadError) return;
      if (fi.reportType === ETL_REPORT_TYPES.MONTHLY && !handledMonthly[fi.id]) return;
      if (masterTypes.indexOf(fi.reportType) >= 0 && masterFile[fi.reportType] && masterFile[fi.reportType].loadError) return;
      processedMap[fi.id] = {
        file_id: fi.id,
        file_name: fi.name,
        report_type: fi.reportType,
        billing_ym: (fi.billingYms || []).join(','),
        last_modified_time: fi.lastModified,
        synced_at: syncedAt
      };
      summary.changedFiles.push({ id: fi.id, name: fi.name, reportType: fi.reportType });
    });
    etlOverwriteSheet_(ss, SHEET_NAMES.ETL_FILES, Object.keys(processedMap).map(function (k) { return processedMap[k]; }));

    // 8) 清除查詢索引快取
    clearIndexCache();

    summary.ok = summary.errors.length === 0;
    summary.message = '同步完成：處理 ' + summary.changedFiles.length + ' 個檔案、略過 ' + summary.skippedCount +
      ' 個未異動檔案' + (summary.errors.length ? '，另有 ' + summary.errors.length + ' 項錯誤' : '') +
      '（耗時 ' + Math.round((Date.now() - startMs) / 1000) + ' 秒）。';
    Logger.log('[ETL] ' + summary.message + (summary.errors.length ? '\n' + summary.errors.join('\n') : ''));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.message = 'ETL 同步失敗：' + etlErrMsg_(err);
    summary.errors.push(summary.message);
    Logger.log('[ETL] ' + summary.message);
    return summary;
  } finally {
    lock.releaseLock();
  }
}
