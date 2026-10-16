# Nancy 既有飛書：DLMF → Hindsight 唯讀檢索失敗診斷

日期：2026-10-17（台灣）
狀態：**正式 DLMF ingress 診斷已啟用／4 次真實檢索 PASS；間歇性上游故障根因尚未確定**

## 問題與證據界線

Nancy 既有飛書私聊的 `digital_life_recall` 曾對明確輸入的 Digital Life Stack／Agent Factory／OpenClaw／Hermes／Prime 查詢回傳：

- `ok=false`
- `error=verified_recall_unavailable`
- `failureReason=dlmf_request_failed`
- `upstreamStatusCode=400`
- `attempts=2`

這是**請求失敗**，不是「查詢成功但沒有對應記憶」。Nancy 身分仍為 `did:arthurverse:nancy`。

DLMF 驗證檢索使用目前 canonical scope 與歷史 read-only mount，兩個來源並行查詢 Hindsight，然後才由 DLMF 驗證候選記憶。Hindsight `/metrics` 當時累計 recall HTTP 200 **166**、HTTP 400 **21**、HTTP 499 **2**。這些是服務整體計數，**尚不能逐筆證明 Nancy 的特定請求就是 Hindsight 400**；先前 DLMF 對非 ValidationError 的多種失敗會統一回傳 `digital_life_stack_request_failed`，資訊不足以直接歸因。

GB10 同時間有較高記憶體及 Swap 壓力，但無證據能證明那是這次 HTTP 400 的直接原因。不能因為健康端點 PASS 或成功重試，就宣稱根因已處理。

## 最小診斷改動

只修改 DLMF `src/retrieval/hindsight-canonical-projection.ts` 及其測試。原 Hindsight `recall()` 發生例外時，新增唯一日誌標記：

`DLMF_HINDSIGHT_RECALL_REJECTED`

JSON 欄位僅包含：

- `stage`：`primary` 或 `historical`
- `status`：有界 HTTP 400–599 整數或 null
- `kind`：白名單分類，如 `query_limit`、`provider_timeout`、`provider_bad_request_unknown`

**嚴禁紀錄**：原始 query、bankId、tenant、token、URL、canonical 記憶文字、Hindsight 原始 exception/detail/message、provider 結果。診斷只是觀測：不更改選擇／排序／權限／canonical memory，也不改原始例外物件。

安全負向測試涵蓋惡意 getter、動態 detail、logger 自身拋錯、原始例外同一性與敏感字串不外洩；Hindsight projection targeted **7/7 PASS**，TypeScript build/typecheck PASS，部署腳本 rollback fixture **4/4 PASS**。獨立 Codex 審查找到的 getter/logging 擾動已修正，定向複核為 Pass。

## 生產受控部署

採用獨立 DLMF worktree，**沒有重設或覆寫** `/srv/workspace/dlmf-qwen-ab` 目前的兩個既有未提交修改：

- `scripts/production-pilot/install-dlmf-pg0-systemd.sh`
- `src/integration/digital-life-stack-http.ts` 中已存在的 20 秒檢索上限

正式服務所用的 NodeJS runtime 只替換一份版本核對通過的編譯檔：

`/srv/workspace/dlmf-qwen-ab/dist/retrieval/hindsight-canonical-projection.js`

受控操作指令：

`python3 scripts/activate_nancy_hindsight_recall_diagnostics.py --check`

`python3 scripts/activate_nancy_hindsight_recall_diagnostics.py --apply`

輸出 `DLMF_HINDSIGHT_RECALL_DIAGNOSTICS_ACTIVE`、`dlmfReady=true`；只重啟 `digital-life-dl-nancy-memory-dlmf.service`，不變更共享 PG0、Hindsight 容器、任何 canonical source/schema 或其他數位生命；部署失敗會自動回復前版 JS 並重新檢查 Ready。

正式備份（owner-private）：

`~/.local/state/digital-life/nancy-resident/dlmf-recall-diagnostics-backups/20261016T164428647340Z`

## 部署後真實驗收

對 Nancy 原本已授權的飛書 DM session、同一段由使用者指定的解耦架構查詢：

| 回合 | DLMF result | 有效驗證記憶 | 秒 |
| --- | --- | ---: | ---: |
| 1 | PASS | 3 | 5.16 |
| 2 | PASS | 3 | 4.73 |
| 3 | PASS | 3 | 4.94 |
| 4 | PASS | 3 | 4.95 |

全部第一次嘗試成功；該次實驗期間 Hindsight recall HTTP 200 增加 8、HTTP 400/499 未增加。此結果證明正式 Nancy owner scope 的實際讀路徑正常，**沒有自然觸發新診斷分支，仍不能宣稱間歇性故障已根治**。

## 下一個 Stop Line

下一次真正失敗時，對照 DLMF ingress 的安全日誌：

`journalctl --user -u digital-life-dl-nancy-memory-dlmf.service --since "2026-10-17" --no-pager | grep DLMF_HINDSIGHT_RECALL_REJECTED`

若同時有該標記，判斷 primary/historical、HTTP code、kind，結合 Hindsight 狀態及實際 receipt 修改 owning component。若沒有，轉查 DLMF verified-view/canonical verifier／Transport 邊界，不得憑現有 Hindsight 累積 400 直接推測。調整 Hindsight budget、退化成未驗證資料、停用權限檢查或把 HLB 自動重試擴大都不是本次的授權變更。

Nancy 原飛書新一輪 **模型自主選擇工具 → 取得回執 → 回覆** 與 Agent Factory 跨 Hermes／OpenClaw／Prime 的正式生產授權仍是獨立待驗收關卡。
