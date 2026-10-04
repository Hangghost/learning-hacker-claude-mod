// handoff-runner：bg session 在 worktree 做完的分支，由使用者在面板按一顆按鈕快轉進目標分支。
//
// - 簽發：model 呼叫工具 `handoff_issue`，或使用者打 `/handoff issue <branch> [target]`、在面板按「簽發」。
//   簽發只寫一張只帶參數（branch／target／sha）的交接單，不執行任何 git 寫入。
// - 執行：**唯一的執行入口是 `runTicket`，只從「執行」按鈕的 onPress 呼叫**。
//   本 mod 不送 prompt、不派 subagent、不呼叫 model；工具與指令都只能簽發或開面板。
// - 按下時：認領鎖 → 重新推導 → 與畫面逐字比對 → 逐步執行（已完成者略過、失敗即停）
//   → 事後驗證並寫結果檔 → 釋放鎖 → toast 一行摘要。

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Rendered, RunLog, TicketRow } from '../types'
import * as git from './git'
import type { Config, Host } from './git'
import { GIT_TIMEOUT_MS, REMOTE_RE, STEP_TIMEOUT_MS, TICK_MS, TOAST_MS, argvText, bandText, branchNameShapeOk, checkLine, pending, preflight, runSteps, short, stepLine, truncate } from './logic'

const PANE = 'handoff-runner'
const TOOL = 'handoff_issue'
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' }

const tickets = atom({ plugin: 'handoff-runner', key: 'tickets' } as const, null)
const failure = atom({ plugin: 'handoff-runner', key: 'failure' } as const, null)
const rendered = atom({ plugin: 'handoff-runner', key: 'rendered' } as const, {})
const running = atom({ plugin: 'handoff-runner', key: 'running' } as const, {})
const candidates = atom({ plugin: 'handoff-runner', key: 'candidates' } as const, [])
const isPaneOpen = atom({ plugin: 'handoff-runner', key: 'isPaneOpen' } as const, false)

// 模組層狀態：熱重載時歸零。
let common: string | null | undefined
let inFlight = false
let cfg: Config = { push: false, remote: 'origin' }
let defaultTarget = 'main'

function host($: any): Host {
  return {
    git: async (args, cwd) => {
      try {
        const r = await $.process.run(['git', ...args], { cwd, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS })
        return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
      } catch (err) {
        return { exitCode: null, stdout: '', stderr: truncate(String(err), 200) }
      }
    },
    read: async path => {
      try {
        return String(await $.fs.read(path))
      } catch {
        return null
      }
    },
    write: (path, text) => $.fs.write(path, text),
    list: async dir => {
      try {
        return (await $.fs.list(dir)).filter((e: any) => e.kind === 'file').map((e: any) => String(e.name))
      } catch {
        return []
      }
    },
    mkdirExclusive: async path => {
      try {
        return (await $.process.run(['mkdir', path], { timeoutMs: GIT_TIMEOUT_MS })).exitCode === 0
      } catch {
        return false
      }
    },
    rmdir: async path => {
      try {
        await $.process.run(['rmdir', path], { timeoutMs: GIT_TIMEOUT_MS })
      } catch {}
    },
    now: () => Date.now(),
  }
}

function toast($: any, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  } catch {}
}

async function repo($: any): Promise<string | null> {
  if (common === undefined) common = await git.commonDir(host($), await $.session.cwd())
  return common
}

async function poll($: any): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const dir = await repo($)
    if (dir === null) {
      await update($, tickets, () => [])
      return
    }
    let rows: TicketRow[]
    try {
      rows = await git.listTickets(host($), dir)
    } catch (err) {
      await update($, failure, () => truncate(String(err), 120))
      return
    }
    await update($, failure, () => null)
    await update($, tickets, () => rows)
    if (await read($, isPaneOpen)) {
      const next: Record<string, Rendered> = {}
      for (const row of pending(rows)) next[row.id] = await git.render(host($), dir, row.id, cfg)
      await update($, rendered, () => next)
      const found = await git.candidates(host($), dir, defaultTarget)
      await update($, candidates, () => found)
    }
  } finally {
    inFlight = false
  }
}

