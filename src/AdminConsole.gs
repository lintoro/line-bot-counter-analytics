/**
 * AdminConsole.gs
 * ------------------------------------------------------------
 * Clean_DB Google 試算表管理員控制台（System_Console 分頁）、
 * 自訂選單（🚀 營運數據系統管理）與異地交接文件 Google Drive 同步工具。
 *
 * 私有函式統一使用 admin_ 前綴，避免與其他 .gs 頂層符號衝突。
 * ------------------------------------------------------------
 */

var ADMIN_CONSOLE_SHEET_NAME = 'System_Console';
var ADMIN_PROJECT_DOCS_FOLDER = 'PROJECT_DOCS';

/* ============================================================
 * 一、Clean_DB 試算表自訂選單與可安裝 onOpen 觸發器
 * ============================================================ */

/**
 * 當開啟 Clean_DB 試算表時自動建立頂部管理選單。
 * 需透過 installSpreadsheetMenuTrigger() 綁定為可安裝觸發器。
 */
function onCleanDbOpen(e) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🚀 營運數據系統管理')
      .addItem('📥 立即同步與清洗 ERP 報表', 'uiRunManualEtlSync')
      .addItem('🔄 清除系統索引快取', 'uiClearSystemIndexCache')
      .addSeparator()
      .addItem('📤 同步異地開發文件至 Google Drive', 'uiSyncDocsToGoogleDrive')
      .addItem('👤 快速新增 / 啟用白名單主管', 'uiPromptAddAdminToWhitelist')
      .addSeparator()
      .addItem('📊 檢測系統環境與建檔狀態', 'uiCheckSystemHealth')
      .addItem('🖥️ 更新控制台儀表板 (System_Console)', 'uiRefreshSystemConsole')
      .addToUi();
  } catch (err) {
    Logger.log('onCleanDbOpen 建立選單略過（可能非試算表 UI 環境）：' + err);
  }
}

/**
 * 冪等安裝 Clean_DB 試算表的 onOpen 觸發器（由 setupSystem 自動呼叫）。
 */
function installSpreadsheetMenuTrigger() {
  var cfg = getAppConfig();
  if (!cfg.CLEAN_DB_SPREADSHEET_ID) {
    return { installed: false, reason: '缺少 CLEAN_DB_SPREADSHEET_ID' };
  }
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onCleanDbOpen') {
      return { installed: true, alreadyExists: true };
    }
  }
  ScriptApp.newTrigger('onCleanDbOpen')
    .forSpreadsheet(cfg.CLEAN_DB_SPREADSHEET_ID)
    .onOpen()
    .create();
  return { installed: true, alreadyExists: false };
}

/* ============================================================
 * 二、試算表 UI 彈窗互動包裝函式
 * ============================================================ */

function admin_showAlert_(title, message) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.alert(title, message, ui.ButtonSet.OK);
  } catch (e) {
    Logger.log('[' + title + '] ' + message);
  }
}

/** UI：立即同步與清洗 ERP 報表 */
function uiRunManualEtlSync() {
  try {
    var res = runManualEtlSync();
    refreshSystemConsoleSheet();
    var msg = '同步作業已完成！\n\n'
      + '• 狀態：' + (res.status || 'DONE') + '\n'
      + '• 新處理檔案數：' + (res.processedCount || 0) + '\n'
      + '• 略過未異動檔案數：' + (res.skippedCount || 0) + '\n'
      + '• 有效合約專櫃數：' + (res.contractsCount || 0) + '\n'
      + '• 月結資料總列數：' + (res.monthlyCount || 0) + '\n'
      + '• 代扣款資料總列數：' + (res.deductionsCount || 0);
    admin_showAlert_('📥 ERP 報表同步結果', msg);
    return res;
  } catch (err) {
    admin_showAlert_('❌ ERP 報表同步失敗', '錯誤訊息：' + (err && err.message ? err.message : String(err)));
    throw err;
  }
}

