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
- **最終回覆**：worker 本 turn 沒有自己 `SendMessage` 時，最終回覆附帶送出，**不設長度門檻**（一行的「要不要 push？」也要送到）。worker 已自送時不附最終回覆，但結果檔變更照送。背景工作進行中的「等待中」回覆例外：先暫存、延後併入下一則（見下節）。
- **只在正常答覆結束的 turn 送**：中斷、錯誤、subagent 的 turn 不送，下一次正常 turn 補送。
- **注入一段說明**到 worker 的 system prompt：回報寫進結果檔後以一行結束、不要為同一份回報再 `SendMessage`。需要問指揮站時照常 `SendMessage`，或寫在最終回覆；背景工作進行中要立即回應時用 `SendMessage`（自送不延後，見下節）。
- **訊息格式**（指揮站若要解析，以此為準）：

  ```text
  [dispatch-relay] mission=<mission_id> node=<node_id> parts=<part>[,<part>…] chars=<本文總字數>

  --- <part> ---
  <該部分原文>
  ```

  `part` 是 `result-full`、`result-append`、`held-reply`、`final-reply` 之一，本文依這個順序排列（時間先後）；`chars` 是各部分原文長度加總。`held-reply` 是先前因背景工作進行中而暫存、延後送出的最終回覆（見下節）。

### 背景工作進行中的回覆會暫存

worker 常見的收尾是「起一個背景測試、說一句『等待中』、結束 turn」，背景工作完成時 Claude Code 再喚醒它。若每個「等待中」都立刻送出，指揮站每則都被喚醒一次。所以 turn 結束時**帳上仍有未通知的背景工作**，這則最終回覆不單獨送出，改為暫存，等下一則一起送。

- **什麼算背景工作**：背景 `Bash`（有 `backgroundTaskId`）、`Monitor`、背景 `Agent`／`Task`、`ScheduleWakeup`、`CronCreate`；只記主迴圈（不含 subagent 內）發起的。收到對應的完成通知（背景 `Bash`、`Monitor` 帶 `<status>` 的那一則、背景 Agent 的回傳、排程的觸發）就銷帳；`Monitor` 的中途事件通知不算結束。
- **暫存的條件（全部成立）**：正常答覆結束的主迴圈 turn、最終回覆非空、本 turn 結果檔沒有變更、worker 本 turn 沒有自己 `SendMessage`、帳上有未通知的背景工作。有結果檔變更、worker 自送、或沒有背景工作時，照原規則立即送出，單行提問也一樣。
- **暫存只延後、不丟棄**，以 `held-reply` 併入送出，任一成立即送：
  1. 下一個正常答覆結束的 turn（通常就是背景工作完成後那一則）——不論該 turn 自己有沒有東西要送、worker 是否自送。
  2. 從第一則暫存起算 **10 分鐘**（固定常數；連續暫存的回覆以空行串接，不重設時限）。
  3. session 結束（盡力而為；時間上限很短）。
- **時限到時**：計時器回呼裡**只叫醒 worker**——排入一個「只回覆 ok」的 prompt，由那個 turn 結束時的 `turn.complete` 送出暫存。不在回呼裡直接送件：auto mode 下回呼內的送件不經 `tool.check`，會被擋下。叫醒 turn 一定送出（即使帳上仍有背景工作），它自己的「ok」不附帶。時限到時 worker 正在 turn 中就不叫醒，該 turn 結束時直接送出；為防狀態誤判，每 60 秒重確認一次，連續 5 次仍在 turn 中就直接叫醒。
- **畫面一行**會說這則被暫存了：`↪ dispatch-relay：背景工作進行中，這則回覆已暫存，於下一則回報或最久 10 分鐘內轉送指揮站`。
- 暫存內容存在 `$.store`，重新載入 plugin 不會丟，計時器依原起算時間重排。暫存寫不進去時改為立即送出（寧可多喚醒一次，不漏送）。
- 帳是 mod 自己的記錄，不是 Claude Code 的內部狀態：漏登（未知的背景工具）只會變成立即送出；漏銷（完成通知沒對上）只會讓之後的等待中回覆被延後，每則仍受時限約束。兩種錯誤都不會漏送。

### 送不到的時候

