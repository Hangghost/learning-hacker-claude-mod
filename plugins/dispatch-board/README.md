# dispatch-board

同時開好幾個 Claude Code session 分工時用的派工看板。你寫一份 mission 檔，列出有哪些節點、各由哪個 session 負責、怎樣算做完；看板在終端機顯示誰完成、誰在跑、誰在等你，狀態一轉換就跳 toast。

```
⧉ shop-redesign 1/3 · 1 需要你 · 4s 前
```

`/dispatch` 打開側邊面板：

```
mission 目錄 ~/.claude/missions
需要你（1）
shop-redesign  ▓▓▓░░░░░░░ 1/3  商店改版
  ✓ api 後端 API · 閒置 shop-api
  ⏸ web 前端頁面 · 等你 3m · blocked shop-web
  ○ e2e 端對端測試 · 等依賴 web · 不在名冊 shop-e2e
上次更新：2s 前
[ 立即更新 ][ 關閉 ]
```

## 用法

1. 建立 `~/.claude/missions/`，放一份 mission 檔（`*.json`，格式見下）。
2. 照 mission 檔裡寫的名字開 session，例如 `claude --bg --name shop-api`（名字要和 `claude agents` 列出的一樣，不分大小寫）。
3. 在任何一個 session 打 `/dispatch` 開面板。

| 指令 | 作用 |
|---|---|
| `/dispatch` | 開關面板 |
| `/dispatch off` | 本 session 停止讀 mission、停止執行完成條件；再打 `/dispatch` 恢復 |
| `/dispatch demo` | 用假資料試看（不讀目錄、不執行任何指令）；再打一次結束 |

也可以用環境變數 `DISPATCH_BOARD_DEMO=1` 啟動 demo 模式，方便錄影。

## mission 檔

一個 JSON 檔一個 mission，放在 mission 目錄的第一層（子目錄不讀，所以做完的檔可以搬到 `done/`）。

```json
{
  "mission_id": "shop-redesign",
  "title": "商店改版",
  "nodes": [
    {
      "id": "api",
      "title": "後端 API",
      "session": "shop-api",
      "done": "git -C ~/code/shop log --oneline origin/feature/api | grep -q '\\[api-done\\]'"
    },
    {
      "id": "web",
      "title": "前端頁面",
      "session": "shop-web",
      "done": "test -f ~/code/shop/web/dist/index.html"
    },
    {
      "id": "e2e",
      "title": "端對端測試",
      "session": "shop-e2e",
      "done": "grep -q 'ALL PASSED' ~/code/shop/e2e-report.txt",
      "depends_on": ["api", "web"]
    }
  ]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `mission_id` | 否 | 英數、`_ . -`；省略時用檔名 |
| `title` | 否 | 顯示用 |
| `nodes[].id` | 是 | 英數、`_ . -`，同一份 mission 內不重複 |
| `nodes[].title` | 否 | 顯示用 |
| `nodes[].session` | 否 | 負責的 session 名稱；省略＝不對名冊 |
| `nodes[].done` | 是 | 完成條件：一行 shell 指令，退出碼 0＝完成 |
| `nodes[].depends_on` | 否 | 依賴的節點 id |

`examples/shop-redesign.json` 是同一份範例，可以複製過去改。

### 完成條件怎麼求值

- 用 `/bin/sh -c` 執行，工作目錄是家目錄，每條 5 秒逾時，最多同時跑 4 條。
- 退出碼 0＝完成；其他退出碼＝還沒完成。
- **逾時、指令跑不起來（shell 回 126／127）＝無法判定**，顯示 ✗ 並歸到「需要你」，不會畫成「還在跑」。壞掉的條件如果被當成還沒完成，你會一直等下去。
- 面板開著時每 5 秒求值一次，關著時每 30 秒一次。目錄裡沒有 mission 檔時只列目錄，不執行任何指令、不讀名冊。
- 完成條件不會被快取：條件之後又不成立（例如分支被刪），節點會回到未完成。

建議用「工作產出」當完成條件（commit 訊息、檔案存在、測試報告），而不是 session 自己說做完了。

### session 狀態

來自 `claude agents --json`：

| 顯示 | 意思 |
|---|---|
| 工作中／閒置／blocked | session 在名冊上；blocked 代表它在等你回覆 |
| 已結束 | 看板啟動後看過它，現在名冊上沒有了 |
| 不在名冊 | 名冊上沒有，也沒看過（還沒開，或在看板啟動前就結束了） |
| 名冊不可用 | `claude agents --json` 跑不起來或輸出看不懂；**不會**顯示成已結束 |

### 面板分組

- **需要你**：有 session blocked、有條件無法判定、或 session 已結束但條件沒達成
- **跑著**：其餘還沒完成的
- **做完待收斂**：所有節點都完成。附一顆按鈕，把「把 mission 檔搬到 `done/`」的指令複製到剪貼簿；mod 自己不搬檔

狀態轉換時跳 toast：節點完成、條件變成無法判定、session 開始等你、session 結束但沒完成、整份 mission 完成、新出現讀不了的 mission 檔。看板啟動後的第一份快照只作基準，不跳 toast。

## 安全邊界

**mission 檔裡的完成條件是 shell 指令，看板會以你的身分執行它。** 所以 mission 檔只從使用者層級的目錄讀，絕不讀專案目錄或 repo 裡的檔案，否則 clone 一個陌生 repo 就等於執行對方寫的指令。具體規則：

- 預設目錄 `~/.claude/missions/`。可以在 `/plugin` 的設定改 `missions_dir`（`~/…` 或絕對路徑），但**只認 `~/.claude/settings.json` 裡的值**；專案的 `.claude/settings.json`、`settings.local.json` 或 `--settings` 給的值一律不採用。
- 目錄解析符號連結後必須在家目錄底下（不能是家目錄本身），不能在本 session 的專案目錄內，也不能在任何 git 工作樹內（從該目錄往上到家目錄之間任一層有 `.git` 就拒讀）。
- 個別 mission 檔經符號連結指到目錄外的，拒讀並列在「讀不了的 mission 檔」。
- 讀不到家目錄（`HOME` 未設定）就整個停用。
- 任何一條不符合都直接拒讀並在 band 顯示原因，不會退而求其次改讀別處。

除此之外 mod 是唯讀的：不寫檔、不送 prompt、不碰其他 session。

## 安裝前看看它會做什麼

```bash
claude plugin validate ./plugins/dispatch-board
```

結果（v0.1.0）：

```
hooks: session.start, command.run{command=dispatch}, ui.close,
       ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=dispatch-board}
