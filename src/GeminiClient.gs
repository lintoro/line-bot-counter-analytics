/**
 * GeminiClient.gs
 * ------------------------------------------------------------
 * Gemini API 自然語言意圖轉譯與確定性數值摘要潤飾器。
 *
 * 原則：
 *   1. 嚴禁 AI 自行計算任何數字、發明公式或捏造未建檔資料。
 *   2. 使用時間預算檢查（Time-Budget Guard：2,500ms），
 *      僅在 Date.now() - startMs < 2500 且遇 HTTP 429/503 時才 sleep(800) 重試 1 次。
 *   3. 任何失敗或超時立即安全降級，不阻塞 LINE replyToken。
 *
 * 私有函式統一使用 gc_ 前綴，避免與其他 .gs 頂層符號衝突。
 * ------------------------------------------------------------
 */

var GC_TIME_BUDGET_MS = 2500;
var GC_RETRY_SLEEP_MS = 800;

function gc_fallbackIntent_() {
  return {
    is_supported: false,
    module_id: 'UNSUPPORTED',
    scope: 'ALL_STORE',
    floor_name: null,
    counter_keyword: null,
    target_ym: null,
    base_ym: null,
    include_combined_view: false
  };
}

/** 呼叫 Gemini v1beta generateContent（含 2,500ms 時間預算檢查與單次 429/503 重試） */
function gc_callGemini_(payloadObj, apiKey, modelName) {
  var startMs = Date.now();
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(modelName) + ':generateContent?key=' + encodeURIComponent(apiKey);
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payloadObj),
    muteHttpExceptions: true
  };

  for (var attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && (Date.now() - startMs) >= GC_TIME_BUDGET_MS) {
      return null;
    }
    var resp;
    try {
      resp = UrlFetchApp.fetch(url, options);
    } catch (err) {
      console.error('Gemini UrlFetchApp 呼叫異常：' + err);
      return null;
    }
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      try {
        var json = JSON.parse(resp.getContentText());
        var candidates = json && json.candidates;
        if (!candidates || !candidates.length) return null;
        var parts = candidates[0].content && candidates[0].content.parts;
        if (!parts || !parts.length) return null;
        return parts[0].text || null;
      } catch (parseErr) {
        console.error('Gemini 回應 JSON 解析失敗：' + parseErr);
        return null;
      }
    }
    if ((code === 429 || code === 503) && attempt === 0 && (Date.now() - startMs) < GC_TIME_BUDGET_MS) {
      Utilities.sleep(GC_RETRY_SLEEP_MS);
      continue;
    }
    console.warn('Gemini HTTP 錯誤：' + code);
    return null;
  }
  return null;
}

/** 驗證並正規化意圖 JSON（嚴格符合 SDD 4.2 Schema） */
function gc_sanitizeIntent_(raw) {
  var fallback = gc_fallbackIntent_();
  if (!raw || typeof raw !== 'object') return fallback;

  var allowedMods = ['M1', 'M2', 'M3', 'M4', 'M5', 'UNSUPPORTED'];
  var mod = String(raw.module_id || 'UNSUPPORTED').toUpperCase().trim();
  if (allowedMods.indexOf(mod) < 0) mod = 'UNSUPPORTED';

  var isSupported = raw.is_supported === true && mod !== 'UNSUPPORTED';
  if (!isSupported) {
    return fallback;
  }

  var allowedScopes = ['COUNTER', 'FLOOR', 'ALL_STORE'];
  var scope = String(raw.scope || 'ALL_STORE').toUpperCase().trim();
  if (allowedScopes.indexOf(scope) < 0) scope = 'ALL_STORE';

  var normYm = function (v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().replace(/[^0-9]/g, '');
    return /^\d{6}$/.test(s) ? s : null;
  };

  return {
    is_supported: true,
    module_id: mod,
    scope: scope,
    floor_name: (raw.floor_name && String(raw.floor_name).trim() !== '' && String(raw.floor_name).trim().toLowerCase() !== 'null')
      ? String(raw.floor_name).trim()
      : null,
    counter_keyword: (raw.counter_keyword && String(raw.counter_keyword).trim() !== '' && String(raw.counter_keyword).trim().toLowerCase() !== 'null')
      ? String(raw.counter_keyword).trim()
      : null,
    target_ym: normYm(raw.target_ym),
    base_ym: normYm(raw.base_ym),
    include_combined_view: raw.include_combined_view === true
  };
}

