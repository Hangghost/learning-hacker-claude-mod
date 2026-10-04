# handoff-runner

讓 bg session 在 git worktree 裡做完的分支，由你在面板**按一顆按鈕**快轉（fast-forward）進目標分支（通常是 `main`）。

適用情境：你用 bg session＋worktree 平行開發。分支做完了，但 `main` 被另一個 checkout（通常是你的主工作目錄）持有，bg session 改不到它，只能停下來等你手動合併。handoff-runner 把「等你手動合併」變成一張**交接單**：session 簽發，你在面板看過事前檢查與要跑的完整指令後按「執行」。

## 流程

```
bg session（worktree）                 你（任何同 repo 的 session）
────────────────────────               ─────────────────────────────────
做完 feature/x
呼叫工具 handoff_issue ──寫交接單──▶  prompt 上方出現 ⇄ 1 張交接單等你
                                        /handoff 打開面板：事前檢查＋完整指令
                                        按「執行」→ 快轉 → 事後驗證 → toast
```

## 安全性質

這個 mod 的設計重點是「session 可以請求落地，但不能自己落地」：

- **交接單只帶參數**：`branch`、`target` 和簽發當下釘住的 `sha`。沒有路徑、沒有指令。手寫或被竄改的交接單裡多出的欄位一律忽略，參數不合法就判 `invalid`、不給執行按鈕。
- **步驟由 mod 推導**：要跑的 git 指令在每次檢查時由程式依參數與 repo 的當下狀態產生，只會是 `git merge --ff-only <sha>`、`git update-ref …`、（開啟時）`git push <remote> <sha>:refs/heads/<target>` 三種形狀，執行前再對形狀做一次白名單檢查；不會 force、不會刪分支。
- **唯一的執行入口是面板的「執行」按鈕**。model 可呼叫的工具與 `/handoff` 指令只能簽發或開面板；mod 不送 prompt、不派 subagent、不呼叫 model。這條由 `tests/boundary.mjs` 的靜態檢查守著（附違規注入的 known-positive）。
- **畫面即執行**：按下時重新推導一次，與畫面上的步驟（名稱＋完整 argv）逐字比對，不同就不執行並記為 stale。
- **只快轉到釘住的 commit**：簽發後分支又前進、或目標分支被別人推進，事前檢查就不成立，要重新簽發。
- 檢查用的 git 只有唯讀子命令（`rev-parse`、`merge-base`、`status`、`diff --name-only`、`worktree list`、`check-ref-format`、`ls-remote`），由白名單把關。Claude Code 以 `$.process.run` 跑 git 時關閉 repo hooks。

## 使用

### 簽發

三種入口，效果相同（都只寫交接單，不執行）：

| 入口 | 誰用 | 說明 |
|---|---|---|
| 工具 `handoff_issue` | Claude | 參數 `branch`（必填）、`target`（預設 `main`）。在 session 裡列為 `mcp__handoff-runner__handoff_issue` |
| `/handoff issue <branch> [target]` | 你 | 手動簽發 |
| 面板的「簽發 …」按鈕 | 你 | 列出被 worktree checkout、可快轉進預設目標、還沒有待辦單的分支 |

簽發時會檢查：兩個分支名合法、都存在於本機、`branch` 還沒併進 `target`、`target` 能快轉到 `branch`（不能就請先 rebase）。同一分支同一 commit 重簽會沿用舊單；分支前進後重簽會撤掉舊單。

想讓 bg session 自動用它，可以在專案的 `CLAUDE.md` 加一句：「在 worktree 完成的分支，用 handoff_issue 工具簽發交接單，不要自己合併到 main。」

### 執行

`/handoff` 開關面板。每張待辦單顯示：

```
feature/x → main
✓ P1 feature/x = 3f2a9c10，交接單釘住 3f2a9c10
✓ P2 main（8b1e4d22）可快轉到 3f2a9c10
✓ P3 /path/to/repo 持有 main，工作樹乾淨
執行 S1 main 快轉到 3f2a9c10（在 /path/to/repo）
  git -C /path/to/repo merge --ff-only 3f2a9c10…
[ 執行 ] [ 撤單 ]
```

| 檢查 | 內容 |
|---|---|
| P1 | 分支 tip 仍是釘住的 sha |
| P2 | 目標分支是 sha 的祖先（可快轉） |
| P3 | 目標分支被哪個 worktree 持有；有持有者時，它未 commit 的變更不能與這次落地改到的檔案重疊（無重疊的變更會保留）。沒有持有者時改用 `git update-ref`，並帶預期舊值，目標在這之間被動過就失敗 |
| P4 | （push 開啟時）remote 上的目標分支能快轉到 sha；讀不到 remote 也擋下 |

P1、P2 不成立判 `stale`，P3、P4 不成立判 `blocked`，兩者都沒有執行按鈕。