function refresh($: any): void {
  void poll($).catch(() => {})
}

/** 簽發：只寫交接單，不執行。工具、指令、面板按鈕共用。 */
async function issueText($: any, branch: unknown, target: unknown, via: string): Promise<{ ok: boolean; text: string }> {
  const r = await git.issue(host($), await $.session.cwd(), { branch, target: target ?? defaultTarget, via })
  if (!r.ok) return { ok: false, text: `交接單未簽發：${r.error}` }
  refresh($)
  const p = r.ticket.params
  const head = r.reused ? `已有相同的交接單 ${r.ticket.id}` : `已簽發交接單 ${r.ticket.id}`
  const extra = r.superseded.length ? `；取代了舊單 ${r.superseded.join('、')}` : ''
  return {
    ok: true,
    text: `${head}：${p.branch}（${short(p.sha)}）→ ${p.target}${extra}。落地要由使用者在 /handoff 面板按「執行」；這個工具不會執行任何 git 寫入。`,
  }
}

/** 唯一的執行路徑。只從「執行」按鈕的 onPress 呼叫。 */
async function runTicket($: any, id: string): Promise<void> {
  if ((await read($, running))[id]) return
  await update($, running, m => ({ ...m, [id]: true }))
  const h = host($)
  const dir = await repo($)
  try {
    if (dir === null) return
    const claimed = await git.claim(h, dir, id)
    if (!claimed.ok) {
      toast($, `handoff：${claimed.detail}`)
      return
    }
    try {
      const log: RunLog = { aborted: null, forced_stale_lock: claimed.forced, steps: [] }
      const fresh = await git.render(h, dir, id, cfg)
      log.aborted = preflight((await read($, rendered))[id], fresh)
      if (log.aborted === null) {
        log.steps = await runSteps(fresh.steps, async argv => {
          const r = await $.process.run(argv, { env: GIT_ENV, timeoutMs: STEP_TIMEOUT_MS })
          return { exitCode: r.exitCode, stderr: String(r.stderr ?? '') }
        })
      }
      const result = await git.record(h, dir, id, log, cfg)
      toast($, `handoff：${result.summary}`)
    } finally {
      await git.release(h, dir, id)
    }
  } catch (err) {
    toast($, `handoff：執行中斷（${truncate(String(err), 80)}）`)
  } finally {
    await update($, running, m => ({ ...m, [id]: false }))
    refresh($)
  }
}

async function dismissTicket($: any, id: string): Promise<void> {
  const dir = await repo($)
  if (dir === null) return
  const r = await git.dismiss(host($), dir, id)
  toast($, r.ok ? `handoff：已撤單 ${id}` : `handoff：撤單失敗（${r.detail}）`)
  refresh($)
}

async function issueFromPane($: any, branch: string, target: string): Promise<void> {
  const r = await issueText($, branch, target, 'pane')
  toast($, r.text.split('。')[0] ?? r.text)
}

const USAGE = '用法：/handoff 開關面板；/handoff issue <branch> [target] 簽發交接單'