/** UI：清除系統索引與白名單快取 */
function uiClearSystemIndexCache() {
  clearIndexCache();
  refreshSystemConsoleSheet();
  admin_showAlert_('🔄 快取已清除', '已清除 LINE Bot 的樓層、專櫃名單與可用年月快取（IDX_*），下次查詢將立即讀取最新 Clean_DB 資料。');
}

/** UI：同步異地開發文件至 Google Drive */
function uiSyncDocsToGoogleDrive() {
  try {
    var res = syncDocsToGoogleDrive();
    refreshSystemConsoleSheet();
    var msg = '異地交接文件已成功同步至 Google Drive！\n\n'
      + '• 目標資料夾：' + res.folderName + '（ID: ' + res.folderId + '）\n'
      + '• 更新檔案：\n  - ' + res.files.join('\n  - ');
    admin_showAlert_('📤 異地交接文件同步完成', msg);
    return res;
  } catch (err) {
    admin_showAlert_('❌ 文件同步失敗', '錯誤訊息：' + (err && err.message ? err.message : String(err)));
    throw err;
  }
}

/** UI：互動輸入新增白名單主管 */
function uiPromptAddAdminToWhitelist() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('👤 新增主管白名單 (1/3)', '請輸入主管的 LINE User ID（例如 U74fa1d...）：', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var uid = String(r1.getResponseText() || '').trim();
  if (!uid) {
    admin_showAlert_('⚠️ 取消操作', 'LINE User ID 不可為空白。');
    return;
  }

  var r2 = ui.prompt('👤 新增主管白名單 (2/3)', '請輸入主管姓名或稱謂（例如：王經理）：', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var name = String(r2.getResponseText() || '').trim();

  var r3 = ui.prompt('👤 新增主管白名單 (3/3)', '請輸入部門名稱（例如：營運處）：', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var dept = String(r3.getResponseText() || '').trim();

  var res = addAdminToWhitelist(uid, name, dept);
  refreshSystemConsoleSheet();
  admin_showAlert_('✅ 白名單已開通', '已授權 LINE User ID：' + uid + '\n姓名：' + (name || '未填') + '\n部門：' + (dept || '未填') + '\n快取已同步清除，可立即使用 LINE Bot。');
  return res;
}

/** UI：檢測系統環境與建檔狀態 */
function uiCheckSystemHealth() {
  var report = checkSystemHealth();
  refreshSystemConsoleSheet();
  var msg = '系統健康狀態：' + report.status + '\n\n'
    + '• 缺少環境屬性：' + (report.missingProperties.length ? report.missingProperties.join(', ') : '無（全部齊全）') + '\n'
    + '• Gemini 模型：' + report.geminiModel + '\n'
    + '• 營運中專櫃數：' + report.contractsCount + ' 櫃\n'
    + '• 月結資料筆數：' + report.monthlyCount + ' 筆\n'
    + '• 已建檔年月：' + (report.availableYms.length ? report.availableYms.join(', ') : '尚無') + '\n'
    + '• 代扣款明細筆數：' + report.deductionsCount + ' 筆\n'
    + '• 啟用中白名單人數：' + report.activeWhitelistCount + ' 人';
  admin_showAlert_('📊 系統環境與資料狀態', msg);
  return report;
}

/** UI：手動更新控制台儀表板 */
function uiRefreshSystemConsole() {
  refreshSystemConsoleSheet();
  admin_showAlert_('🖥️ 儀表板已更新', 'System_Console 分頁的統計數據與操作說明已更新為最新狀態。');
}

/**
 * 檢測系統設定與 Clean_DB 各分頁筆數。
 */
function checkSystemHealth() {
  var cfg = getAppConfig();
  var requiredKeys = [
    'WEBHOOK_SECRET_KEY',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'GEMINI_API_KEY',
    'CLEAN_DB_SPREADSHEET_ID',
    'RAW_ERP_DRIVE_FOLDER_ID'
  ];
  var missing = requiredKeys.filter(function (k) { return !cfg[k]; });

  var contracts = readSheetObjects(SHEET_NAMES.CONTRACTS);
  var monthly = readSheetObjects(SHEET_NAMES.MONTHLY);
  var deductions = readSheetObjects(SHEET_NAMES.DEDUCTIONS);
  var whitelist = readSheetObjects(SHEET_NAMES.WHITELIST);
  var etlFiles = readSheetObjects(SHEET_NAMES.ETL_FILES);

  var ymSet = {};
  monthly.forEach(function (r) {
    var ym = normalizeYearMonth(r.billing_ym);
    if (ym) ymSet[ym] = true;
  });
  var availableYms = Object.keys(ymSet).sort().reverse();
  var activeWhitelistCount = whitelist.filter(function (r) {
    return r.is_active === true || String(r.is_active).toUpperCase() === 'TRUE';
  }).length;

  return {
    status: missing.length === 0 ? 'OK' : 'WARN_MISSING_PROPERTIES',
    missingProperties: missing,
    geminiModel: cfg.GEMINI_MODEL,
    rawFolderId: cfg.RAW_ERP_DRIVE_FOLDER_ID || '',
    contractsCount: contracts.length,
    monthlyCount: monthly.length,
    deductionsCount: deductions.length,
    etlFilesCount: etlFiles.length,
    activeWhitelistCount: activeWhitelistCount,
    availableYms: availableYms,
    checkedAt: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss')
  };
}

/* ============================================================
 * 三、System_Console 控制台儀表板分頁渲染
 * ============================================================ */

/**
 * 建立或刷新 Clean_DB 的 System_Console 控制台分頁（含工具功能說明與即時數據看板）。
 */
function refreshSystemConsoleSheet(optSpreadsheet) {
  var ss = optSpreadsheet || getCleanDbSpreadsheet();
  var sheet = ss.getSheetByName(ADMIN_CONSOLE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ADMIN_CONSOLE_SHEET_NAME, 0);
  }

  var health = checkSystemHealth();
  sheet.clear();

  var rows = [
    ['LINE Bot 商場專櫃營運數據查詢系統 — 管理員控制台 (System_Console)', '', '', ''],
    ['最後更新時間', health.checkedAt, '系統狀態', health.status === 'OK' ? '✅ 正常運作中' : '⚠️ 缺少屬性：' + health.missingProperties.join(', ')],
    ['', '', '', ''],
    ['【一、即時資料庫狀態看板】', '數值 / 狀態', '說明', '備註'],
    ['已建檔結帳年月', health.availableYms.length ? health.availableYms.join(', ') : '尚無資料', '來自 Clean_DB_Monthly', '由新到舊排序'],
    ['營運中專櫃主檔數', health.contractsCount + ' 櫃', '來自 Clean_DB_Contracts', '僅含租戶狀況為「營運中」'],
    ['月結帳務資料筆數', health.monthlyCount + ' 筆', '來自 Clean_DB_Monthly', '支援跨期比較與雙軌口徑'],
    ['契約代扣款明細筆數', health.deductionsCount + ' 筆', '來自 Clean_DB_Deductions', '用於 M5 代扣款檢核'],
    ['已同步 ERP 檔案數', health.etlFilesCount + ' 檔', '來自 ETL_Processed_Files', 'Drive 資料夾 ID：' + health.rawFolderId],
    ['已啟用白名單主管數', health.activeWhitelistCount + ' 人', '來自 Auth_Whitelist', '僅授權帳號可使用 LINE Bot'],
    ['', '', '', ''],
    ['【二、管理員小工具操作指引】', '所在位置（上方選單）', '功能說明與執行時機', '注意事項'],
    ['📥 立即同步與清洗 ERP 報表', '🚀 營運數據系統管理 > 立即同步與清洗 ERP 報表', '掃描雲端 ERP 資料夾內新上傳或更新的 .xlsx 報表，自動清洗寫入 Clean_DB 並清除快取。', '換新月份報表或替換為正式資料時執行'],
    ['🔄 清除系統索引快取', '🚀 營運數據系統管理 > 清除系統索引快取', '強制清除樓層、專櫃與可用年月快取，讓 LINE Bot 立即反映手動調整後的試算表內容。', '手動修改 Clean_DB 後建議執行一次'],
    ['📤 同步異地開發文件至 Google Drive', '🚀 營運數據系統管理 > 同步異地開發文件至 Google Drive', '自動將最新異地交接指南、開發進度、待辦清單寫入專案 Drive 的 PROJECT_DOCS 資料夾。', '準備切換到異地電腦開發或交接前執行'],
    ['👤 快速新增 / 啟用白名單主管', '🚀 營運數據系統管理 > 快速新增 / 啟用白名單主管', '依對話框提示輸入 LINE User ID、姓名與部門，自動開通權限並清除快取。', '主管首次傳訊遭攔截時會回傳其 User ID'],
    ['📊 檢測系統環境與建檔狀態', '🚀 營運數據系統管理 > 檢測系統環境與建檔狀態', '檢查 GAS 指令碼屬性是否齊全、各分頁筆數與可用月份摘要。', '部署或排錯時快速健檢用']
  ];

  sheet.getRange(1, 1, rows.length, 4).setValues(rows);

  // 樣式美化
  sheet.getRange(1, 1, 1, 4).merge()
    .setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(13);
  sheet.getRange(4, 1, 1, 4)
    .setBackground('#E8EEF5').setFontWeight('bold');
  sheet.getRange(12, 1, 1, 4)
    .setBackground('#E8EEF5').setFontWeight('bold');
  sheet.getRange(1, 1, rows.length, 4).setVerticalAlignment('middle').setWrap(true);
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 290);
  sheet.setColumnWidth(3, 380);
  sheet.setColumnWidth(4, 240);
  sheet.setFrozenRows(1);

  return { ok: true, sheetName: ADMIN_CONSOLE_SHEET_NAME };
}

