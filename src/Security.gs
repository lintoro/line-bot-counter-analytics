/**
 * Security.gs
 * ------------------------------------------------------------------
 * Webhook 守門員：URL 密鑰驗證、LINE Verify 空事件判斷、Auth_Whitelist 白名單檢核與稽核日誌。
 * GAS doPost(e) 無法讀取 HTTP Headers（x-line-signature），故採 SDD A-01 之
 * 「?key= 密鑰 ＋ 白名單 ＋ Event 結構檢查」雙重應用層驗證。
 * 本檔私有輔助函式一律以 sec 前綴並以底線結尾。
 */

/** 白名單快取 Key 前綴 */
const SEC_WHITELIST_CACHE_PREFIX = 'WL_';

/** 稽核日誌 raw_payload 最大保留字元數 */
const SEC_AUDIT_PAYLOAD_MAX_LEN = 1000;

/**
 * 以固定時間比較兩字串，降低時序攻擊（timing attack）風險。
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function secSafeEquals_(a, b) {
  const sa = String(a);
  const sb = String(b);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < sb.length; i++) {
    // 以 sb（伺服器端密鑰）長度為迴圈基準，sa 不足部分以 0 比較
    diff |= (i < sa.length ? sa.charCodeAt(i) : 0) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 第一道防線：驗證 Webhook URL 的 ?key= 是否等於 WEBHOOK_SECRET_KEY。
 * 若伺服器端尚未設定密鑰，一律拒絕（避免空密鑰被任意通過）。
 * @param {Object} e doPost 事件物件
 * @return {boolean}
 */
function verifyWebhookKey(e) {
  if (!e || !e.parameter || typeof e.parameter.key !== 'string' || e.parameter.key === '') return false;
  const secret = getAppConfig().WEBHOOK_SECRET_KEY;
  if (!secret) return false;
  return secSafeEquals_(e.parameter.key, secret);
}

/**
 * 判斷是否為 LINE Developers Console 的「Verify」測試請求（events 為空陣列）。
 * @param {Object} payload 已 JSON.parse 的請求本體
 * @return {boolean}
 */
function isLineVerifyRequest(payload) {
  return !!(payload && Array.isArray(payload.events) && payload.events.length === 0);
}

/**
 * 判斷 is_active 欄位是否為啟用（true 或字串 'TRUE'，忽略大小寫）。
 * @param {*} val
 * @return {boolean}
 */
function secIsActiveValue_(val) {
  if (val === true) return true;
  if (val === null || val === undefined) return false;
  return String(val).trim().toUpperCase() === 'TRUE';
}

/**
 * 第二道防線：檢核 LINE userId 是否在 Auth_Whitelist 且為啟用狀態。
 * 先讀 ScriptCache（Key: WL_{userId}，TTL 300 秒），未命中才讀取試算表。
 * @param {string} userId
 * @return {{allowed:boolean, managerName:string, department:string}}
 */
function checkUserWhitelist(userId) {
  const denied = { allowed: false, managerName: '', department: '' };
  const uid = String(userId === null || userId === undefined ? '' : userId).trim();
  if (uid === '') return denied;

  const cacheKey = SEC_WHITELIST_CACHE_PREFIX + uid;
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.allowed === 'boolean') {
        return {
          allowed: parsed.allowed,
          managerName: String(parsed.managerName || ''),
          department: String(parsed.department || '')
        };
      }
    }
  } catch (err) {
    // 快取異常（或快取內容損毀）不影響主流程，改讀試算表
  }

  let result = denied;
  try {
    const rows = readSheetObjects(SHEET_NAMES.WHITELIST);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (String(row.line_user_id === undefined ? '' : row.line_user_id).trim() !== uid) continue;
      if (!secIsActiveValue_(row.is_active)) continue;
      result = {
        allowed: true,
        managerName: String(row.manager_name === undefined || row.manager_name === null ? '' : row.manager_name).trim(),
        department: String(row.department === undefined || row.department === null ? '' : row.department).trim()
      };
      break;
    }
  } catch (err) {
    // 讀取白名單失敗時採「預設拒絕」（fail-closed），且不寫入快取
    Logger.log('[Security] 讀取 Auth_Whitelist 失敗：' + (err && err.message ? err.message : err));
    return denied;
  }

  if (cache) {
    try {
      cache.put(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS.WHITELIST);
    } catch (err) {
      // 快取寫入失敗忽略
    }
  }
  return result;
}

