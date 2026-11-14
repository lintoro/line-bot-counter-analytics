/**
 * Main.gs
 * ------------------------------------------------------------
 * GAS Web App Webhook 入口（doPost）、對話狀態機、LINE 回覆介面與管理員工具。
 *
 * 私有函式統一使用 main_ 前綴，避免與其他 .gs 頂層符號衝突。
 * ------------------------------------------------------------
 */

/* ============================================================
 * 一、HTTP 回應與 LINE Messaging API 回覆工具
 * ============================================================ */

function main_okText_(text) {
  return ContentService.createTextOutput(text || 'OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * 呼叫 LINE Messaging API `/v2/bot/message/reply`。
 * messages 可為單一訊息物件或陣列（最多 5 則）。
 */
function replyLineMessage(replyToken, messages) {
  if (!replyToken) return false;
  var cfg = getAppConfig();
  var token = cfg.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('缺少 LINE_CHANNEL_ACCESS_TOKEN，無法回覆 LINE 訊息。');
    return false;
  }
  var list = Array.isArray(messages) ? messages.slice(0, 5) : [messages];
  var payload = {
    replyToken: replyToken,
    messages: list
  };
  try {
    var resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      console.error('LINE Reply API 失敗 HTTP ' + code + '：' + resp.getContentText());
      return false;
    }
    return true;
  } catch (err) {
    console.error('LINE Reply API 呼叫異常：' + err);
    return false;
  }
}

/* ============================================================
 * 二、CacheService 對話狀態機（STATE_${userId}，TTL 600 秒）
 * ============================================================ */

function main_stateKey_(userId) {
  return 'STATE_' + String(userId || '').trim();
}

function main_getUserState_(userId) {
  if (!userId) return { state: 'IDLE' };
  try {
    var raw = CacheService.getScriptCache().get(main_stateKey_(userId));
    return raw ? JSON.parse(raw) : { state: 'IDLE' };
  } catch (e) {
    return { state: 'IDLE' };
  }
}

function main_setUserState_(userId, stateObj) {
  if (!userId) return;
  try {
    var ttl = (typeof CACHE_TTL_SECONDS !== 'undefined' && CACHE_TTL_SECONDS && CACHE_TTL_SECONDS.STATE)
      ? CACHE_TTL_SECONDS.STATE
      : 600;
    CacheService.getScriptCache().put(main_stateKey_(userId), JSON.stringify(stateObj || { state: 'IDLE' }), ttl);
  } catch (e) { /* 忽略快取異常 */ }
}

function main_clearUserState_(userId) {
  if (!userId) return;
  try {
    CacheService.getScriptCache().remove(main_stateKey_(userId));
  } catch (e) { /* 忽略 */ }
}

/* ============================================================
 * 三、Webhook 主入口 doPost(e)
 * ============================================================ */

function doPost(e) {
  try {
    // 1. 第一道防線：Webhook URL ?key= 密鑰驗證
    if (!verifyWebhookKey(e)) {
      var rawAttempt = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
      logSecurityAudit('', 'WEBHOOK_KEY_REJECT', rawAttempt, 'URL key 缺失或驗證失敗');
      return main_okText_('OK');
    }

    // 2. 解析 JSON Body
    var rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    if (!rawBody) return main_okText_('OK');

    var payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (jsonErr) {
      logSecurityAudit('', 'INVALID_JSON', rawBody, 'JSON 解析失敗：' + jsonErr);
      return main_okText_('OK');
    }

    // 3. LINE Console Verify 空事件測試直接放行回傳 "OK"
    if (isLineVerifyRequest(payload)) {
      return main_okText_('OK');
    }

    var events = Array.isArray(payload.events) ? payload.events : [];
    for (var i = 0; i < events.length; i++) {
      main_handleSingleEvent_(events[i], rawBody);
    }
  } catch (err) {
    console.error('doPost 未預期異常：' + err);
  }
  // 永遠回傳 HTTP 200 OK 避免 LINE 平台重試風暴
  return main_okText_('OK');
}