/* ============================================================
 * 四、異地開發交接文件同步至 Google Drive (PROJECT_DOCS)
 * ============================================================ */

function admin_upsertDriveMarkdown_(folder, fileName, content) {
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var existing = files.next();
    existing.setContent(content);
    return existing.getId();
  }
  var created = folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  return created.getId();
}

function admin_getOrCreateDocsFolder_(parentFolderId) {
  var parent = DriveApp.getFolderById(parentFolderId);
  var folders = parent.getFoldersByName(ADMIN_PROJECT_DOCS_FOLDER);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parent.createFolder(ADMIN_PROJECT_DOCS_FOLDER);
}

/**
 * 將異地開發交接指南、進度日誌、待辦清單與環境檢核模板同步為 Google Drive 上的 .md 檔。
 * 注意：程式碼內絕不硬編碼任何機敏金鑰，實際金鑰請保持存放於 GAS 指令碼屬性中。
 */
function syncDocsToGoogleDrive() {
  var cfg = getAppConfig();
  if (!cfg.RAW_ERP_DRIVE_FOLDER_ID) {
    throw new Error('缺少 RAW_ERP_DRIVE_FOLDER_ID，無法建立 PROJECT_DOCS 資料夾。');
  }
  var docsFolder = admin_getOrCreateDocsFolder_(cfg.RAW_ERP_DRIVE_FOLDER_ID);
  var health = checkSystemHealth();
  var nowStr = health.checkedAt;

  var handoverMd = [
    '# LINE Bot 商場專櫃營運數據查詢系統 — 異地開發與接軌指南',
    '',
    '> **最後同步時間**：`' + nowStr + '`  ',
    '> **GitHub 倉庫**：`https://github.com/lintoro/line-bot-counter-analytics`',
    '',
    '## 一、 異地開發資料隔離原則（最高資安規範）',
    '1. **GitHub 僅存放公開程式碼**：`src/`、`README.md`、`SDD_設計規格書.md`、`env.properties.sample`、`.clasp.json.sample`。',
    '2. **嚴禁上推 GitHub 的內容**：`RAWDATA/`（去敏或正式 ERP 報表）、`docs_private/`、`scratch/`、`.clasp.json`、任何金鑰與正式試算表 ID。',
    '3. **交接文件與正式資料皆存放於 Google Drive**：專案雲端資料夾內之 `PROJECT_DOCS/` 存放所有交接 `.md` 文件，根目錄存放真實 ERP `.xlsx` 報表。',
    '',
    '## 二、 在異地電腦（有真實資料環境）5 分鐘快速接軌 SOP',
    '### 1. 拉取最新程式碼',
    '```bash',
    'git clone https://github.com/lintoro/line-bot-counter-analytics.git',
    'cd line-bot-counter-analytics',
    '# 若已有專案目錄則執行：',
    'git pull origin main',
    '```',
    '### 2. 登入 clasp 與綁定 GAS 專案',
    '```bash',
    'npm install -g @google/clasp',
    'clasp login',
    'cp .clasp.json.sample .clasp.json',
    '# 將 .clasp.json 內的 YOUR_GAS_SCRIPT_ID 替換為專案實際 Script ID（見 GAS 專案設定）',
    '```',
    '### 3. 匯入真實 ERP 報表並清洗',
    '1. 將 4 類真實未去敏 ERP `.xlsx` 檔案上傳至 Google Drive 資料夾（`RAW_ERP_DRIVE_FOLDER_ID`）。',
    '2. 若先前有測試資料，先清空 `Clean_DB_Contracts`、`Clean_DB_Monthly`、`Clean_DB_Deductions`、`ETL_Processed_Files` 第 2 列以後資料（**保留 `Auth_Whitelist`**）。',
    '3. 開啟 `Clean_DB` Google 試算表 $\\rightarrow$ 點選頂部選單 **【🚀 營運數據系統管理】 $\\rightarrow$ 【📥 立即同步與清洗 ERP 報表】**。',
    '4. 執行完畢即可直接於手機 LINE 查詢真實營運數據！',
    '',
    '## 三、 異地電腦開發完畢推送流程',
    '```bash',
    'git status   # 確認 RAWDATA/、.clasp.json、docs_private/ 均未被追蹤',
    'git add .',
    'git commit -m "feat: 異地開發更新"',
    'git push origin main',
    'clasp push --force',
    '```',
    '最後在 `Clean_DB` 點選 **【📤 同步異地開發文件至 Google Drive】** 更新雲端交接文件。'
  ].join('\n');

  var progressMd = [
    '# 專案開發進度與系統狀態紀錄 (PROGRESS)',
    '',
    '> **更新時間**：`' + nowStr + '`',
    '',
    '## 一、 目前線上建置狀態',
    '- **GAS 專案狀態**：已完成 9 支核心模組推送與 Web App 部署。',
    '- **LINE Bot 實機狀態**：Webhook 連線與 `Auth_Whitelist` 白名單驗證已實機測通。',
    '- **Clean_DB 目前狀態**：',
    '  - 營運中專櫃數：`' + health.contractsCount + '` 櫃',
    '  - 月結帳務筆數：`' + health.monthlyCount + '` 筆',
    '  - 已建檔結帳年月：`' + (health.availableYms.length ? health.availableYms.join(', ') : '尚無') + '`',
    '  - 代扣款明細筆數：`' + health.deductionsCount + '` 筆',
    '  - 啟用中白名單主管：`' + health.activeWhitelistCount + '` 人',
    '',
    '## 二、 已完成模組清單',
    '- `Config.gs`：環境屬性讀取、前導零保護、Excel 日期轉換、樓層排序與短代碼。',
    '- `Security.gs`：URL `?key=` 驗證、LINE Verify 空事件放行、白名單快取與稽核 Log。',
    '- `EtlSync.gs`：Drive v3 `.xlsx` 轉檔與 `finally` 清除、4 類報表清洗、全量樓層回填。',
    '- `FormulaEngine.gs`：M1～M5 確定性公式引擎與 5 大 `ERR_*` 攔截。',
    '- `LineFlexBuilder.gs`：Quick Reply / 分頁 Carousel / M1～M5 標準 Flex 卡片。',
    '- `GeminiClient.gs`：Structured Output 意圖解析、2,500ms 時間預算保護與降級。',
    '- `Main.gs`：`doPost(e)`、對話狀態機與初始化工具。',
    '- `AdminConsole.gs`：`Clean_DB` 自訂選單、`System_Console` 儀表板與 Drive 文件同步。'
  ].join('\n');

  var issuesMd = [
    '# 需求修改與問題追蹤日誌 (ISSUES_LOG)',
    '',
    '> **更新時間**：`' + nowStr + '`',
    '',
    '## 已完成修改項目',
    '- **[REQ-01] M4 即將到期合約完整顯示**：已改為透過 Flex Carousel 分頁列出全部到期與逾期專櫃（不再截斷於 15 筆），並移除「請於試算表檢視」提示文案。',
    '- **[REQ-02] 異地開發交接中心**：建立 `PROJECT_DOCS/` 雲端 Markdown 文件同步機制，所有機敏交接與改動日誌皆不推上 GitHub。',
    '- **[REQ-03] Clean_DB 管理員小工具**：實作 `System_Console` 儀表板與頂部自訂選單 `🚀 營運數據系統管理`，支援一鍵執行 ETL、清快取、同步文件、加白名單與系統健檢。',
    '',
    '## 待於異地真實資料環境驗證項目',
    '- [ ] 匯入真實未去敏 4 類 ERP `.xlsx` 後，實機驗證 M1～M5 數據與既有財會報表 100% 吻合。',
    '- [ ] 設定 GAS 每日定時排程（`syncAndCleanErpReports`）實現全自動增量同步。'
  ].join('\n');

  var envTemplateMd = [
    '# 雲端環境屬性與部署檢核清單 (DEPLOY_AND_ENV)',
    '',
    '> **資安提醒**：實際金鑰與密鑰統一保存於 GAS 專案「專案設定 > 指令碼屬性」，本文件僅記錄欄位檢核狀態（`' + nowStr + '`）。',
    '',
    '| 指令碼屬性名稱 | 目前設定狀態 | 用途說明 |',
    '| :--- | :---: | :--- |',
    '| `WEBHOOK_SECRET_KEY` | ' + (cfg.WEBHOOK_SECRET_KEY ? '✅ 已設定' : '❌ 缺漏') + ' | Webhook URL `?key=` 第一道防線密鑰 |',
    '| `LINE_CHANNEL_ACCESS_TOKEN` | ' + (cfg.LINE_CHANNEL_ACCESS_TOKEN ? '✅ 已設定' : '❌ 缺漏') + ' | LINE Messaging API 回覆憑證 |',
    '| `GEMINI_API_KEY` | ' + (cfg.GEMINI_API_KEY ? '✅ 已設定' : '❌ 缺漏') + ' | Gemini API 自然語言解析金鑰 |',
    '| `GEMINI_MODEL` | `' + cfg.GEMINI_MODEL + '` | Gemini 使用模型名稱 |',
    '| `CLEAN_DB_SPREADSHEET_ID` | ' + (cfg.CLEAN_DB_SPREADSHEET_ID ? '✅ 已設定' : '❌ 缺漏') + ' | Clean_DB Google 試算表 ID |',
    '| `RAW_ERP_DRIVE_FOLDER_ID` | ' + (cfg.RAW_ERP_DRIVE_FOLDER_ID ? '✅ 已設定' : '❌ 缺漏') + ' | 存放 ERP 報表與 PROJECT_DOCS 的 Drive 資料夾 ID |'
  ].join('\n');

  var fileNames = [
    'HANDOVER_異地開發指南.md',
    'PROGRESS.md',
    'ISSUES_LOG.md',
    'DEPLOY_AND_ENV.md'
  ];
  var contents = [handoverMd, progressMd, issuesMd, envTemplateMd];
  for (var i = 0; i < fileNames.length; i++) {
    admin_upsertDriveMarkdown_(docsFolder, fileNames[i], contents[i]);
  }

  return {
    ok: true,
    folderId: docsFolder.getId(),
    folderName: docsFolder.getName(),
    files: fileNames
  };
}