/**
 * 解析主管自然語言查詢為標準化意圖 JSON。
 * @param {string} userText 主管輸入文字
 * @param {object} contextInfo { todayYmd, availableYms, floors }
 * @return {object} 符合 SDD 4.2 Schema 之物件
 */
function parseNaturalLanguageIntent(userText, contextInfo) {
  var text = (userText === null || userText === undefined) ? '' : String(userText).trim();
  if (text === '') return gc_fallbackIntent_();

  var cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
  var apiKey = cfg.GEMINI_API_KEY;
  var modelName = cfg.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!apiKey) return gc_fallbackIntent_();

  var ctx = contextInfo || {};
  var systemPrompt = [
    '你是商場專櫃營運數據查詢系統的「意圖解析器」，只能將使用者提問對應至五大固定模組，嚴禁自行計算任何數字。',
    '五大模組定義：',
    '- M1: 單一專櫃月度營收、銷貨淨額、抽成、應收應付、包底查詢（需 counter_keyword，可含 target_ym）。',
    '- M2: 全館或指定樓層之自營/專櫃彙總與 Top 10 排行榜（scope=ALL_STORE 或 FLOOR；若要求「合併看全店」設 include_combined_view=true）。',
    '- M3: 跨期營收比較（MoM 上月比 / YoY 去年同月比 / 指定兩月比較），scope 可為 COUNTER / FLOOR / ALL_STORE。',
    '- M4: 專櫃合約效期、到期預警或正品抽成條件查詢（若問「快到期/即將到期合約」設 scope=ALL_STORE, counter_keyword=null）。',
    '- M5: 專櫃代扣款明細核對（管理費、裝潢扣款等）。',
    '- UNSUPPORTED: 非上述五大模組之問題（如問天氣、要求預測未來、閒聊）。',
    '目前系統上下文：今日=' + (ctx.todayYmd || '') +
      '；可用樓層=' + JSON.stringify(ctx.floors || []) +
      '；已建檔年月(由新到舊)=' + JSON.stringify(ctx.availableYms || []) + '。',
    '若使用者提到「上個月」、「去年同月」等相對時間，請對照已建檔最新年月推算為 6 碼 YYYYMM；若未提及月份請填 null。',
    '請只輸出符合指定 JSON Schema 的純 JSON。'
  ].join('\n');

  var reqPayload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          is_supported: { type: 'BOOLEAN' },
          module_id: { type: 'STRING', enum: ['M1', 'M2', 'M3', 'M4', 'M5', 'UNSUPPORTED'] },
          scope: { type: 'STRING', enum: ['COUNTER', 'FLOOR', 'ALL_STORE'] },
          floor_name: { type: 'STRING', nullable: true },
          counter_keyword: { type: 'STRING', nullable: true },
          target_ym: { type: 'STRING', nullable: true },
          base_ym: { type: 'STRING', nullable: true },
          include_combined_view: { type: 'BOOLEAN' }
        },
        required: ['is_supported', 'module_id', 'scope', 'include_combined_view']
      }
    }
  };

  var rawText = gc_callGemini_(reqPayload, apiKey, modelName);
  if (!rawText) return gc_fallbackIntent_();

  try {
    var parsed = JSON.parse(rawText);
    return gc_sanitizeIntent_(parsed);
  } catch (e) {
    console.error('意圖 JSON 解析失敗：' + e);
    return gc_fallbackIntent_();
  }
}

/**
 * 針對確定性計算成功（ok === true）之結果產出 1～2 句繁體中文營運重點摘要。
 * 失敗、逾時或 calcResult.ok !== true 時直接回傳 null，絕不影響主流程。
 */
function formatExecutiveSummary(calcResult) {
  if (!calcResult || calcResult.ok !== true || !calcResult.data) return null;

  var cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
  var apiKey = cfg.GEMINI_API_KEY;
  var modelName = cfg.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!apiKey) return null;

  var prompt = [
    '請根據以下已完成計算的確定性營運數據 JSON（模組 ' + calcResult.moduleId + '），',
    '以繁體中文（台灣）撰寫 1～2 句精簡客觀的高階主管營運摘要（不超過 90 字）。',
    '嚴格規定：只能引用 JSON 內已有的數字與文字，嚴禁自行進行四則運算、推估或新增未出現的數據。',
    '數據 JSON：\n' + JSON.stringify(calcResult.data)
  ].join('\n');

  var reqPayload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 200
    }
  };

  var rawText = gc_callGemini_(reqPayload, apiKey, modelName);
  if (!rawText) return null;
  var cleaned = String(rawText).replace(/[\r\n]+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}