/** 處理單筆 LINE Event */
function main_handleSingleEvent_(ev, rawBody) {
  if (!ev || !ev.source) return;
  var userId = ev.source.userId || '';
  var replyToken = ev.replyToken || '';
  var eventType = ev.type || 'unknown';

  // 第二道防線：Auth_Whitelist 白名單驗證
  var auth = checkUserWhitelist(userId);
  if (!auth || !auth.allowed) {
    logSecurityAudit(userId, eventType, rawBody, '使用者未列入 Auth_Whitelist 或未啟用');
    if (replyToken) {
      replyLineMessage(replyToken, { type: 'text', text: buildUnauthorizedReplyText(userId) });
    }
    return;
  }

  var replyMsg = null;
  try {
    if (eventType === 'postback' && ev.postback && ev.postback.data !== undefined) {
      replyMsg = main_handlePostback_(userId, ev.postback.data);
    } else if (eventType === 'message' && ev.message && ev.message.type === 'text') {
      replyMsg = main_handleTextMessage_(userId, ev.message.text || '');
    } else if (eventType === 'follow') {
      main_clearUserState_(userId);
      replyMsg = buildMainMenuMessage('歡迎使用商場專櫃營運數據查詢系統！請選擇查詢模組或直接輸入問題：');
    } else {
      return;
    }
  } catch (err) {
    console.error('處理 LINE 事件異常：' + err);
    main_clearUserState_(userId);
    replyMsg = buildMainMenuMessage('系統處理請求時發生暫時性異常，請從選單重新操作：');
  }

  if (replyMsg && replyToken) {
    replyLineMessage(replyToken, replyMsg);
  }
}

/* ============================================================
 * 四、Postback 狀態機路由
 * ============================================================ */