- 名冊上找不到 `station`、同名多筆（不猜是哪一個）、或送件失敗：mod **先**把內容記為已處理，**再**排一個 prompt 請 worker 自己 `SendMessage`。prompt 裡給的收件位址依序是：mission 檔的 `station` 名稱（SendMessage 直接收名稱）、上次成功送達時的位址，最後才是最近一則來訊的 `from` 位址——而且僅限該則來自指揮站。worker 可能收過其他 session 的訊息，「回覆最近一則」會把回報送給第三方。
- 同一份內容只降級一次：降級那個 turn 裡再失敗，只在畫面與日誌說明，不再排 prompt，避免 worker 與 mod 互相觸發。
- 連請 worker 自送的 prompt 都排不進去時，把「已處理」回滾，下一次正常 turn 結束時重送；畫面會照實說哪些東西不會重送。結果檔以外的部分（暫存的 `held-reply`、最終回覆）沒有比對狀態可回滾，排入失敗就不重送。

完成與否仍以 mission 檔的完成條件為準：轉送的訊息只是門鈴。

## 安全邊界

**dispatch-relay 會把檔案內容送到另一個 session。** 送什麼、送給誰、何時不送：

- **送什麼**：只有本 session 對到的節點的結果檔，以及 worker 的最終回覆。結果檔路徑必須在 worker 的專案根目錄底下：mission 檔裡的絕對路徑、`~`、`..` 一律拒絕；讀檔前解析符號連結，指到根目錄外的不讀也不送。超過 256 KB 不送。
- **送給誰**：mission 檔的 `station` 名稱，在 `claude agents --json` 名冊上**恰好一筆**對到的 session。查無或多筆都不送（改請 worker 自己決定）。`station` 是自己時不啟用。
- **何時不送**：沒有啟用時（見上）；mission 沒有 `station` 時；turn 不是正常答覆結束時。
- **mission 檔從哪裡讀**：與 dispatch-board 相同的規則——只讀使用者層級目錄，否則 clone 一個陌生 repo 就能讓 mod 把你的檔案送給別人。
  - 預設 `~/.claude/missions/`。可在 `/plugin` 的設定改 `missions_dir`，但**只認使用者層級設定裡的值**（`$.settings.read({ source: 'user' })` 讀到的，通常是 `~/.claude/settings.json`）；專案設定給的值不採用。
  - 自訂目錄只要設一次：dispatch-relay 沒有自己的 `missions_dir` 時，沿用 dispatch-board 的 `missions_dir`。優先序是 dispatch-relay 自己的 → dispatch-board 的 → 預設；dispatch-board 的值同樣只認使用者層級設定。沒裝 dispatch-board 時不受影響。
  - 目錄解析符號連結後必須在家目錄底下、不在本 session 的專案目錄內、不在任何 git 工作樹內。個別 mission 檔經符號連結指到目錄外的不讀。
- **放行送件**：auto mode 下，plugin 的送件會被權限分類器擋下，所以 mod 在 `tool.check` 只放行**自己發出**的 `SendMessage`；其他來源（包括 worker 自己的 `SendMessage`）一律交給原本的流程，不攔截、不改寫、不放行。
- 不寫任何檔案（狀態存在 plugin 自己的 `$.store`）、不執行 mission 檔的完成條件、不連網、不呼叫模型。

## 安裝前看看它會做什麼

```bash
claude plugin validate ./plugins/dispatch-relay
```

結果（v0.2.0）：

```
hooks: session.start, prompt.submit, prompt.compose, turn.start, tool.call,
       tool.call{tool=SendMessage}, session.send, tool.check{tool=SendMessage},
       turn.complete, session.end
calls: $.clock.after, $.clock.now, $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.fs.stat,
       $.process.run, $.prompt.submit, $.session.cwd, $.session.id, $.session.root,
       $.session.send, $.settings.read, $.store.delete, $.store.get, $.store.set, $.ui.log
env reads: HOME
env writes: nothing
```

