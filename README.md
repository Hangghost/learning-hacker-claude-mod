# learning-hacker-claude-mod

Learning Hacker 的 [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) 合集。主題有兩個：把 agent 的運作畫成看得懂的東西，以及讓「同時開好幾個 Claude Code session 分工」這件事變順。

> 狀態：照現狀提供（as-is），作為示範與實用工具分享，不提供支援。

## 收錄的 mod

| mod | 做什麼 | 版本 |
|---|---|---|
| [`dispatch-board`](plugins/dispatch-board) | 多個 session 分工時的派工看板：讀你寫的 mission 檔，顯示誰完成、誰在跑、誰在等你，狀態轉換時跳 toast | 0.1.0 |
| [`dispatch-relay`](plugins/dispatch-relay) | dispatch-board 的搭檔：worker 把回報寫進結果檔後以一行結束，由 mod 在 turn 結束時轉送給指揮站 | 0.1.0 |
| [`handoff-runner`](plugins/handoff-runner) | bg session 在 worktree 做完的分支，由你在面板按一顆按鈕快轉進 main，執行前檢查、執行後驗證 | 0.1.0 |
| [`working-memory`](plugins/working-memory) | 把 context window 畫成一顆腦：工具呼叫點亮對應腦區，用量越滿越擁擠，compact 時睡眠整理 | 0.1.0 |

每個 mod 都可以單獨安裝，不用全裝。

## 安裝

需要 Claude Code **v2.1.287 以上**（`claude --version` 確認）。

先加入 marketplace（一次就好）：

```
/plugin marketplace add Hangghost/learning-hacker-claude-mod
```

再挑想要的裝：

```
/plugin install dispatch-board@learning-hacker-claude-mod
/plugin install dispatch-relay@learning-hacker-claude-mod
/plugin install handoff-runner@learning-hacker-claude-mod
/plugin install working-memory@learning-hacker-claude-mod
```

dispatch-relay 需要 v2.1.289 以上。

在 shell 裡用 `claude plugin marketplace add …`、`claude plugin install …` 也可以。已開著的 session 執行 `/reload-plugins` 載入。

**更新**：第三方 marketplace 的自動更新預設關閉。可在 `/plugin` 的 Marketplaces 分頁對本 marketplace 選 Enable auto-update，或手動執行 `/plugin marketplace update learning-hacker-claude-mod`。

## dispatch-board：多 session 派工看板

同時開幾個 session 各做一段工作時，你很難一眼看出誰做完了、誰卡住在等你。dispatch-board 讀你寫的 mission 檔，在提示框上方放一行摘要，`/dispatch` 打開完整面板。

- mission 檔是一個 JSON：列出節點、負責的 session 名稱、完成條件（一條 shell 指令，結束碼 0 代表完成）
- 面板分成「需要你／跑著／做完待收斂」，完成條件跑不起來時顯示「無法判定」，不會被當成還在跑
- session 狀態取自 `claude agents --json`
- `/dispatch demo` 用假資料試看畫面

**安全邊界**：完成條件是 shell 指令，mod 會執行它，所以 mission 檔**只從使用者層級的目錄讀**（預設 `~/.claude/missions/`），不讀任何專案目錄或 repo 內的檔案，也不接受專案設定改掉這個目錄。clone 一個陌生 repo 不會讓 mod 執行對方寫的指令。

mission 檔格式與範例見 [plugins/dispatch-board/README.md](plugins/dispatch-board/README.md)。

## dispatch-relay：worker 的回報自動送到指揮站

分工時 worker 做完要自己 `SendMessage` 把回報全文送給指揮站，同一份回報等於生成兩次，送完還要多跑一次收尾。dispatch-relay 裝在 worker 那一側：worker 把回報寫進結果檔、以一行結束 turn，mod 在 turn 結束時把新增的內容和最終回覆原文送給指揮站。

- 在 dispatch-board 的 mission 檔加上 `station`（指揮站的 session 名稱）才啟用；沒寫的 mission 不受影響
- 身份判定：本 session 的 id → `claude agents --json` 查出名稱 → mission 檔裡恰好一個節點指派給這個名稱才啟用
- 只送有變更的內容（追加時只送追加段）；送不到時請 worker 自己 `SendMessage`，同一份內容只請一次