export const register: Register = (on, options) => {
  cfg = {
    push: options.push === true,
    remote: typeof options.remote === 'string' && REMOTE_RE.test(options.remote) ? options.remote : 'origin',
  }
  defaultTarget = typeof options.defaultTarget === 'string' && branchNameShapeOk(options.defaultTarget) ? options.defaultTarget : 'main'

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    await $.command.register({ name: 'handoff', description: '交接單面板：檢查、執行、撤單', argumentHint: '[issue <branch> [target]]' })
    await $.tool.register({
      name: TOOL,
      description:
        '為一個已完成的分支簽發交接單，請使用者把它快轉（fast-forward）進目標分支。' +
        '用在 worktree 裡的工作做完、但目標分支被別的 checkout 持有、你自己無法落地的時候。' +
        '這個工具只記錄 branch、target 與當下的 commit，不執行任何 git 寫入；' +
        '實際落地由使用者在 /handoff 面板檢查後按「執行」。branch 必須能快轉進 target（必要時先 rebase）。',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: '要落地的本機分支名稱' },
          target: { type: 'string', description: `目標分支，預設 ${defaultTarget}` },
        },
        required: ['branch'],
        additionalProperties: false,
      },
    })
    $.clock.every(TICK_MS, () => refresh($))
    refresh($)
    return out
  })

  on('tool.call', { tool: 'mcp__handoff-runner__handoff_issue' }, async ($, e: any) => {
    const r = await issueText($, e.branch, e.target, 'tool')
    return r.ok ? { result: r.text } : { deny: r.text }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const args = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'issue') {
      if (!args[1] || args.length > 3) return { text: USAGE }
      return { text: (await issueText($, args[1], args[2], 'command')).text }
    }
    if (args.length > 0) return { text: USAGE }
    if (await read($, isPaneOpen)) {
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, isPaneOpen, () => false)
      return { text: 'handoff 面板已關閉。' }
    }
    await update($, isPaneOpen, () => true)
    await $.ui.open({ id: PANE, title: 'handoff' })
    await poll($)
    return { text: 'handoff 面板已開啟。' }
  })

  on('ui.close', async ($, e: any, next) => {
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.props as any)?.hasSurvey) return next(e)
    const fail = await read($, failure)
    const text = bandText(await read($, tickets), fail)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text color={fail !== null ? 'yellow' : 'cyan'} wrap="truncate-end">
          {text}
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = pending(await read($, tickets))
    const byId = await read($, rendered)
    const busy = await read($, running)
    const fail = await read($, failure)
    const cands = await read($, candidates)

    const out: any[] = []
    if (fail !== null) out.push(<Text color="yellow" wrap="truncate-end">無法讀取交接單：{fail}</Text>)
    if (rows.length === 0 && fail === null) out.push(<Text dimColor>沒有待辦的交接單。</Text>)

    for (const row of rows) {
      const r = byId[row.id]
      out.push(
        <Text key={`title:${row.id}`} bold wrap="truncate-end">
          {row.title}
        </Text>,
      )
      if (!r) {
        out.push(<Text dimColor>檢查中…</Text>)
        continue
      }
      for (const c of r.prechecks) {
        out.push(
          <Text color={c.ok ? undefined : 'yellow'} dimColor={c.ok || undefined} wrap="truncate-end">
            {checkLine(c)}
          </Text>,
        )
      }
      for (const s of r.steps) {
        out.push(
          <Box flexDirection="column">
            <Text dimColor={s.done_already || undefined} wrap="truncate-end">
              {stepLine(s)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {argvText(s)}
            </Text>
          </Box>,
        )
      }
      if (r.last_result?.summary) out.push(<Text dimColor wrap="truncate-end">上次：{r.last_result.summary}</Text>)
      const buttons: any[] = []
      if (busy[row.id]) {
        out.push(<Text color="cyan">執行中…</Text>)
      } else if (r.status === 'ready') {
        buttons.push(<Button key={`run:${row.id}`} variant="primary" label="執行" onPress={() => void runTicket($, row.id)} />)
      } else {
        out.push(
          <Text color="yellow" wrap="truncate-end">
            無法執行（{r.status}）：{r.reason || '事前檢查未通過'}
          </Text>,
        )
      }
      if (!busy[row.id]) {
        buttons.push(<Button key={`dismiss:${row.id}`} label="撤單" dimColor onPress={() => void dismissTicket($, row.id).catch(() => {})} />)
      }
      out.push(<Box key={`buttons:${row.id}`}>{buttons}</Box>)
    }

    if (cands.length > 0) {
      out.push(<Text key="cands" dimColor>可簽發（worktree 裡可快轉進 {defaultTarget} 的分支）：</Text>)
      for (const c of cands) {
        out.push(
          <Button
            key={`issue:${c.branch}`}
            label={`簽發 ${c.branch}（${short(c.sha)}）→ ${c.target}`}
            dimColor
            onPress={() => void issueFromPane($, c.branch, c.target).catch(() => {})}
          />,
        )
      }
    }

    return (
      <Box flexDirection="column">
        {out}
        <Box>
          <Button key="refresh" label="重新檢查" onPress={() => refresh($)} />
          <Button key="close" label="關閉" role="dismiss" onPress={() => $.ui.close({ id: PANE }).catch(() => {})} />
        </Box>
      </Box>
    )
  })
}