/**
 * 清除指定使用者的白名單快取（新增 / 停用白名單後呼叫，使變更立即生效）。
 * @param {string} userId
 */
function clearWhitelistCache(userId) {
  const uid = String(userId === null || userId === undefined ? '' : userId).trim();
  if (uid === '') return;
  try {
    CacheService.getScriptCache().remove(SEC_WHITELIST_CACHE_PREFIX + uid);
  } catch (err) {
    // 忽略快取錯誤
  }
}

/**
 * 寫入資安稽核日誌（Security_Audit_Log）。任何錯誤皆吞下，不可中斷 doPost 流程。
 * @param {string} userId LINE userId（URL 密鑰驗證失敗時可能為空）
 * @param {string} eventType 事件類型，例如 'INVALID_KEY'、'UNAUTHORIZED_USER'
 * @param {*} rawPayload 原始請求內容（物件會轉為 JSON），截斷至 1000 字元
 * @param {string} rejectReason 拒絕原因
 * @return {boolean} 是否寫入成功
 */
function logSecurityAudit(userId, eventType, rawPayload, rejectReason) {
  try {
    let payloadText = '';
    if (rawPayload !== null && rawPayload !== undefined) {
      if (typeof rawPayload === 'string') {
        payloadText = rawPayload;
      } else {
        try {
          payloadText = JSON.stringify(rawPayload);
        } catch (err) {
          payloadText = String(rawPayload);
        }
      }
    }
    if (payloadText.length > SEC_AUDIT_PAYLOAD_MAX_LEN) {
      payloadText = payloadText.slice(0, SEC_AUDIT_PAYLOAD_MAX_LEN);
    }

    const ss = getCleanDbSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAMES.AUDIT_LOG);
      sheet.getRange(1, 1, 1, 5).setValues([[
        'timestamp', 'line_user_id', 'event_type', 'raw_payload', 'reject_reason'
      ]]);
    }
    sheet.appendRow([
      new Date().toISOString(),
      String(userId === null || userId === undefined ? '' : userId),
      String(eventType === null || eventType === undefined ? '' : eventType),
      // 開頭為 = + - @ 的內容加上單引號，防範試算表公式注入
      secEscapeFormula_(payloadText),
      secEscapeFormula_(String(rejectReason === null || rejectReason === undefined ? '' : rejectReason))
    ]);
    return true;
  } catch (err) {
    try {
      Logger.log('[Security] 寫入 Security_Audit_Log 失敗：' + (err && err.message ? err.message : err));
    } catch (ignore) {
      // 忽略
    }
    return false;
  }
}

/**
 * 防範試算表公式注入（CSV / Formula Injection）。
 * @param {string} text
 * @return {string}
 */
function secEscapeFormula_(text) {
  const s = String(text);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * 未授權使用者的固定阻擋訊息（附上 userId 供管理員加入 Auth_Whitelist）。
 * @param {string} userId
 * @return {string}
 */
function buildUnauthorizedReplyText(userId) {
  const uid = String(userId === null || userId === undefined ? '' : userId).trim() || '（無法取得）';
  return [
    '⛔ 您尚未取得本系統的查詢權限。',
    '本服務僅限授權主管使用，如需開通請將以下使用者 ID 提供給系統管理員，加入 Auth_Whitelist 白名單：',
    '',
    '🆔 ' + uid,
    '',
    '開通完成後約 5 分鐘內即可正常使用，造成不便敬請見諒。'
  ].join('\n');
}
