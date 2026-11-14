# LINE Bot 商場專櫃營運數據查詢系統

本專案採用 Google Apps Script (GAS) + LINE Messaging API + Google Sheets (`Clean_DB`) + Gemini API 打造零主機費、100% 確定性算術計算之商場專櫃營運數據查詢系統。

## 設計文件
* 完整規格請參閱：[SDD_設計規格書.md](./SDD_設計規格書.md)

## 環境設定（資安規範）
1. 複製 `.clasp.json.sample` 為 `.clasp.json` 並填入您的 GAS `scriptId`（`.clasp.json` 已列入 `.gitignore`）。
2. 參考 `env.properties.sample`，於 GAS **專案設定 > 指令碼屬性** 中填入實際金鑰與資源 ID，嚴禁硬編碼於程式碼中。