calls: $.clock.every, $.clock.now, $.command.register, $.env.get,
       $.fs.exists, $.fs.list, $.fs.read, $.fs.stat,
       $.process.run, $.session.cwd, $.session.root, $.settings.read,
       $.state.get, $.state.set, $.ui.close, $.ui.copy, $.ui.open,
       $.ui.resolve, $.ui.toast
env reads: DISPATCH_BOARD_DEMO, HOME
env writes: nothing
```

- `$.process.run`：執行 mission 檔的完成條件（`/bin/sh -c`），以及 `claude agents --json`
- `$.fs.*`：只讀 mission 目錄與檢查安全邊界（解析路徑、找 `.git`）；沒有寫檔
- `$.settings.read`：只讀使用者層級設定，確認自訂的 `missions_dir` 從哪裡來
- 不連網、不呼叫模型

## 限制

- 只在終端機與 Claude Desktop 的 Code 分頁畫；`claude -p` 不輪詢。
- 每個開著的互動 session 各自輪詢；session 開得多，完成條件就會被多個 session 重複執行，條件請保持便宜、沒有副作用。
- 完成條件依賴 `/bin/sh`，Windows 未測試。

## 開發

```bash
claude --plugin-dir ./plugins/dispatch-board   # 單次載入
claude plugin test ./plugins/dispatch-board     # 跑測試
```

## English

**dispatch-board** is a dispatch board for running several Claude Code sessions in parallel. You write a mission file (`~/.claude/missions/*.json`) listing nodes, the session responsible for each, and a completion check (a shell command; exit 0 means done). The board shows a one-line band above the prompt and a `/dispatch` side pane grouped into *needs you / running / done, ready to wrap up*, and toasts on state transitions. Session state comes from `claude agents --json`; an unreadable roster is shown as "roster unavailable", never as "ended". A check that times out (5 s) or cannot run is shown as *undetermined* and grouped under *needs you*, never as still running. `/dispatch demo` shows fake data without reading anything or running any command.

**Security:** completion checks are executed as you, so mission files are read only from a user-level directory: under your home directory, outside the session's project, outside any git work tree, with symlinks resolved. A custom `missions_dir` is honoured only from `~/.claude/settings.json`. Anything else is refused with the reason shown. The mod writes no files, sends no prompts, makes no network requests and calls no model.