前提：指揮站與 worker 都要用 `--name` 開，名稱與 `claude agents` 一致；新目錄第一次 `claude --bg` 前先在該目錄跑一次 `claude` 接受信任（否則回 `Workspace not trusted…`）；用 `--worktree <名>` 開的 worker，`result_file` 相對的是 `<repo>/.claude/worktrees/<名>`。自訂 mission 目錄只要在 dispatch-board 設一次，relay 會沿用。

**安全邊界**：mod 會把檔案內容送到另一個 session。它只送對到的節點的結果檔（必須在 worker 的專案根目錄底下，解析符號連結後也一樣）與最終回覆，只送給名冊上**恰好一筆**對到 `station` 的 session；mission 檔的讀取規則與 dispatch-board 相同。`tool.check` 只放行它自己發出的送件。

細節見 [plugins/dispatch-relay/README.md](plugins/dispatch-relay/README.md)。

## handoff-runner：一鍵把 worktree 分支落地

背景 session 在自己的 worktree 做完一條分支後，要併進 main，但 main 正被你的主 checkout 持有，背景 session 動不了它。handoff-runner 讓 session 簽發一張「交接單」，你在 `/handoff` 面板看過步驟後按「執行」，由 mod 完成 fast-forward。

- Claude 可以呼叫工具 `handoff_issue` 簽發交接單，也可以用 `/handoff issue <branch> [target]` 手動簽發
- 交接單放在 `<git common dir>/handoffs/`，在 `.git` 裡面，不會被 commit
- 執行前檢查：分支沒有前進、目標可以 fast-forward、持有目標分支的 worktree 在落地路徑上沒有未提交的修改
- 執行後驗證：目標分支確實前進到該 commit
- 預設**不** push，可在設定開啟

**安全邊界**：交接單**只帶參數**（分支、目標、釘住的 commit），不帶任何指令。要執行的 git 步驟由 mod 依參數產生，執行前比對「畫面上顯示的步驟」與「實際要跑的步驟」完全一致，並只允許 fast-forward、帶預期舊值的 ref 更新、非強制的 push。偽造的交接單最多只能讓自己從面板消失，不能讓 mod 執行別的指令。

細節見 [plugins/handoff-runner/README.md](plugins/handoff-runner/README.md)。

## working-memory：把 context 畫成一顆腦

`/brain` 在側邊開一個 pane，畫出一顆側面的腦（左邊是前額）。

| 腦區 | 比喻 | 什麼時候亮 |
|---|---|---|
| 額葉 | 規劃 | 送出 prompt、TaskCreate／TodoWrite、Skill |
| 運動皮質 | 動手改 | Edit、Write |
| 頂葉 | 操作環境 | Bash 與其他工具 |
| 枕葉 | 閱讀 | Read、Grep、Glob |
| 顳葉 | 聽外界 | WebFetch、WebSearch、MCP 工具 |
| 小腦 | 分身協作 | Agent、SendMessage |

- context 用量越高，腦裡被 `░` 填滿的格子越多；超過 85% 會紅色閃爍
- compact 時，一道 `✦` 光波從後腦掃到前額，代表「睡眠整理記憶」

腦區對應是比喻，不是神經科學主張。

## 安裝前看看它會做什麼

mod 不在沙盒裡執行，會以你的權限跑在 Claude Code 內。建議安裝前先讀原始碼，或 clone 後執行 `claude plugin validate ./plugins/<名稱>`，看它處理哪些事件、呼叫哪些能力。以下是 v0.1.0 的結果：

**dispatch-board**

```
hooks: session.start, command.run{command=dispatch}, ui.close, ui.render{component=AbovePrompt},
       ui.render{component=Pane, requestId=dispatch-board}
calls: $.clock.every, $.clock.now, $.command.register, $.env.get, $.fs.exists, $.fs.list, $.fs.read,
       $.fs.stat, $.process.run, $.session.cwd, $.session.root, $.settings.read, $.state.get,
       $.state.set, $.ui.close, $.ui.copy, $.ui.open, $.ui.resolve, $.ui.toast
```