function main_handlePostback_(userId, dataStr) {
  var p = lfb_parsePostbackData(dataStr);
  var mod = (p.mod || '').toUpperCase();
  var act = p.act || '';
  var state = main_getUserState_(userId);

  if (act === 'menu' || !mod) {
    main_clearUserState_(userId);
    return buildMainMenuMessage();
  }

  // M4 即將到期合約快捷
  if (mod === 'M4' && act === 'expiring_soon') {
    main_clearUserState_(userId);
    var resExp = calcM4ContractAndCommission(null, true);
    return buildModuleReportMessage(resExp, null);
  }

  // 步驟 1：點擊模組入口
  if (act === 'start') {
    if (mod === 'M1' || mod === 'M4' || mod === 'M5') {
      main_setUserState_(userId, { state: 'SELECT_FLOOR', mod: mod });
      return buildFloorSelectMessage(mod, getActiveFloors(), 1);
    }
    if (mod === 'M2' || mod === 'M3') {
      main_setUserState_(userId, { state: 'SELECT_SCOPE', mod: mod });
      return buildScopeSelectMessage(mod);
    }
  }

  // 樓層超過 13 顆時的 Carousel 換頁
  if (act === 'fl_page') {
    main_setUserState_(userId, { state: 'SELECT_FLOOR', mod: mod });
    return buildFloorSelectMessage(mod, getActiveFloors(), Number(p.p) || 1);
  }

  // 步驟 2 (M2/M3)：選擇統計範圍
  if (act === 'sel_scope') {
    var sc = (p.scope || 'ALL').toUpperCase();
    if (sc === 'ALL') {
      main_setUserState_(userId, { state: 'SELECT_MONTH', mod: mod, scope: 'ALL' });
      return buildMonthSelectMessage(mod, 'ALL', '', getAvailableBillingYMs(), false);
    }
    if (sc === 'FLOOR' || sc === 'COUNTER') {
      main_setUserState_(userId, { state: 'SELECT_FLOOR', mod: mod, scope: sc });
      return buildFloorSelectMessage(mod, getActiveFloors(), 1);
    }
  }

  // 步驟 3：選定樓層
  if (act === 'sel_fl') {
    var fl = p.fl || '';
    var scopeCtx = p.scope || state.scope || '';
    if (mod === 'M2' || (mod === 'M3' && scopeCtx === 'FLOOR')) {
      main_setUserState_(userId, { state: 'SELECT_MONTH', mod: mod, scope: 'FLOOR', fl: fl });
      return buildMonthSelectMessage(mod, 'FLOOR', fl, getAvailableBillingYMs(), false);
    }
    var page = Number(p.p) || 1;
    main_setUserState_(userId, { state: 'SELECT_COUNTER', mod: mod, scope: 'COUNTER', fl: fl, p: page });
    return buildCounterSelectMessage(mod, fl, getActiveCountersByFloor(fl), page);
  }

  // 步驟 4：選定專櫃
  if (act === 'sel_cid') {
    var cid = normalizeCounterId(p.cid || '');
    if (mod === 'M4') {
      main_clearUserState_(userId);
      return buildModuleReportMessage(calcM4ContractAndCommission(cid, false), null);
    }
    main_setUserState_(userId, { state: 'SELECT_MONTH', mod: mod, scope: 'COUNTER', cid: cid });
    return buildMonthSelectMessage(mod, 'COUNTER', cid, getAvailableBillingYMs(), false);
  }

  // 步驟 5：選定目標月份 ym1
  if (act === 'sel_ym1') {
    var ym1 = p.ym1 || '';
    var sc1 = (p.scope || state.scope || (p.cid ? 'COUNTER' : (p.fl ? 'FLOOR' : 'ALL'))).toUpperCase();
    var fl1 = p.fl || state.fl || '';
    var cid1 = normalizeCounterId(p.cid || state.cid || '');
    if (mod === 'M3') {
      main_setUserState_(userId, { state: 'SELECT_BASE_MONTH', mod: 'M3', scope: sc1, fl: fl1, cid: cid1, ym1: ym1 });
      return buildMonthSelectMessage('M3', sc1, sc1 === 'COUNTER' ? cid1 : fl1, getAvailableBillingYMs(), true, ym1);
    }
    return main_execCalcAndBuild_({
      userId: userId,
      mod: mod,
      scope: sc1,
      fl: fl1,
      cid: cid1,
      ym1: ym1,
      comb: p.comb
    }, false);
  }

  // 步驟 6 (M3)：選定基準月份 ym2
  if (act === 'sel_ym2') {
    var sc2 = (p.scope || state.scope || (p.cid ? 'COUNTER' : (p.fl ? 'FLOOR' : 'ALL'))).toUpperCase();
    return main_execCalcAndBuild_({
      userId: userId,
      mod: 'M3',
      scope: sc2,
      fl: p.fl || state.fl || '',
      cid: normalizeCounterId(p.cid || state.cid || ''),
      ym1: p.ym1 || state.ym1 || '',
      ym2: p.ym2 || ''
    }, false);
  }

  // 直接執行查詢（用於卡片底部快捷切換按鈕 / M2 合併切換）
  if (act === 'exec') {
    return main_execCalcAndBuild_({
      userId: userId,
      mod: mod,
      scope: (p.scope || '').toUpperCase(),
      fl: p.fl || '',
      cid: normalizeCounterId(p.cid || ''),
      ym1: p.ym1 || '',
      ym2: p.ym2 || '',
      comb: p.comb
    }, false);
  }

  main_clearUserState_(userId);
  return buildMainMenuMessage('無法辨識的操作指令，請重新選擇查詢項目：');
}

/** 執行對應公式引擎並組裝報表（Postback 路徑不呼叫 AI 摘要以確保 <= 3 秒） */
function main_execCalcAndBuild_(params, withAiSummary) {
  main_clearUserState_(params.userId);
  var mod = params.mod;
  var res;
  if (mod === 'M1') {
    res = calcM1SingleCounter(params.cid, params.ym1);
  } else if (mod === 'M2') {
    var sc2 = params.scope || (params.fl ? 'FLOOR' : 'ALL');
    var comb = params.comb === '1' || params.comb === 1 || params.comb === true;
    res = calcM2SummaryAndTop10(sc2, params.fl, params.ym1, comb);
  } else if (mod === 'M3') {
    var sc3 = params.scope || (params.cid ? 'COUNTER' : (params.fl ? 'FLOOR' : 'ALL'));
    var target = sc3 === 'COUNTER' ? params.cid : params.fl;
    res = calcM3PeriodComparison(sc3, target, params.ym1, params.ym2);
  } else if (mod === 'M4') {
    res = calcM4ContractAndCommission(params.cid, !params.cid);
  } else if (mod === 'M5') {
    res = calcM5DeductionDetails(params.cid, params.ym1);
  } else {
    return buildMainMenuMessage('不支援的模組代碼，請從選單重新選擇：');
  }

  var summary = (withAiSummary && res && res.ok === true) ? formatExecutiveSummary(res) : null;
  return buildModuleReportMessage(res, summary);
}

