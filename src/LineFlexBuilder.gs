/**
 * LineFlexBuilder.gs
 * ------------------------------------------------------------
 * LINE Messaging API Quick Reply、分頁 Carousel 與 M1～M5 報表卡片建構器。
 *
 * 嚴格遵守 LINE Messaging API 硬性上限：
 *   - Quick Reply 最多 13 顆；每顆 label <= 20 字元
 *   - Flex Carousel 最多 12 張 Bubble；專櫃選擇每張 Bubble <= 10 顆按鈕、每頁 <= 5 張 Bubble（單頁最多 50 櫃）
 *   - Flex Button label <= 40 字元
 *   - Postback data <= 300 字元（Query String 格式，樓層採 encodeFloorCode 短代碼）
 *   - 所有 Flex text 不可為空字串 ""（空白字串會導致 LINE 回傳 400 Bad Request）
 *
 * 私有函式統一使用 lfb_ 前綴，避免與其他 .gs 頂層符號衝突。
 * ------------------------------------------------------------
 */

var LFB_LIMITS = {
  QUICK_REPLY_MAX: 13,
  QUICK_REPLY_LABEL_MAX: 20,
  FLEX_BTN_LABEL_MAX: 40,
  POSTBACK_DATA_MAX: 300,
  COUNTERS_PER_BUBBLE: 10,
  BUBBLES_PER_PAGE: 5,
  FLOORS_PER_BUBBLE: 10,
  FLOOR_BUBBLES_PER_PAGE: 5,
  MONTH_QUICK_REPLY_MAX: 12
};

var LFB_COLORS = {
  PRIMARY: '#1B365D',
  ACCENT: '#0B7285',
  SUCCESS: '#1F7A4C',
  WARNING: '#C96A00',
  DANGER: '#C92A2A',
  MUTED: '#6C757D',
  TEXT: '#212529',
  BG_LIGHT: '#F8F9FA',
  BG_WARN: '#FFF4E6',
  BG_DANGER: '#FFF5F5',
  BORDER: '#DEE2E6'
};

var LFB_POSTBACK_KEYS = ['mod', 'act', 'fl', 'cid', 'ym1', 'ym2', 'scope', 'comb', 'p'];

/* ============================================================
 * 一、全域必備工具函式
 * ============================================================ */

/**
 * 截斷文字至指定長度（含 '...'）。
 * 注意：依字元數（UTF-16 length）計算以保守符合 LINE 字數限制。
 */
function truncateLabel(text, maxLen) {
  var limit = Number(maxLen) > 0 ? Number(maxLen) : 20;
  var s = (text === null || text === undefined) ? '' : String(text).replace(/[\r\n]+/g, ' ').trim();
  if (s === '') return '-';
  if (s.length <= limit) return s;
  if (limit <= 3) return s.slice(0, limit);
  return s.slice(0, limit - 3) + '...';
}

/**
 * 建構標準 Query String Postback Data，並強制驗證 <= 300 字元。
 * 格式：mod=...&act=...&fl=...&cid=...&ym1=...&ym2=...&scope=...&comb=...&p=...
 */
function buildPostbackData(paramsObj) {
  var src = paramsObj || {};
  var parts = [];
  for (var i = 0; i < LFB_POSTBACK_KEYS.length; i++) {
    var k = LFB_POSTBACK_KEYS[i];
    var val = src[k];
    if (val === undefined || val === null || val === '') continue;
    var s = String(val);
    if (k === 'fl' && typeof encodeFloorCode === 'function') {
      s = encodeFloorCode(s);
    }
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(s));
  }
  // 附帶任何非標準擴充鍵（若無必要則不出現）
  Object.keys(src).forEach(function (k2) {
    if (LFB_POSTBACK_KEYS.indexOf(k2) >= 0) return;
    var v2 = src[k2];
    if (v2 === undefined || v2 === null || v2 === '') return;
    parts.push(encodeURIComponent(k2) + '=' + encodeURIComponent(String(v2)));
  });

  var qs = parts.join('&');
  if (qs.length > LFB_LIMITS.POSTBACK_DATA_MAX) {
    throw new Error('Postback data 超過 ' + LFB_LIMITS.POSTBACK_DATA_MAX + ' 字元上限（目前 ' + qs.length + ' 字元）：' + qs);
  }
  return qs;
}

/** 解析 Postback Data Query String 為鍵值物件（fl 自動透過 decodeFloorCode 還原） */
function lfb_parsePostbackData(dataStr) {
  var out = {};
  if (!dataStr) return out;
  var pairs = String(dataStr).split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var idx = pairs[i].indexOf('=');
    var k = idx >= 0 ? decodeURIComponent(pairs[i].slice(0, idx)) : decodeURIComponent(pairs[i]);
    var v = idx >= 0 ? decodeURIComponent(pairs[i].slice(idx + 1)) : '';
    if (k === 'fl' && typeof decodeFloorCode === 'function') {
      v = decodeFloorCode(v);
    }
    out[k] = v;
  }
  return out;
}

/** 千分位貨幣格式化（null/undefined/NaN 回傳 '表格無填寫金額'） */
function formatCurrency(num) {
  if (num === null || num === undefined || num === '') return '表格無填寫金額';
  var n = Number(num);
  if (!isFinite(n)) return '表格無填寫金額';
  var neg = n < 0;
  var rounded = Math.round(Math.abs(n) * 100) / 100;
  var fixed = rounded.toFixed(2);
  var parts = fixed.split('.');
  var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var decPart = parts[1] === '00' ? '' : '.' + parts[1];
  return (neg ? '-' : '') + '$' + intPart + decPart;
}