`$.process.run` 只用來跑你 mission 檔裡的完成條件（`/bin/sh -c`，每條 5 秒逾時）和 `claude agents --json`；檔案只讀不寫；不連網、不呼叫模型、不送 prompt。

**dispatch-relay**

```
hooks: session.start, prompt.submit, prompt.compose, turn.start, tool.call{tool=SendMessage},
       session.send, tool.check{tool=SendMessage}, turn.complete
calls: $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.fs.stat, $.process.run, $.prompt.submit,
       $.session.cwd, $.session.id, $.session.root, $.session.send, $.settings.read,
       $.store.delete, $.store.get, $.store.set, $.ui.log
```

`$.process.run` 只跑 `claude agents --json`；`$.session.send` 只送給 mission 檔 `station` 對到的那一個 session；`$.prompt.submit` 只在送不到時請 worker 自己送；檔案只讀不寫；不連網、不呼叫模型。

**handoff-runner**

```
hooks: session.start, tool.call{tool=mcp__handoff-runner__handoff_issue}, command.run{command=handoff},
       ui.close, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=handoff-runner}
calls: $.clock.every, $.command.register, $.fs.list, $.fs.read, $.fs.write, $.process.run,
       $.session.cwd, $.state.get, $.state.set, $.tool.register, $.ui.close, $.ui.open,
       $.ui.resolve, $.ui.toast
```

檔案只讀寫 `<git common dir>/handoffs/` 底下；`$.process.run` 只跑唯讀的 git 檢查、交接單的鎖，以及你按下「執行」後的落地步驟；只有開啟 push 時才連網；不呼叫模型、不送 prompt。

**working-memory**

```
hooks: session.start, command.run{command=brain}, prompt.submit, tool.call,
       session.measure, session.compact, ui.render{component=Pane, requestId=working-memory}
calls: $.clock.every, $.command.register, $.session.usage, $.state.get, $.state.set,
       $.ui.open, $.ui.resolve
```

只讀工具呼叫的名稱與參數摘要來畫圖，不讀寫檔案、不啟動程式、不連網、不呼叫模型。

## 開發

```bash
claude --plugin-dir ./plugins/<名稱>   # 單次載入
claude plugin test ./plugins/<名稱>     # 跑測試
```

handoff-runner 另有兩支需要 Node 23.6 以上的測試：`node plugins/handoff-runner/tests/real-git.mjs`（在暫存 repo 上用真的 git 落地）與 `node plugins/handoff-runner/tests/boundary.mjs`（檢查執行入口只有一個）。

各 plugin 的 `tsconfig.json` 依賴 `.claude-plugin/types/`，那是 Claude Code 產生的型別檔，不放進 repo。

## English

A collection of Claude Code mods by Learning Hacker. Shared as-is, without support. Each mod installs on its own.

```
/plugin marketplace add Hangghost/learning-hacker-claude-mod
/plugin install dispatch-board@learning-hacker-claude-mod
/plugin install dispatch-relay@learning-hacker-claude-mod
/plugin install handoff-runner@learning-hacker-claude-mod
/plugin install working-memory@learning-hacker-claude-mod
```

Requires Claude Code v2.1.287+ (dispatch-relay: v2.1.289+).

- **dispatch-board**: a board for running several Claude Code sessions in parallel. Reads mission files you write (nodes, the session responsible, a shell command that exits 0 when done) and shows who is done, who is running and who is waiting on you. Mission files are read only from a user-level directory (default `~/.claude/missions/`), never from a project, so cloning a repo cannot make it run someone else's commands.
- **dispatch-relay**: the worker-side companion to dispatch-board. A worker writes its report to a result file and ends the turn with one line; the mod forwards what changed, plus the final reply, to the commanding session named by the mission's `station` field (opt-in per mission). It sends only the matched node's result file, kept inside the worker's project root, and only to the one roster session matching `station`.
- **handoff-runner**: lets a background session that finished a branch in its own worktree issue a handoff ticket, which you land into `main` with one button. Tickets carry only parameters (branch, target, pinned commit); the git steps are derived by the mod, checked before running and verified after. Push is off by default.
- **working-memory**: draws your context window as a brain. Tool calls light up regions, the brain fills up as context grows, and compaction plays a "sleep" sweep.

## License

MIT