/* ============================================================
 * 五、自然語言文字查詢路由（Gemini 意圖解析 + 確定性計算）
 * ============================================================ */

/** 快捷指令對應，不耗費 AI Token */
function main_tryFastCommand_(text) {
  var t = String(text || '').trim().toUpperCase();
  if (t === '選單' || t === '主選單' || t === 'MENU' || t === 'HELP' || t === '說明' || t === '查詢') {
    return { type: 'MENU' };
  }
  if (t === 'M1' || t === 'M2' || t === 'M3' || t === 'M4' || t === 'M5') {
    return { type: 'POSTBACK', data: buildPostbackData({ mod: t, act: 'start' }) };
  }
  return null;
}

function main_handleTextMessage_(userId, userText) {
  var trimmed = String(userText || '').trim();
  if (!trimmed) return buildMainMenuMessage();

  var fast = main_tryFastCommand_(trimmed);
  if (fast) {
    if (fast.type === 'MENU') {
      main_clearUserState_(userId);
      return buildMainMenuMessage();
    }
    return main_handlePostback_(userId, fast.data);
  }

  var floors = getActiveFloors();
  var yms = getAvailableBillingYMs();
  var todayYmd = (typeof getTaipeiTodayYmd === 'function') ? getTaipeiTodayYmd() : Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  var intent = parseNaturalLanguageIntent(trimmed, {
    todayYmd: todayYmd,
    availableYms: yms.slice(0, 12),
    floors: floors
  });

  if (!intent || !intent.is_supported || intent.module_id === 'UNSUPPORTED') {
    main_clearUserState_(userId);
    return buildMainMenuMessage('目前系統僅支援五大營運查詢模組（單櫃月報 / 全館樓層彙總 / 跨期比較 / 合約抽成 / 代扣款），請直接點選下方快捷按鈕：');
  }

  var mod = intent.module_id;
  var scope = intent.scope === 'ALL_STORE' ? 'ALL' : intent.scope;
  var fl = intent.floor_name || '';
  var ym1 = intent.target_ym || (yms.length ? yms[0] : '');
  var ym2 = intent.base_ym || '';

  // 若為 M4 到期查詢且無專櫃關鍵字
  if (mod === 'M4' && !intent.counter_keyword && scope === 'ALL') {
    main_clearUserState_(userId);
    var resExp = calcM4ContractAndCommission(null, true);
    return buildModuleReportMessage(resExp, formatExecutiveSummary(resExp));
  }

  // 需要單櫃編號的模組（M1, M4 單櫃, M5, M3 COUNTER）
  var needCounter = (mod === 'M1' || mod === 'M5' || (mod === 'M4' && !!intent.counter_keyword) || (mod === 'M3' && scope === 'COUNTER'));
  var resolvedCid = '';
  if (needCounter) {
    if (!intent.counter_keyword) {
      main_setUserState_(userId, { state: 'SELECT_FLOOR', mod: mod });
      return buildFloorSelectMessage(mod, floors, 1);
    }
    var matches = findCounterByKeyword(intent.counter_keyword);
    if (matches.length === 0) {
      return buildMainMenuMessage('🔍 找不到符合「' + intent.counter_keyword + '」的專櫃，請改用下方選單點選樓層查詢：');
    }
    if (matches.length > 1 && matches[0].counter_id !== normalizeCounterId(intent.counter_keyword)) {
      // 多筆同名/模糊比對：直接以 Carousel 呈現候選專櫃供點選
      return buildCounterSelectMessage(mod, '搜尋「' + intent.counter_keyword + '」', matches.slice(0, 50), 1);
    }
    resolvedCid = matches[0].counter_id;
  }

  // M4 單櫃直接執行
  if (mod === 'M4') {
    main_clearUserState_(userId);
    var resM4 = calcM4ContractAndCommission(resolvedCid, false);
    return buildModuleReportMessage(resM4, formatExecutiveSummary(resM4));
  }

  // 若未指定目標月份且系統有可用月份，引導選擇月份（或 M3 未指定基準期引導選基準期）
  if (!intent.target_ym) {
    if (yms.length === 0) {
      return buildMainMenuMessage('📭 目前系統尚無任何已建檔結帳月份，請管理員先執行 ETL 同步。');
    }
    main_setUserState_(userId, { state: 'SELECT_MONTH', mod: mod, scope: scope, fl: fl, cid: resolvedCid });
    return buildMonthSelectMessage(mod, scope, scope === 'COUNTER' ? resolvedCid : fl, yms, false);
  }

  if (mod === 'M3' && !ym2) {
    main_setUserState_(userId, { state: 'SELECT_BASE_MONTH', mod: 'M3', scope: scope, fl: fl, cid: resolvedCid, ym1: ym1 });
    return buildMonthSelectMessage('M3', scope, scope === 'COUNTER' ? resolvedCid : fl, yms, true, ym1);
  }

  return main_execCalcAndBuild_({
    userId: userId,
    mod: mod,
    scope: scope,
    fl: fl,
    cid: resolvedCid,
    ym1: ym1,
    ym2: ym2,
    comb: intent.include_combined_view ? '1' : '0'
  }, true);
}