/** 格式化欄位或空值標記（絕不回傳空字串） */
function formatFieldOrMissing(val, missingLabel) {
  var fallback = (missingLabel && String(missingLabel).trim() !== '') ? String(missingLabel) : '表格無填寫金額';
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') {
    return isFinite(val) ? formatCurrency(val) : fallback;
  }
  var s = String(val).trim();
  return s === '' ? fallback : s;
}

/* ============================================================
 * 二、Flex 原生元件安全建構輔助
 * ============================================================ */

function lfb_safeText_(val, fallback) {
  var s = (val === null || val === undefined) ? '' : String(val).trim();
  if (s === '') return (fallback && String(fallback).trim() !== '') ? String(fallback) : '-';
  return s;
}

function lfb_text_(text, opts) {
  var o = opts || {};
  var node = {
    type: 'text',
    text: lfb_safeText_(text, '-')
  };
  if (o.size) node.size = o.size;
  if (o.weight) node.weight = o.weight;
  if (o.color) node.color = o.color;
  if (o.align) node.align = o.align;
  if (o.wrap !== undefined) node.wrap = !!o.wrap;
  if (o.flex !== undefined) node.flex = o.flex;
  if (o.margin) node.margin = o.margin;
  return node;
}

function lfb_kvRow_(label, value, opts) {
  var o = opts || {};
  return {
    type: 'box',
    layout: 'horizontal',
    margin: o.margin || 'sm',
    spacing: 'sm',
    contents: [
      lfb_text_(label, { size: o.size || 'sm', color: LFB_COLORS.MUTED, flex: o.labelFlex || 4, wrap: true }),
      lfb_text_(value, {
        size: o.size || 'sm',
        color: o.valueColor || LFB_COLORS.TEXT,
        weight: o.valueWeight || 'bold',
        align: 'end',
        flex: o.valueFlex || 6,
        wrap: true
      })
    ]
  };
}

function lfb_sep_(margin) {
  return { type: 'separator', margin: margin || 'md', color: LFB_COLORS.BORDER };
}

function lfb_sectionTitle_(title, color) {
  return lfb_text_(title, { size: 'sm', weight: 'bold', color: color || LFB_COLORS.PRIMARY, margin: 'md', wrap: true });
}

function lfb_postbackBtn_(label, paramsObj, style, color) {
  var cleanLabel = truncateLabel(label, LFB_LIMITS.FLEX_BTN_LABEL_MAX);
  var btn = {
    type: 'button',
    style: style || 'secondary',
    height: 'sm',
    action: {
      type: 'postback',
      label: cleanLabel,
      data: buildPostbackData(paramsObj),
      displayText: cleanLabel
    }
  };
  if (color) btn.color = color;
  return btn;
}

function lfb_quickItem_(label, paramsObj) {
  var cleanLabel = truncateLabel(label, LFB_LIMITS.QUICK_REPLY_LABEL_MAX);
  return {
    type: 'action',
    action: {
      type: 'postback',
      label: cleanLabel,
      data: buildPostbackData(paramsObj),
      displayText: cleanLabel
    }
  };
}

function lfb_bannerBox_(text, bgColor, textColor) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bgColor || LFB_COLORS.BG_WARN,
    cornerRadius: 'md',
    paddingAll: 'sm',
    margin: 'sm',
    contents: [
      lfb_text_(text, { size: 'xs', color: textColor || LFB_COLORS.WARNING, weight: 'bold', wrap: true })
    ]
  };
}

function lfb_headerBox_(title, subtitle, bgColor) {
  var contents = [
    lfb_text_(title, { size: 'md', weight: 'bold', color: '#FFFFFF', wrap: true })
  ];
  if (subtitle && String(subtitle).trim() !== '') {
    contents.push(lfb_text_(subtitle, { size: 'xs', color: '#E2E8F0', margin: 'xs', wrap: true }));
  }
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bgColor || LFB_COLORS.PRIMARY,
    paddingAll: 'lg',
    contents: contents
  };
}

/* ============================================================
 * 三、Quick Reply 與互動選單建構
 * ============================================================ */

/**
 * 主選單 Quick Reply（五大模組 + 即將到期合約快捷）
 */
function buildMainMenuMessage(prefixText) {
  var text = lfb_safeText_(prefixText, '請選擇要查詢的營運數據模組（或直接輸入查詢問題）：');
  var items = [
    lfb_quickItem_('M1 單櫃月報', { mod: 'M1', act: 'start' }),
    lfb_quickItem_('M2 全館/樓層彙總', { mod: 'M2', act: 'start' }),
    lfb_quickItem_('M3 跨期比較', { mod: 'M3', act: 'start' }),
    lfb_quickItem_('M4 合約抽成', { mod: 'M4', act: 'start' }),
    lfb_quickItem_('M5 代扣款明細', { mod: 'M5', act: 'start' }),
    lfb_quickItem_('⚠️ 即將到期合約', { mod: 'M4', act: 'expiring_soon' })
  ];
  return {
    type: 'text',
    text: text,
    quickReply: { items: items.slice(0, LFB_LIMITS.QUICK_REPLY_MAX) }
  };
}

/**
 * 範圍選擇 Quick Reply（M2 / M3 使用：全館 或 依樓層 / M3 另支援單櫃）
 */
function buildScopeSelectMessage(mod) {
  var m = lfb_safeText_(mod, 'M2');
  var items = [
    lfb_quickItem_('🏢 全館彙總', { mod: m, act: 'sel_scope', scope: 'ALL' }),
    lfb_quickItem_('🏬 依樓層查詢', { mod: m, act: 'sel_scope', scope: 'FLOOR' })
  ];
  if (m === 'M3') {
    items.push(lfb_quickItem_('📍 單一專櫃比較', { mod: m, act: 'sel_scope', scope: 'COUNTER' }));
  }
  items.push(lfb_quickItem_('🏠 回主選單', { act: 'menu' }));
  return {
    type: 'text',
    text: '[' + m + '] 請選擇查詢統計範圍：',
    quickReply: { items: items.slice(0, LFB_LIMITS.QUICK_REPLY_MAX) }
  };
}

