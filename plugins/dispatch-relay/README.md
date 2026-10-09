# dispatch-relay

[dispatch-board](../dispatch-board) 的搭檔，裝在 **worker** 那一側。多個 session 分工時，worker 做完通常要自己 `SendMessage` 把回報全文送給指揮站，然後再結束 turn——同一份回報生成兩次，`SendMessage` 之後還要多跑一次收尾 request。

裝了 dispatch-relay 之後，worker 只要把回報寫進結果檔、以一行結束 turn；mod 在 turn 結束時讀結果檔，把**新增或變更的內容**連同最終回覆原文送給指揮站。

```
↪ dispatch-relay：結果檔全文＋最終回覆（1834 字）已送達指揮站 shop-lead
```

## 安裝

```
/plugin install dispatch-relay --marketplace Hangghost/learning-hacker-claude-mod
```

裝在 worker 那一側（通常跟 dispatch-board 一起裝）。

## 用法

1. 照 dispatch-board 的方式寫 mission 檔（`~/.claude/missions/*.json`），在 mission 層加上 `station`：指揮站 session 的名稱。
2. 指揮站與 worker **都必須**用 `--name` 開：`claude --bg --name shop-lead`、`claude --bg --name shop-api`。名字要和 `claude agents` 列出的一樣（不分大小寫）；沒命名的 session 對不到節點，指揮站沒命名則送不到。
3. worker 把回報寫進結果檔（預設專案根目錄的 `.mission-result.md`），以一行結束 turn。

開始前要注意：

- **新目錄要先接受信任**：在一個從沒開過 Claude Code 的目錄第一次 `claude --bg` 之前，先在該目錄跑一次 `claude`、接受信任提示。否則 CLI 會回 `Workspace not trusted…`，session 開不起來。
- **用 `--worktree <名>` 開的 worker**：它的專案根目錄是 `<repo>/.claude/worktrees/<名>`，`result_file` 相對的是這個容器根目錄，不是 repo 根。