- `$.process.run`：只跑 `claude agents --json`
- `$.session.send`：唯一的送件點，送給名冊解析出的指揮站；只在 `turn.complete` 與 `session.end` 裡呼叫，計時器回呼不送件
- `$.prompt.submit`：只在兩處排入——送不到時請 worker 自己 `SendMessage`，與暫存時限到時叫醒 worker
- `$.clock.after`、`$.clock.now`：只用在暫存的時限（10 分鐘）與重確認
- `tool.call`（不限工具）：只觀察、原樣放行，用來記哪些背景工作還沒通知；不改寫工具的輸入或結果
- `$.fs.*`：只讀 mission 目錄、檢查安全邊界、讀結果檔；沒有寫檔

## 限制

- 需要 Claude Code **v2.1.296 以上**（`turn.complete`、`$.session.send`、`tool.check` 的 `next.origin.plugin`、`$.store`、`$.prompt.submit`、`$.clock.after`、`session.end`）。0.1.0 的下限是 v2.1.289；0.2.0 新用到的 `$.clock.after` 與 `session.end` 只在 v2.1.296 驗證過，更早的版本沒有逐版查。
- worker 必須有名字（`--name`）並出現在 `claude agents` 名冊上；沒命名的前景 session 對不到節點。
- 經 marketplace 安裝會在每個 session 載入。沒有 mission 寫 `station` 時它只讀 mission 目錄，不做別的事。
- 放行送件時無法驗證收件者：plugin 以 session id 送件時，`tool.check` 看到的收件者是引擎解析後的位址，對不回 session id，所以只驗證寄件 mod 是 dispatch-relay（這是固定的退化，不是異常，所以只在除錯日誌寫一次，不出現在對話畫面）。
- **`TaskStop` 成功時銷帳**（0.2.1）：worker 用 `TaskStop` 停掉背景 Bash、Monitor 或背景 Agent，且結果成功時，mod 會把帳上同 id 的那一筆銷掉（停掉的 Bash 與 Monitor 沒有完成通知，帳要靠這條銷）。`TaskStop` 失敗（id 不存在或已結束）、結果缺 `task_id`、或 id 對不上帳時不動帳，不會猜測式清帳；subagent 內的 `TaskStop` 不算。帳沒銷到時的最壞情形不變：之後的「等待中」回覆被延後到時限才送出（最久 10 分鐘，加重確認最多 5 分鐘），不會漏送；要立即回應時 worker 用 `SendMessage`。
- **排程刪除或停止後銷帳**（0.2.2）：`CronDelete` 成功時，以輸入的排程 id 銷掉 `CronCreate` 登的那一筆；`ScheduleWakeup` 以 `stop: true` 成功時，銷掉帳上的喚醒。`ScheduleWakeup` 的 `stop` 結果也帶 `scheduledFor`（Claude Code 2.1.301 實測為 0），0.2.1 以前會把它誤登成一筆新的待觸發喚醒，現在 `stop` 本身不登帳。新的 `ScheduleWakeup` 取代前一個待觸發的喚醒（同一 session 只會有一個），帳上同步只留新的。失敗、id 對不上帳、或在 subagent 內的呼叫不動帳。帳沒銷到時的最壞情形不變：之後的「等待中」回覆最久延後到時限。
- **名冊查無指揮站型失敗的辨識**（0.2.2）：送件失敗原因含引擎的 `no live session on this machine has id` 時，畫面與日誌附一句說明——名冊以 session id 查不到指揮站，指揮站程序可能仍存活（名冊該列缺 pid 即此型，Claude Code 2.1.296 上指揮站以 bg job 執行時出現）。只改文字，降級規則不變，mod 不自行改送其他位址。
- 暫存的回覆最久晚 10 分鐘到達指揮站。叫醒每次多一個 request（輸出幾個 token，讀的是 prompt cache；叫醒間隔若超過帳號的 cache TTL，會變成整份 context 的重新建立，這部分沒量過）。
- 叫醒文字與背景工作的完成通知幾乎同時到時，叫醒旗標只認「下一個主迴圈 turn」，不比對文字：極少數情形下通知先開了 turn，那個 turn 的最終回覆（進度性質）會被當成叫醒 turn 而不附帶；暫存內容仍會送出。
- session 被強制終止或崩潰時，暫存可能沒送出（內容仍在 worker 的 transcript 裡）；`session.end` 時還沒解析過指揮站 id 的話暫存保留在 `$.store`，不送也不清。
- 不隱藏 worker 畫面上的最終回覆、不代寫結果檔。

## 開發