/**
 * 樓層選擇訊息：<= 13 個樓層使用 Quick Reply；超過 13 個自動切換為 Flex Carousel 分頁
 */
function buildFloorSelectMessage(mod, floors, page) {
  var m = lfb_safeText_(mod, 'M1');
  var list = Array.isArray(floors) ? floors : [];
  if (list.length === 0) {
    return buildMainMenuMessage('📭 目前查無任何營運中專櫃樓層資料，請確認已完成 ETL 同步。');
  }

  // <= 13 顆使用 Quick Reply
  if (list.length <= LFB_LIMITS.QUICK_REPLY_MAX) {
    var qrItems = list.map(function (fl) {
      return lfb_quickItem_(fl, { mod: m, act: 'sel_fl', fl: fl, p: 1 });
    });
    return {
      type: 'text',
      text: '[' + m + '] 請選擇樓層：',
      quickReply: { items: qrItems }
    };
  }

  // 超過 13 個樓層：自動改為 Flex Carousel 分頁（每 Bubble <= 10 顆、每頁 <= 5 張 Bubble）
  var pageSize = LFB_LIMITS.FLOORS_PER_BUBBLE * LFB_LIMITS.FLOOR_BUBBLES_PER_PAGE; // 50
  var totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  var curPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  var startIdx = (curPage - 1) * pageSize;
  var slice = list.slice(startIdx, startIdx + pageSize);

  var bubbles = [];
  for (var i = 0; i < slice.length; i += LFB_LIMITS.FLOORS_PER_BUBBLE) {
    var chunk = slice.slice(i, i + LFB_LIMITS.FLOORS_PER_BUBBLE);
    var btns = chunk.map(function (fl2) {
      return lfb_postbackBtn_(fl2, { mod: m, act: 'sel_fl', fl: fl2, p: 1 }, 'primary');
    });
    bubbles.push({
      type: 'bubble',
      size: 'kilo',
      header: lfb_headerBox_('[' + m + '] 選擇樓層', '第 ' + curPage + '/' + totalPages + ' 頁 · 共 ' + list.length + ' 樓層', LFB_COLORS.PRIMARY),
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: btns }
    });
  }

  // 若有下一頁，於末張 Bubble Footer 加入換頁按鈕（避免超出按鈕上限）
  if (curPage < totalPages || curPage > 1) {
    var footerBtns = [];
    if (curPage > 1) {
      footerBtns.push(lfb_postbackBtn_('⬅️ 上一頁', { mod: m, act: 'fl_page', p: curPage - 1 }, 'secondary'));
    }
    if (curPage < totalPages) {
      footerBtns.push(lfb_postbackBtn_('下一頁 ➡️', { mod: m, act: 'fl_page', p: curPage + 1 }, 'primary', LFB_COLORS.ACCENT));
    }
    bubbles[bubbles.length - 1].footer = { type: 'box', layout: 'horizontal', spacing: 'sm', contents: footerBtns };
  }

  return {
    type: 'flex',
    altText: '[' + m + '] 請選擇樓層（第 ' + curPage + '/' + totalPages + ' 頁）',
    contents: { type: 'carousel', contents: bubbles }
  };
}

/**
 * 專櫃選擇 Carousel：
 * 每張 Bubble 最多 10 顆按鈕、每次最多 5 張 Bubble（單頁最多 50 櫃），
 * 超過 50 櫃則於末張 Bubble Footer 附「下一頁 (p=N+1)」按鈕。
 */
function buildCounterSelectMessage(mod, floorName, counters, page) {
  var m = lfb_safeText_(mod, 'M1');
  var fl = lfb_safeText_(floorName, '未分類樓層');
  var list = Array.isArray(counters) ? counters : [];
  if (list.length === 0) {
    return buildMainMenuMessage('📭 [' + fl + '] 目前無營運中專櫃資料。');
  }

  var perBubble = LFB_LIMITS.COUNTERS_PER_BUBBLE; // 10
  var perPage = perBubble * LFB_LIMITS.BUBBLES_PER_PAGE; // 50
  var totalPages = Math.max(1, Math.ceil(list.length / perPage));
  var curPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  var startIdx = (curPage - 1) * perPage;
  var pageItems = list.slice(startIdx, startIdx + perPage);

  var bubbles = [];
  for (var i = 0; i < pageItems.length; i += perBubble) {
    var chunk = pageItems.slice(i, i + perBubble);
    var btns = chunk.map(function (c) {
      var cid = lfb_safeText_(c.counter_id, '');
      var cname = lfb_safeText_(c.counter_name, '未命名專櫃');
      var rawLabel = cid + ' ' + cname;
      return lfb_postbackBtn_(rawLabel, { mod: m, act: 'sel_cid', fl: fl, cid: cid }, 'secondary');
    });

    var rangeStart = startIdx + i + 1;
    var rangeEnd = startIdx + i + chunk.length;
    bubbles.push({
      type: 'bubble',
      size: 'kilo',
      header: lfb_headerBox_(
        fl + ' 專櫃清單',
        '[' + m + '] 第 ' + curPage + '/' + totalPages + ' 頁（第 ' + rangeStart + '-' + rangeEnd + ' / 共 ' + list.length + ' 櫃）',
        LFB_COLORS.PRIMARY
      ),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: btns }
    });
  }

  // 分頁導覽按鈕（放於最後一張 Bubble 的 Footer，不佔 Body 的 10 顆按鈕額度）
  if (totalPages > 1) {
    var navBtns = [];
    if (curPage > 1) {
      navBtns.push(lfb_postbackBtn_('⬅️ 上一頁', { mod: m, act: 'sel_fl', fl: fl, p: curPage - 1 }, 'secondary'));
    }
    if (curPage < totalPages) {
      navBtns.push(lfb_postbackBtn_('下一頁 (' + (curPage + 1) + '/' + totalPages + ') ➡️', { mod: m, act: 'sel_fl', fl: fl, p: curPage + 1 }, 'primary', LFB_COLORS.ACCENT));
    }
    bubbles[bubbles.length - 1].footer = { type: 'box', layout: 'horizontal', spacing: 'sm', contents: navBtns };
  }

  return {
    type: 'flex',
    altText: '[' + m + '] ' + fl + ' 專櫃選擇（第 ' + curPage + '/' + totalPages + ' 頁）',
    contents: { type: 'carousel', contents: bubbles }
  };
}