```json
{
  "mission_id": "shop-redesign",
  "station": "shop-lead",
  "nodes": [
    { "id": "api", "session": "shop-api", "done": "…", "result_file": "reports/api.md" },
    { "id": "web", "session": "shop-web", "done": "…" }
  ]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `station` | 否 | 指揮站 session 的名稱。**沒寫就不啟用**：只用 dispatch-board 的 mission 不受影響 |
| `nodes[].result_file` | 否 | 結果檔，相對於 worker 的專案根目錄（`--worktree` 開的 worker 是 `<repo>/.claude/worktrees/<名>`）；預設 `.mission-result.md`。不能是絕對路徑，不能含 `..` |

其餘欄位（`mission_id`、`nodes[].id`、`nodes[].session`、`done`…）與 dispatch-board 相同，見 [dispatch-board 的 README](../dispatch-board/README.md#mission-檔)。

## 怎麼判定「我是哪個節點」

1. `$.session.id()` 取得本 session 的 id。
2. `claude agents --json` 找出這個 id 的名稱。
3. 在 mission 目錄找 `nodes[].session` 等於這個名稱（不分大小寫）的節點。

**恰好一個**節點、且該 mission 有 `station`，才啟用。查無、多個節點都指到自己、mission 沒有 `station`、`station` 就是自己、名冊不可用，一律不啟用並在日誌（`claude --debug`）寫一行原因。未啟用時零行為：不改 system prompt、不放行任何送件、不送任何訊息。

mission 目錄裡沒有任何 mission 寫了 `station` 時，mod 連名冊都不讀——沒在用它的 session 不付這個成本。

啟動時還沒對到的話，每個新 prompt 會再試一次。啟用後，每次要送件前都重新判定一次：mission 檔搬到 `done/`、改派、或 session 改名就停用；指揮站重開換了 session id 也跟得上（每次送件前用名冊把 `station` 名稱解析成 session id）。

## 行為

- **只送有變更的內容**：結果檔與上次送出的不同才送；新內容以舊內容開頭時只送追加段，否則送全文。記錄遺失時當成沒送過、送全文（寧可重複，不要漏送）。
- **最終回覆**：worker 本 turn 沒有自己 `SendMessage` 時，最終回覆附帶送出，**不設長度門檻**（一行的「要不要 push？」也要送到）。worker 已自送時不附最終回覆，但結果檔變更照送。
- **只在正常答覆結束的 turn 送**：中斷、錯誤、subagent 的 turn 不送，下一次正常 turn 補送。
- **注入一段說明**到 worker 的 system prompt：回報寫進結果檔後以一行結束、不要為同一份回報再 `SendMessage`。需要問指揮站時照常 `SendMessage`，或寫在最終回覆。
- **訊息格式**（指揮站若要解析，以此為準）：

  ```text
  [dispatch-relay] mission=<mission_id> node=<node_id> parts=<part>[,<part>…] chars=<本文總字數>

  --- <part> ---
  <該部分原文>
  ```

  `part` 是 `result-full`、`result-append`、`final-reply` 之一；`chars` 是各部分原文長度加總。

### 送不到的時候

- 名冊上找不到 `station`、同名多筆（不猜是哪一個）、或送件失敗：mod **先**把內容記為已處理，**再**排一個 prompt 請 worker 自己 `SendMessage`。prompt 裡給的收件位址依序是：mission 檔的 `station` 名稱（SendMessage 直接收名稱）、上次成功送達時的位址，最後才是最近一則來訊的 `from` 位址——而且僅限該則來自指揮站。worker 可能收過其他 session 的訊息，「回覆最近一則」會把回報送給第三方。
- 同一份內容只降級一次：降級那個 turn 裡再失敗，只在畫面與日誌說明，不再排 prompt，避免 worker 與 mod 互相觸發。
- 連請 worker 自送的 prompt 都排不進去時，把「已處理」回滾，下一次正常 turn 結束時重送；畫面會照實說哪些東西不會重送。

完成與否仍以 mission 檔的完成條件為準：轉送的訊息只是門鈴。

## 安全邊界

**dispatch-relay 會把檔案內容送到另一個 session。** 送什麼、送給誰、何時不送：

- **送什麼**：只有本 session 對到的節點的結果檔，以及 worker 的最終回覆。結果檔路徑必須在 worker 的專案根目錄底下：mission 檔裡的絕對路徑、`~`、`..` 一律拒絕；讀檔前解析符號連結，指到根目錄外的不讀也不送。超過 256 KB 不送。
- **送給誰**：mission 檔的 `station` 名稱，在 `claude agents --json` 名冊上**恰好一筆**對到的 session。查無或多筆都不送（改請 worker 自己決定）。`station` 是自己時不啟用。
- **何時不送**：沒有啟用時（見上）；mission 沒有 `station` 時；turn 不是正常答覆結束時。
- **mission 檔從哪裡讀**：與 dispatch-board 相同的規則——只讀使用者層級目錄，否則 clone 一個陌生 repo 就能讓 mod 把你的檔案送給別人。
  - 預設 `~/.claude/missions/`。可在 `/plugin` 的設定改 `missions_dir`，但**只認 `~/.claude/settings.json` 裡的值**；專案設定給的值不採用。
  - 自訂目錄只要設一次：dispatch-relay 沒有自己的 `missions_dir` 時，沿用 dispatch-board 的 `missions_dir`。優先序是 dispatch-relay 自己的 → dispatch-board 的 → 預設；dispatch-board 的值同樣只認 `~/.claude/settings.json`。沒裝 dispatch-board 時不受影響。
  - 目錄解析符號連結後必須在家目錄底下、不在本 session 的專案目錄內、不在任何 git 工作樹內。個別 mission 檔經符號連結指到目錄外的不讀。
- **放行送件**：auto mode 下，plugin 的送件會被權限分類器擋下，所以 mod 在 `tool.check` 只放行**自己發出**的 `SendMessage`；其他來源（包括 worker 自己的 `SendMessage`）一律交給原本的流程，不攔截、不改寫、不放行。
- 不寫任何檔案（狀態存在 plugin 自己的 `$.store`）、不執行 mission 檔的完成條件、不連網、不呼叫模型。

## 安裝前看看它會做什麼

```bash
claude plugin validate ./plugins/dispatch-relay
```

結果（v0.1.0）：

```
hooks: session.start, prompt.submit, prompt.compose, turn.start, tool.call{tool=SendMessage},
       session.send, tool.check{tool=SendMessage}, turn.complete