/* ============================================================
 * 六、管理員雲端工具函式（於 GAS 編輯器手動執行）
 * ============================================================ */

/**
 * 初始化系統：建立 7 張 Clean_DB 工作表與表頭，並檢核必要指令碼屬性。
 */
function setupSystem() {
  var cfg = getAppConfig();
  var requiredKeys = [
    'WEBHOOK_SECRET_KEY',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'GEMINI_API_KEY',
    'CLEAN_DB_SPREADSHEET_ID',
    'RAW_ERP_DRIVE_FOLDER_ID'
  ];
  var missing = requiredKeys.filter(function (k) { return !cfg[k]; });
  var ss = getCleanDbSpreadsheet();
  initCleanDbSheets(ss);

  var triggerStatus = { installed: false };
  if (typeof installSpreadsheetMenuTrigger === 'function') {
    try {
      triggerStatus = installSpreadsheetMenuTrigger();
    } catch (tErr) {
      triggerStatus = { installed: false, error: String(tErr) };
    }
  }
  if (typeof refreshSystemConsoleSheet === 'function') {
    try {
      refreshSystemConsoleSheet(ss);
    } catch (cErr) {
      Logger.log('refreshSystemConsoleSheet 略過：' + cErr);
    }
  }

  var result = {
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    geminiModel: cfg.GEMINI_MODEL,
    missingProperties: missing,
    menuTrigger: triggerStatus,
    status: missing.length === 0 ? 'OK' : 'WARN_MISSING_PROPERTIES'
  };
  Logger.log('setupSystem 執行結果：' + JSON.stringify(result));
  return result;
}

/**
 * 將主管 LINE User ID 新增（或重新啟用）至 Auth_Whitelist 並清除該帳號快取。
 */
function addAdminToWhitelist(lineUserId, managerName, department) {
  var uid = String(lineUserId || '').trim();
  if (!uid) throw new Error('lineUserId 不可為空');

  var ss = getCleanDbSpreadsheet();
  initCleanDbSheets(ss);
  var sheet = ss.getSheetByName(SHEET_NAMES.WHITELIST);
  var values = sheet.getDataRange().getValues();
  var nowIso = new Date().toISOString();

  var foundRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === uid) {
      foundRow = r + 1; // 1-based sheet row
      break;
    }
  }

  if (foundRow > 0) {
    sheet.getRange(foundRow, 2, 1, 3).setValues([[
      String(managerName || values[foundRow - 1][1] || '').trim(),
      String(department || values[foundRow - 1][2] || '').trim(),
      true
    ]]);
  } else {
    sheet.appendRow([uid, String(managerName || '').trim(), String(department || '').trim(), true, nowIso]);
  }

  if (typeof clearWhitelistCache === 'function') {
    clearWhitelistCache(uid);
  }
  Logger.log('已授權白名單帳號：' + uid);
  return { ok: true, lineUserId: uid, updated: foundRow > 0 };
}

/**
 * 手動觸發 ERP 報表增量同步與清洗。
 */
function runManualEtlSync() {
  var res = syncAndCleanErpReports();
  Logger.log('runManualEtlSync 執行結果：' + JSON.stringify(res));
  return res;
}