/**
 * 結帳月份選擇 Quick Reply：
 * - 一般模式 (baseMode=false)：取最新 12 個可用月份
 * - M3 基準期模式 (baseMode=true)：前 2 顆固定為「上月 (MoM)」「去年同月 (YoY)」，其餘補齊其他可用月份（合計 <= 13 顆）
 */
function buildMonthSelectMessage(mod, scope, floorOrCid, availableYms, baseMode, targetYm1) {
  var m = lfb_safeText_(mod, 'M1');
  var sc = lfb_safeText_(scope, 'COUNTER');
  var yms = Array.isArray(availableYms) ? availableYms : [];
  if (yms.length === 0) {
    return buildMainMenuMessage('📭 目前系統尚無任何已建檔結帳月份，請管理員先執行 ETL 同步。');
  }

  var baseParams = { mod: m, scope: sc };
  if (sc === 'FLOOR' && floorOrCid) baseParams.fl = floorOrCid;
  if (sc === 'COUNTER' && floorOrCid) baseParams.cid = floorOrCid;

  var items = [];
  if (baseMode) {
    var ym1 = lfb_safeText_(targetYm1, yms[0]);
    var prevYm = (typeof shiftBillingYm === 'function') ? shiftBillingYm(ym1, -1) : '';
    var yoyYm = (typeof shiftBillingYm === 'function') ? shiftBillingYm(ym1, -12) : '';

    var pMom = Object.assign({}, baseParams, { act: 'sel_ym2', ym1: ym1, ym2: prevYm || ym1 });
    var pYoy = Object.assign({}, baseParams, { act: 'sel_ym2', ym1: ym1, ym2: yoyYm || ym1 });
    items.push(lfb_quickItem_('上月 MoM (' + (prevYm || '-') + ')', pMom));
    items.push(lfb_quickItem_('去年同月 YoY (' + (yoyYm || '-') + ')', pYoy));

    for (var i = 0; i < yms.length && items.length < LFB_LIMITS.QUICK_REPLY_MAX; i++) {
      var candidate = yms[i];
      if (candidate === ym1 || candidate === prevYm || candidate === yoyYm) continue;
      items.push(lfb_quickItem_(candidate, Object.assign({}, baseParams, { act: 'sel_ym2', ym1: ym1, ym2: candidate })));
    }
    return {
      type: 'text',
      text: '[' + m + '] 目標月份為 ' + ym1 + '，請選擇比較基準月份：',
      quickReply: { items: items.slice(0, LFB_LIMITS.QUICK_REPLY_MAX) }
    };
  }

  var slice = yms.slice(0, LFB_LIMITS.MONTH_QUICK_REPLY_MAX);
  for (var j = 0; j < slice.length; j++) {
    items.push(lfb_quickItem_(slice[j], Object.assign({}, baseParams, { act: 'sel_ym1', ym1: slice[j] })));
  }
  return {
    type: 'text',
    text: '[' + m + '] 請選擇結帳年月：',
    quickReply: { items: items.slice(0, LFB_LIMITS.QUICK_REPLY_MAX) }
  };
}

/* ============================================================
 * 四、M1～M5 報表卡片建構與主進入點
 * ============================================================ */

function lfb_aiSummaryBox_(aiSummaryText) {
  if (!aiSummaryText || String(aiSummaryText).trim() === '') return null;
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#EDF2FF',
    cornerRadius: 'md',
    paddingAll: 'sm',
    margin: 'md',
    contents: [
      lfb_text_('💡 營運摘要', { size: 'xs', weight: 'bold', color: LFB_COLORS.PRIMARY }),
      lfb_text_(aiSummaryText, { size: 'xs', color: LFB_COLORS.TEXT, margin: 'xs', wrap: true })
    ]
  };
}

/** 錯誤回應卡片（含可用月份 Quick Reply 或回主選單） */
function lfb_buildErrorMessage_(calcResult) {
  var msg = lfb_safeText_(calcResult && calcResult.errorMessage, '查無符合條件的營運資料。');
  var d = (calcResult && calcResult.data) || {};
  var yms = Array.isArray(d.availableYms) ? d.availableYms : [];
  var mod = lfb_safeText_(calcResult && calcResult.moduleId, 'M1');

  var items = [];
  if (calcResult && calcResult.errorCode === (typeof ERR_CODES !== 'undefined' ? ERR_CODES.MISSING_MONTH : 'ERR_MISSING_MONTH') && yms.length > 0) {
    var base = { mod: mod, act: 'sel_ym1' };
    if (d.scope) base.scope = d.scope;
    if (d.floorName) base.fl = d.floorName;
    if (d.counterId) { base.cid = d.counterId; base.scope = base.scope || 'COUNTER'; }
    for (var i = 0; i < yms.length && items.length < LFB_LIMITS.QUICK_REPLY_MAX - 1; i++) {
      items.push(lfb_quickItem_('改查 ' + yms[i], Object.assign({}, base, { ym1: yms[i] })));
    }
  }
  items.push(lfb_quickItem_('🏠 回主選單', { act: 'menu' }));

  return {
    type: 'text',
    text: msg,
    quickReply: { items: items.slice(0, LFB_LIMITS.QUICK_REPLY_MAX) }
  };
}