```bash
claude --plugin-dir ./plugins/dispatch-relay   # 單次載入
claude plugin test ./plugins/dispatch-relay     # 跑測試
```

## English

**dispatch-relay** is the worker-side companion to dispatch-board. Instead of a worker writing its report and then sending the whole thing again with `SendMessage`, the worker writes the report to a result file (default `.mission-result.md` in its project root) and ends the turn with one line; at the end of each turn the mod sends what changed in that file, plus the worker's final reply, to the commanding session.

It is opt-in per mission: add `"station": "<commander session name>"` to a dispatch-board mission file. A session activates only if `claude agents --json` maps its own session id (`$.session.id()`) to a name that exactly one node's `session` matches (case-insensitive) in a mission that has a `station`. The station name is resolved to a session id from the roster before every send; no match or duplicate names means no send — the worker is asked to send it itself instead (once per content; no loops). Sessions with no stationed mission do nothing, not even read the roster.

**Security:** the mod sends file contents to another session. It sends only the matched node's result file (relative to the project root, no absolute paths or `..`, symlinks resolved and kept inside the root, 256 KB cap) and the final reply, only to the one roster session named by `station`. Mission files are read under the same rules as dispatch-board: a user-level directory under your home, outside the session's project and any git work tree; a custom `missions_dir` is honoured only from user-level settings (what `$.settings.read({ source: 'user' })` returns, normally `~/.claude/settings.json`), and when dispatch-relay has none of its own it reuses dispatch-board's (from the same source). Both sessions must be started with `--name`; run `claude` once in a new directory to accept the trust prompt before the first `claude --bg` there; for a `--worktree <name>` worker, `result_file` is relative to `<repo>/.claude/worktrees/<name>`. When forwarding fails, the worker is pointed at the `station` name first, and at the latest `from` address only if that message came from the station. In `tool.check` it allows only its own `SendMessage`; everything else passes through untouched. It writes no files and runs no completion checks.

**Held replies (0.2.0):** a worker that starts a background job and ends its turn with a "waiting…" line would otherwise wake the commander once per such turn. When a turn ends while background work is still un-notified (background `Bash`, `Monitor`, background `Agent`, `ScheduleWakeup`, `CronCreate`, started by the main loop; settled by the matching completion notification), the final reply is held in the plugin's `$.store` instead of sent, provided the result file did not change and the worker did not `SendMessage` itself that turn. Held text is never dropped: it goes out as a `held-reply` part (order: result file → `held-reply` → `final-reply`) on the next normally-answered turn, after a fixed 10-minute limit counted from the first held reply, or at `session.end` (best effort). At the limit the timer callback only wakes the worker with a "reply ok" prompt and that turn's `turn.complete` does the send, because a send from inside a timer callback is refused under auto mode; the wake turn's own "ok" is not forwarded. The screen shows a line when a reply is held. A worker that needs the commander right away should use `SendMessage` itself, which is never delayed. **TaskStop (0.2.1):** a successful `TaskStop` from the main loop settles the matching background-job entry by task id (a stopped `Bash` or `Monitor` produces no completion notification, so this is the only way it gets settled). A failed `TaskStop` (unknown or already finished id), a result without `task_id`, or an id not on the ledger changes nothing and never clears the ledger by guesswork; a `TaskStop` inside a subagent is ignored. If an entry is somehow left unsettled, later "waiting" replies are still delayed only up to the 10-minute limit (never lost). **Schedule settling (0.2.2):** a successful `CronDelete` settles the ledger entry that `CronCreate` registered (matched by the cron id from the call input), and a successful `ScheduleWakeup` with `stop: true` settles the pending wakeup. A `stop` result also carries `scheduledFor` (0 on Claude Code 2.1.301), which earlier versions registered as a new pending wakeup; `stop` is now never registered. A new `ScheduleWakeup` replaces the previous pending wakeup on the ledger. Failed calls, ids not on the ledger and calls inside a subagent change nothing. **Roster-miss hint (0.2.2):** when forwarding fails with the engine's `no live session on this machine has id`, the screen and log line add a note that the roster could not find the station by session id (the station process may still be alive; seen on Claude Code 2.1.296 when the roster row lacks a pid). Text only, the degrade rules are unchanged. Requires Claude Code v2.1.296+.
