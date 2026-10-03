# learning-hacker-claude-mod

Learning Hacker 的 [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) 合集。主題是把 agent 的運作畫成看得懂的東西。

> 狀態：照現狀提供（as-is），作為示範與好玩的作品分享，不提供支援。

## 收錄的 mod

| mod | 做什麼 | 版本 |
|---|---|---|
| [`working-memory`](plugins/working-memory) | 把 context window 畫成一顆腦：工具呼叫點亮對應腦區，用量越滿越擁擠，compact 時睡眠整理 | 0.1.0 |

## 安裝

需要 Claude Code **v2.1.287 以上**（`claude --version` 確認）。

在 Claude Code 裡：

```
/plugin marketplace add Hangghost/learning-hacker-claude-mod
/plugin install working-memory@learning-hacker-claude-mod
```

或在 shell：

```bash
claude plugin marketplace add Hangghost/learning-hacker-claude-mod
claude plugin install working-memory@learning-hacker-claude-mod
```

已開著的 session 執行 `/reload-plugins` 載入，之後打 `/brain` 打開腦圖。

**更新**：第三方 marketplace 的自動更新預設關閉。可在 `/plugin` 的 Marketplaces 分頁對本 marketplace 選 Enable auto-update，或手動執行 `/plugin marketplace update learning-hacker-claude-mod`。

## working-memory

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
- 下方列出最近 6 筆「神經活動」

腦區對應是比喻，不是神經科學主張。

畫面只出現在終端機與 Claude Desktop 的 Code 分頁；VS Code 擴充的聊天面板、`claude -p` 不會畫。

## 安裝前看看它會做什麼

mod 不在沙盒裡執行，會以你的權限跑在 Claude Code 內。建議安裝前先讀原始碼，或 clone 後執行：

```bash
claude plugin validate ./plugins/working-memory
```

`working-memory` 的結果（v0.1.0）：

```
hooks: session.start, command.run{command=brain}, prompt.submit, tool.call,
       session.measure, session.compact, ui.render{component=Pane, requestId=working-memory}
calls: $.clock.every, $.command.register, $.session.usage, $.state.get, $.state.set,
       $.ui.open, $.ui.resolve
```

它只讀工具呼叫的名稱與參數摘要（檔名、指令前 36 字）來畫圖，不讀寫檔案、不啟動程式、不連網、不呼叫模型，也不改動任何 tool call 或 prompt。

## 開發

```bash
claude --plugin-dir ./plugins/working-memory   # 單次載入
claude plugin test ./plugins/working-memory     # 跑測試
```

`tsconfig.json` 依賴 `.claude-plugin/types/`，那是 Claude Code 產生的型別檔，不放進 repo。

## English

A small collection of Claude Code mods by Learning Hacker. Shared as-is, without support.

```
/plugin marketplace add Hangghost/learning-hacker-claude-mod
/plugin install working-memory@learning-hacker-claude-mod
```

Requires Claude Code v2.1.287+. Run `/brain` to open the pane. `working-memory` draws your context window as a brain: tool calls light up regions, the brain fills up as context grows, and compaction plays a "sleep" sweep. It reads only tool names and short argument summaries, and makes no file writes, process spawns, network requests, or model calls.

## License

MIT