/** M1 單櫃月報卡片 */
function lfb_buildM1_(d, aiSummaryText) {
  var title = d.targetYm + ' ' + d.counterId + ' ' + d.counterName;
  var sub = d.floorName + ' · ' + d.coopMode + (d.categoryName ? (' · ' + d.categoryName) : '');
  var body = [];

  if (d.isDuplicate && d.warning) {
    body.push(lfb_bannerBox_(d.warning, LFB_COLORS.BG_WARN, LFB_COLORS.WARNING));
  }

  body.push(lfb_sectionTitle_('📊 營收與抽成（未稅 / 含稅雙軌）'));
  body.push(lfb_kvRow_('銷貨未稅淨額', formatCurrency(d.sales.sales_untaxed)));
  body.push(lfb_kvRow_('銷貨稅額', formatCurrency(d.sales.sales_tax)));
  body.push(lfb_kvRow_('銷貨含稅總額', formatCurrency(d.sales.sales_tax_included)));
  body.push(lfb_kvRow_('商場抽成額合計', formatCurrency(d.commission.comm_total), { valueColor: LFB_COLORS.ACCENT }));
  body.push(lfb_kvRow_('抽成未稅 / 稅額', formatCurrency(d.commission.comm_untaxed) + ' / ' + formatCurrency(d.commission.comm_tax)));
  body.push(lfb_kvRow_('綜合抽成率(未稅)', lfb_safeText_(d.commission.rateVsUntaxed, '-')));
  body.push(lfb_kvRow_('綜合抽成率(含稅)', lfb_safeText_(d.commission.rateVsTaxIncluded, '-')));

  body.push(lfb_sep_());
  body.push(lfb_sectionTitle_('🧾 帳務結算'));
  body.push(lfb_kvRow_('應收帳款合計', formatCurrency(d.receivable.ar_total)));
  body.push(lfb_kvRow_('  └ 代扣款未稅 / 租金未稅', formatCurrency(d.receivable.ar_deduction_untaxed) + ' / ' + formatCurrency(d.receivable.ar_rent_untaxed)));
  body.push(lfb_kvRow_('  └ 應收稅額合計', formatCurrency(d.receivable.ar_tax_total)));
  body.push(lfb_kvRow_('包底抽成不足(含稅)', formatCurrency(d.min_guarantee_short), { valueColor: d.min_guarantee_short > 0 ? LFB_COLORS.WARNING : LFB_COLORS.TEXT }));
  body.push(lfb_kvRow_('應付帳款(含稅)', formatCurrency(d.ap_total_tax_inc), { valueColor: LFB_COLORS.SUCCESS }));
  body.push(lfb_kvRow_('預計付款日', formatFieldOrMissing(d.expected_pay_date, '未排定')));

  if (d.isDuplicate && Array.isArray(d.records) && d.records.length >= 2) {
    body.push(lfb_sep_());
    body.push(lfb_sectionTitle_('📋 各筆帳次明細', LFB_COLORS.WARNING));
    d.records.forEach(function (rec) {
      body.push(lfb_kvRow_(
        '第' + rec.seq + '筆 (帳次' + rec.billing_batch + ')',
        '未稅 ' + formatCurrency(rec.sales_untaxed) + ' / 含稅 ' + formatCurrency(rec.sales_tax_included)
      ));
    });
  }

  var aiBox = lfb_aiSummaryBox_(aiSummaryText);
  if (aiBox) body.push(aiBox);

  var footerBtns = [
    lfb_postbackBtn_('📄 查合約 M4', { mod: 'M4', act: 'exec', cid: d.counterId }, 'secondary'),
    lfb_postbackBtn_('🧾 查代扣 M5', { mod: 'M5', act: 'exec', cid: d.counterId, ym1: d.targetYm }, 'secondary'),
    lfb_postbackBtn_('📈 跨期比較 M3', { mod: 'M3', act: 'sel_ym1', scope: 'COUNTER', cid: d.counterId, ym1: d.targetYm }, 'primary', LFB_COLORS.ACCENT)
  ];

  return {
    type: 'flex',
    altText: '[M1] ' + d.targetYm + ' ' + d.counterId + ' ' + d.counterName + ' 營收月報',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: lfb_headerBox_(title, sub, LFB_COLORS.PRIMARY),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'xs', contents: footerBtns }
    }
  };
}