按「執行」：取得認領鎖（避免多個 session 重複執行）→ 重新推導並比對 → 依序執行（已完成的步驟略過、失敗即停）→ 事後驗證 → 寫結果檔 → 釋放鎖 → toast 一行摘要。

| 驗證 | 內容 |
|---|---|
| V1 | 本機目標分支已含 sha |
| V2 | （有持有者時）持有者的 HEAD 跟上目標分支 |
| V3 | （push 開啟時）remote 上的目標分支已含 sha |

## 交接單存放位置與格式

`<git common dir>/handoffs/`（一般 repo 就是 `.git/handoffs/`）。在 `.git` 裡，不會被 commit，同一個 repo 的所有 worktree 都看得到。

```json
{
  "schema": 1,
  "id": "x-20261004-120000",
  "kind": "ref-land",
  "created_at": "2026-10-04T12:00:00.000Z",
  "issuer": { "via": "tool" },
  "params": { "branch": "feature/x", "target": "main", "sha": "<40 位 commit 雜湊>" }
}
```

同目錄的 `<id>.result.json` 是最近一次結果（`passed`／`failed`／`stale`／`blocked`／`dismissed`，含每步的 exit code 與驗證），`<id>.lock/` 與 `<id>.lock.json` 是認領鎖（逾時 15 分鐘可被接手）。

## 設定

`/config` 裡的 handoff-runner 欄位（或 settings 的 `pluginConfigs`）：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `push` | `false` | 快轉後 push 目標分支。預設關閉：push 是對外的動作，各人的 remote 習慣不同 |
| `remote` | `origin` | push 用的 remote |
| `defaultTarget` | `main` | 簽發時沒指定目標就用它，也是面板候選清單的目標 |

## 限制

- 只做一件事：把 `branch` 快轉進 `target`（可選 push）。不做 merge commit、rebase、刪分支、打 tag。
- 交接單與面板以 session 所在的 repo 為範圍；不同 repo 各自一份。
- 按鈕只出現在終端機與 Claude Desktop 的 Code 分頁；`claude -p` 沒有面板，只能簽發。

## 安裝前看看它會做什麼

```bash
claude plugin validate ./plugins/handoff-runner
```

v0.1.0 的結果：

```
hooks: session.start, tool.call{tool=mcp__handoff-runner__handoff_issue}, command.run{command=handoff},
       ui.close, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=handoff-runner}
calls: $.clock.every, $.command.register, $.fs.list, $.fs.read, $.fs.write, $.process.run,
       $.session.cwd, $.state.get, $.state.set, $.tool.register, $.ui.close, $.ui.open,
       $.ui.resolve, $.ui.toast
```

- `$.fs.*` 只讀寫 `<git common dir>/handoffs/` 底下的檔。
- `$.process.run` 跑三種東西：唯讀的 git 檢查、`mkdir`／`rmdir`（認領鎖）、以及按下「執行」後的落地步驟。
- `$.tool.register` 註冊簽發工具；它不執行任何 git 寫入。
- 不連網，除非你開啟 `push`（此時會跑 `git ls-remote` 與 `git push`）。不呼叫模型、不改動任何 tool call 或 prompt。

## 開發

```bash
claude --plugin-dir ./plugins/handoff-runner        # 單次載入
claude plugin test ./plugins/handoff-runner          # 面板、按鈕、簽發（假 git）
node plugins/handoff-runner/tests/real-git.mjs       # 在暫存 repo 上用真 git 落地（Node 23.6+）
node plugins/handoff-runner/tests/boundary.mjs       # 唯一執行入口的靜態檢查
```

`hooks/git.ts` 是交接單存取與唯讀檢查（沒有執行入口），`hooks/logic.ts` 是純函式，`hooks/register.tsx` 是面板與唯一的執行點 `runTicket`。`tsconfig.json` 依賴 `.claude-plugin/types/`，那是 Claude Code 產生的型別檔，不放進 repo。

## English

**handoff-runner** lets a background Claude Code session that finished a branch in a git worktree hand it off to you: the session issues a *ticket*, and you fast-forward the target branch (usually `main`) with one button press in the `/handoff` pane.

- The ticket carries parameters only (`branch`, `target`, pinned `sha`), never commands or paths. The git steps are derived by the mod from those parameters and the repo's current state, shown in full, and limited to `merge --ff-only`, `update-ref` with an expected old value, and (opt-in) a non-force `push`.
- The only execution path is the pane's **Run** button. The model-callable tool `handoff_issue` and `/handoff issue <branch> [target]` only write tickets.
- Before running: the branch tip still equals the pinned sha, the target can fast-forward to it, the worktree holding the target has no uncommitted changes overlapping the landing, and (with push on) the remote can fast-forward. On press the steps are re-derived and must match what was displayed. After running: the target contains the sha, the holder's HEAD followed, and (with push on) the remote has it.
- Tickets live in `<git common dir>/handoffs/`, shared by all worktrees and never committed. Push is off by default (`userConfig.push`).