calls: $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.fs.stat, $.process.run,
       $.prompt.submit, $.session.cwd, $.session.id, $.session.root, $.session.send,
       $.settings.read, $.store.delete, $.store.get, $.store.set, $.ui.log
env reads: HOME
env writes: nothing
```

- `$.process.run`：只跑 `claude agents --json`
- `$.session.send`：唯一的送件點，送給名冊解析出的指揮站
- `$.prompt.submit`：唯一的降級點，送不到時請 worker 自己 `SendMessage`
- `$.fs.*`：只讀 mission 目錄、檢查安全邊界、讀結果檔；沒有寫檔

## 限制

- 需要 Claude Code **v2.1.289 以上**（`turn.complete`、`$.session.send`、`tool.check` 的 `next.origin.plugin`、`$.store`、`$.prompt.submit`）。
- worker 必須有名字（`--name`）並出現在 `claude agents` 名冊上；沒命名的前景 session 對不到節點。
- 經 marketplace 安裝會在每個 session 載入。沒有 mission 寫 `station` 時它只讀 mission 目錄，不做別的事。
- 放行送件時無法驗證收件者：plugin 以 session id 送件時，`tool.check` 看到的收件者是引擎解析後的位址，對不回 session id，所以只驗證寄件 mod 是 dispatch-relay（日誌會寫一次）。
- 不隱藏 worker 畫面上的最終回覆、不代寫結果檔。

## 開發

```bash
claude --plugin-dir ./plugins/dispatch-relay   # 單次載入
claude plugin test ./plugins/dispatch-relay     # 跑測試
```

## English

**dispatch-relay** is the worker-side companion to dispatch-board. Instead of a worker writing its report and then sending the whole thing again with `SendMessage`, the worker writes the report to a result file (default `.mission-result.md` in its project root) and ends the turn with one line; at the end of each turn the mod sends what changed in that file, plus the worker's final reply, to the commanding session.

It is opt-in per mission: add `"station": "<commander session name>"` to a dispatch-board mission file. A session activates only if `claude agents --json` maps its own session id (`$.session.id()`) to a name that exactly one node's `session` matches (case-insensitive) in a mission that has a `station`. The station name is resolved to a session id from the roster before every send; no match or duplicate names means no send — the worker is asked to send it itself instead (once per content; no loops). Sessions with no stationed mission do nothing, not even read the roster.

**Security:** the mod sends file contents to another session. It sends only the matched node's result file (relative to the project root, no absolute paths or `..`, symlinks resolved and kept inside the root, 256 KB cap) and the final reply, only to the one roster session named by `station`. Mission files are read under the same rules as dispatch-board: a user-level directory under your home, outside the session's project and any git work tree; a custom `missions_dir` is honoured only from `~/.claude/settings.json`, and when dispatch-relay has none of its own it reuses dispatch-board's (from the same file). Both sessions must be started with `--name`; run `claude` once in a new directory to accept the trust prompt before the first `claude --bg` there; for a `--worktree <name>` worker, `result_file` is relative to `<repo>/.claude/worktrees/<name>`. When forwarding fails, the worker is pointed at the `station` name first, and at the latest `from` address only if that message came from the station. In `tool.check` it allows only its own `SendMessage`; everything else passes through untouched. It writes no files and runs no completion checks. Requires Claude Code v2.1.289+.