/** M2 單一群組 Bubble */
function lfb_buildM2GroupBubble_(group, targetYm, scopeLabel, opts) {
  var o = opts || {};
  var body = [];
  if (o.warning) {
    body.push(lfb_bannerBox_(o.warning, LFB_COLORS.BG_WARN, LFB_COLORS.WARNING));
  }
  body.push(lfb_sectionTitle_('📊 ' + group.label + '彙總'));
  body.push(lfb_kvRow_('專櫃家數', String(group.counterCount) + ' 家'));
  body.push(lfb_kvRow_('未稅營收總計', formatCurrency(group.sum_sales_untaxed)));
  body.push(lfb_kvRow_('含稅總額總計', formatCurrency(group.sum_sales_tax_included)));
  body.push(lfb_kvRow_('抽成額總計', formatCurrency(group.sum_comm_total), { valueColor: LFB_COLORS.ACCENT }));
  if (group.groupKey === 'TENANT_COUNTER' || group.groupKey === 'ALL_COMBINED') {
    body.push(lfb_kvRow_('應收帳款總計', formatCurrency(group.sum_ar_total)));
  }

  body.push(lfb_sep_());
  body.push(lfb_sectionTitle_('🏆 營收 Top 10（依未稅排序）'));
  if (!group.top10 || group.top10.length === 0) {
    body.push(lfb_text_('本群組當月無資料紀錄', { size: 'xs', color: LFB_COLORS.MUTED }));
  } else {
    group.top10.forEach(function (item) {
      var rankLine = item.rank + '. ' + item.counterId + ' ' + item.counterName + ' (' + item.sharePct + ')';
      var amtLine = '未稅 ' + formatCurrency(item.sales_untaxed) + ' / 含稅 ' + formatCurrency(item.sales_tax_included);
      body.push({
        type: 'box',
        layout: 'vertical',
        margin: 'sm',
        contents: [
          lfb_text_(rankLine, { size: 'xs', weight: 'bold', color: LFB_COLORS.TEXT, wrap: true }),
          lfb_text_(amtLine, { size: 'xxs', color: LFB_COLORS.MUTED, wrap: true })
        ]
      });
    });
  }

  if (o.aiSummaryText) {
    var aiBox = lfb_aiSummaryBox_(o.aiSummaryText);
    if (aiBox) body.push(aiBox);
  }

  var bubble = {
    type: 'bubble',
    size: 'mega',
    header: lfb_headerBox_(
      targetYm + ' ' + scopeLabel + ' · ' + group.label,
      '雙軌彙總與 Top 10 排行榜',
      o.headerColor || LFB_COLORS.PRIMARY
    ),
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body }
  };

  if (o.footerBtn) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: [o.footerBtn] };
  }
  return bubble;
}

/** M2 全館 / 樓層彙總 Carousel */
function lfb_buildM2_(d, aiSummaryText) {
  var toggleComb = d.includeCombined ? '0' : '1';
  var toggleLabel = d.includeCombined ? '收合全店合併視角' : '➕ 加看全店合併 (comb=1)';
  var toggleBtn = lfb_postbackBtn_(toggleLabel, {
    mod: 'M2',
    act: 'exec',
    scope: d.scope,
    fl: d.scope === 'FLOOR' ? d.floorName : '',
    ym1: d.targetYm,
    comb: toggleComb
  }, 'primary', LFB_COLORS.ACCENT);

  var bubbles = [
    lfb_buildM2GroupBubble_(d.selfOperated, d.targetYm, d.scopeLabel, {
      headerColor: '#1B365D',
      warning: d.warning,
      aiSummaryText: aiSummaryText
    }),
    lfb_buildM2GroupBubble_(d.tenant, d.targetYm, d.scopeLabel, {
      headerColor: '#0B7285',
      footerBtn: d.includeCombined ? null : toggleBtn
    })
  ];

  if (d.includeCombined && d.combined) {
    bubbles.push(lfb_buildM2GroupBubble_(d.combined, d.targetYm, d.scopeLabel, {
      headerColor: '#1F7A4C',
      footerBtn: toggleBtn
    }));
  }

  return {
    type: 'flex',
    altText: '[M2] ' + d.targetYm + ' ' + d.scopeLabel + ' 彙總與 Top 10',
    contents: { type: 'carousel', contents: bubbles }
  };
}

/** M3 單一指標行組裝 */
function lfb_m3MetricRow_(label, m) {
  var currStr = (m.curr === null || m.curr === undefined) ? '無紀錄' : formatCurrency(m.curr);
  var baseStr = (m.base === null || m.base === undefined) ? '無紀錄' : formatCurrency(m.base);
  var diffStr = (m.diff === null || m.diff === undefined) ? '-' : ((m.diff > 0 ? '+' : '') + formatCurrency(m.diff));
  var color = LFB_COLORS.TEXT;
  if (m.growthValue !== null && m.growthValue !== undefined) {
    color = m.growthValue > 0 ? LFB_COLORS.SUCCESS : (m.growthValue < 0 ? LFB_COLORS.DANGER : LFB_COLORS.TEXT);
  }
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'xs',
    contents: [
      lfb_kvRow_(label, m.growthPct, { valueColor: color }),
      lfb_text_('當期 ' + currStr + ' vs 基準 ' + baseStr + '（差額 ' + diffStr + '）', { size: 'xxs', color: LFB_COLORS.MUTED, wrap: true })
    ]
  };
}

/** M3 三線跨期比較卡片 */
function lfb_buildM3_(d, aiSummaryText) {
  var body = [];

  if (d.counterBlock) {
    var cb = d.counterBlock;
    body.push(lfb_sectionTitle_('📍 單櫃表現：' + cb.counterId + ' ' + cb.counterName + ' (' + cb.floorName + ')'));
    if (cb.note) body.push(lfb_bannerBox_(cb.note, LFB_COLORS.BG_WARN, LFB_COLORS.WARNING));
    body.push(lfb_m3MetricRow_('未稅營收', cb.metrics.sales_untaxed));
    body.push(lfb_m3MetricRow_('含稅總額', cb.metrics.sales_tax_included));
    body.push(lfb_m3MetricRow_('抽成額合計', cb.metrics.comm_total));
    body.push(lfb_sep_('lg'));
  }

  var icons = { SELF_OPERATED: '📊 ', TENANT_COUNTER: '🛍️ ', ALL_COMBINED: '🏢 ' };
  d.lines.forEach(function (line, idx) {
    if (idx > 0) body.push(lfb_sep_());
    body.push(lfb_sectionTitle_((icons[line.lineKey] || '') + line.label + '（' + line.currCounterCount + ' vs ' + line.baseCounterCount + ' 家）'));
    body.push(lfb_m3MetricRow_('未稅營收', line.metrics.sales_untaxed));
    body.push(lfb_m3MetricRow_('含稅總額', line.metrics.sales_tax_included));
    body.push(lfb_m3MetricRow_('抽成額合計', line.metrics.comm_total));

    if (line.structureShift) {
      var sh = line.structureShift;
      body.push(lfb_kvRow_('自營佔比位移', sh.selfShareBaseText + ' → ' + sh.selfShareCurrText + ' (' + sh.selfShiftText + ')', { size: 'xs' }));
      body.push(lfb_kvRow_('專櫃佔比位移', sh.tenantShareBaseText + ' → ' + sh.tenantShareCurrText + ' (' + sh.tenantShiftText + ')', { size: 'xs' }));
    }
  });

  var aiBox = lfb_aiSummaryBox_(aiSummaryText);
  if (aiBox) body.push(aiBox);

  var footerBtns = [];
  if (d.counterBlock) {
    footerBtns.push(lfb_postbackBtn_('📊 查單櫃 M1', { mod: 'M1', act: 'exec', cid: d.counterBlock.counterId, ym1: d.targetYm }, 'secondary'));
    footerBtns.push(lfb_postbackBtn_('📄 查合約 M4', { mod: 'M4', act: 'exec', cid: d.counterBlock.counterId }, 'secondary'));
  } else {
    footerBtns.push(lfb_postbackBtn_('🏠 回主選單', { act: 'menu' }, 'secondary'));
  }

  return {
    type: 'flex',
    altText: '[M3] ' + d.scopeLabel + ' ' + d.targetYm + ' vs ' + d.baseYm + ' 跨期比較',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: lfb_headerBox_(
        '跨期比較：' + d.targetYm + ' vs ' + d.baseYm,
        d.scopeLabel + ' · ' + d.compareMode + ' 三線對比',
        LFB_COLORS.PRIMARY
      ),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: footerBtns }
    }
  };
}

/** M4 合約與抽成條件卡片 */
function lfb_buildM4_(d, aiSummaryText) {
  if (d.mode === 'EXPIRING') {
    if (d.items.length === 0) {
      var emptyBody = [
        lfb_kvRow_('基準日期', d.todayYmd),
        lfb_kvRow_('90 天內到期 / 逾期', '共 0 櫃（逾期 0 / 即將到期 0）'),
        lfb_sep_(),
        lfb_text_('✅ 目前全館營運中專櫃皆無 90 天內到期或逾期合約。', { size: 'sm', color: LFB_COLORS.SUCCESS, wrap: true })
      ];
      var aiExEmpty = lfb_aiSummaryBox_(aiSummaryText);
      if (aiExEmpty) emptyBody.push(aiExEmpty);
      return {
        type: 'flex',
        altText: '[M4] 即將到期 / 逾期合約清單（共 0 櫃）',
        contents: {
          type: 'bubble',
          size: 'mega',
          header: lfb_headerBox_('⚠️ 即將到期與逾期合約清單', '90 天內到期預警（截至 ' + d.todayYmd + '）', LFB_COLORS.WARNING),
          body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: emptyBody },
          footer: { type: 'box', layout: 'vertical', contents: [lfb_postbackBtn_('🏠 回主選單', { act: 'menu' }, 'secondary')] }
        }
      };
    }

    // 完整顯示全部筆數：每張 Bubble 最多容納 10 櫃（若超過 120 櫃則自動調整每頁筆數以符合 LINE Carousel 最多 12 張上限）
    var maxBubbles = 12;
    var perBubble = d.items.length > 10 * maxBubbles ? Math.ceil(d.items.length / maxBubbles) : 10;
    var chunks = [];
    for (var i = 0; i < d.items.length; i += perBubble) {
      chunks.push(d.items.slice(i, i + perBubble));
    }

    var bubbles = chunks.map(function (chunk, pageIdx) {
      var body = [];
      if (pageIdx === 0) {
        body.push(lfb_kvRow_('基準日期', d.todayYmd));
        body.push(lfb_kvRow_('90 天內到期 / 逾期', '共 ' + d.count + ' 櫃（逾期 ' + d.overdueCount + ' / 即將到期 ' + d.warningCount + '）'));
        body.push(lfb_sep_());
      } else {
        body.push(lfb_text_('接續前頁（第 ' + (pageIdx * perBubble + 1) + '～' + (pageIdx * perBubble + chunk.length) + ' 櫃 / 共 ' + d.count + ' 櫃）', { size: 'xxs', color: LFB_COLORS.MUTED, wrap: true }));
        body.push(lfb_sep_());
      }

      chunk.forEach(function (it, idxInPage) {
        var seq = pageIdx * perBubble + idxInPage + 1;
        var color = it.alertLevel === 'OVERDUE' ? LFB_COLORS.DANGER : LFB_COLORS.WARNING;
        body.push({
          type: 'box',
          layout: 'vertical',
          margin: 'sm',
          contents: [
            lfb_text_(seq + '. ' + it.counterId + ' ' + it.counterName + ' (' + it.floorName + ')', { size: 'xs', weight: 'bold', wrap: true }),
            lfb_text_(it.alertText + ' · 截止 ' + it.opEndDate, { size: 'xxs', color: color, wrap: true })
          ]
        });
      });

      if (pageIdx === chunks.length - 1) {
        var aiEx = lfb_aiSummaryBox_(aiSummaryText);
        if (aiEx) body.push(aiEx);
      }

      var pageTitle = chunks.length > 1
        ? ('⚠️ 即將到期與逾期合約 (' + (pageIdx + 1) + '/' + chunks.length + ')')
        : '⚠️ 即將到期與逾期合約清單';

      return {
        type: 'bubble',
        size: 'mega',
        header: lfb_headerBox_(pageTitle, '90 天內到期預警（截至 ' + d.todayYmd + '）', d.overdueCount > 0 ? LFB_COLORS.DANGER : LFB_COLORS.WARNING),
        body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body },
        footer: { type: 'box', layout: 'vertical', contents: [lfb_postbackBtn_('🏠 回主選單', { act: 'menu' }, 'secondary')] }
      };
    });

    return {
      type: 'flex',
      altText: '[M4] 即將到期 / 逾期合約清單（共 ' + d.count + ' 櫃）',
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles }
    };
  }

  var c = d.contract;
  var bannerBg = c.alertLevel === 'OVERDUE' ? LFB_COLORS.BG_DANGER : (c.alertLevel === 'WARNING' ? LFB_COLORS.BG_WARN : '#EBFBEE');
  var bannerFg = c.alertLevel === 'OVERDUE' ? LFB_COLORS.DANGER : (c.alertLevel === 'WARNING' ? LFB_COLORS.WARNING : LFB_COLORS.SUCCESS);
  var bodySingle = [
    lfb_bannerBox_(c.alertText, bannerBg, bannerFg),
    lfb_kvRow_('樓層 / 區域 / 櫃位', c.floorName + (c.areaName ? (' · ' + c.areaName) : '') + ' · ' + c.boothNo),
    lfb_kvRow_('業種 / 版本', formatFieldOrMissing(c.categoryName, '未分類') + ' · v' + c.versionNo),
    lfb_kvRow_('營運起迄日', formatFieldOrMissing(c.opStartDate, '未填') + ' ～ ' + formatFieldOrMissing(c.opEndDate, '未填')),
    lfb_sep_(),
    lfb_sectionTitle_('💰 抽成條件'),
    lfb_kvRow_('抽成別 / 稅別', c.commissionType + ' · ' + c.taxType),
    lfb_text_('正品抽成率：' + c.regularRateSummary, { size: 'sm', color: LFB_COLORS.TEXT, weight: 'bold', margin: 'sm', wrap: true })
  ];

  var aiSingle = lfb_aiSummaryBox_(aiSummaryText);
  if (aiSingle) bodySingle.push(aiSingle);

  return {
    type: 'flex',
    altText: '[M4] ' + c.counterId + ' ' + c.counterName + ' 合約與抽成條件',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: lfb_headerBox_(c.counterId + ' ' + c.counterName, '合約效期與正品抽成條件 (' + c.status + ')', LFB_COLORS.PRIMARY),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: bodySingle },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          lfb_postbackBtn_('📊 查月報 M1', { mod: 'M1', act: 'sel_cid', cid: c.counterId }, 'primary', LFB_COLORS.ACCENT),
          lfb_postbackBtn_('🧾 查代扣 M5', { mod: 'M5', act: 'sel_cid', cid: c.counterId }, 'secondary')
        ]
      }
    }
  };
}

/** M5 專櫃代扣款明細卡片 */
function lfb_buildM5_(d, aiSummaryText) {
  var body = [];
  if (d.items.length === 0) {
    body.push(lfb_text_('📭 該專櫃於 ' + d.targetYm + ' 期間內無契約代扣款紀錄。', { size: 'sm', color: LFB_COLORS.MUTED, wrap: true }));
  } else {
    d.items.forEach(function (it, idx) {
      if (idx > 0) body.push(lfb_sep_());
      body.push(lfb_sectionTitle_(it.seq + '. [' + it.deductCategory + '] ' + it.deductItemName));
      body.push(lfb_kvRow_('適用起迄月', it.startYm + ' ～ ' + it.endYm));
      body.push(lfb_kvRow_('扣款金額(未稅)', it.display.amount_untaxed));
      body.push(lfb_kvRow_('每月金額', it.display.monthly_amount));
      body.push(lfb_kvRow_('分攤期數', it.display.installment_periods));
      body.push(lfb_kvRow_('頭期款 / 總金額', it.display.down_payment + ' / ' + it.display.total_amount, { size: 'xs' }));
    });
  }

  body.push(lfb_sep_('lg'));
  body.push(lfb_bannerBox_('🔍 交叉核對：' + d.monthlyCheck.note, '#EDF2FF', LFB_COLORS.PRIMARY));

  var aiM5 = lfb_aiSummaryBox_(aiSummaryText);
  if (aiM5) body.push(aiM5);

  return {
    type: 'flex',
    altText: '[M5] ' + d.targetYm + ' ' + d.counterId + ' ' + d.counterName + ' 代扣款明細',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: lfb_headerBox_(d.targetYm + ' ' + d.counterId + ' ' + d.counterName, d.floorName + ' · 契約代扣款明細（共 ' + d.itemCount + ' 筆）', LFB_COLORS.PRIMARY),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          lfb_postbackBtn_('📊 查月報 M1', { mod: 'M1', act: 'exec', cid: d.counterId, ym1: d.targetYm }, 'primary', LFB_COLORS.ACCENT),
          lfb_postbackBtn_('📄 查合約 M4', { mod: 'M4', act: 'exec', cid: d.counterId }, 'secondary')
        ]
      }
    }
  };
}

/**
 * 統一報表建構入口
 */
function buildModuleReportMessage(calcResult, aiSummaryText) {
  if (!calcResult || !calcResult.ok) {
    return lfb_buildErrorMessage_(calcResult);
  }
  var summary = (aiSummaryText && String(aiSummaryText).trim() !== '') ? String(aiSummaryText).trim() : null;
  switch (calcResult.moduleId) {
    case 'M1': return lfb_buildM1_(calcResult.data, summary);
    case 'M2': return lfb_buildM2_(calcResult.data, summary);
    case 'M3': return lfb_buildM3_(calcResult.data, summary);
    case 'M4': return lfb_buildM4_(calcResult.data, summary);
    case 'M5': return lfb_buildM5_(calcResult.data, summary);
    default:
      return buildMainMenuMessage('無法識別的報表模組，請重新選擇：');
  }
}
