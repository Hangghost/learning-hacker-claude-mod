// handoff-runner 的純函式：參數格式、git 輸出解析、步驟推導、執行紀錄的組裝規則。不碰 $、不跑程式。

import type { Aborted, Check, Outcome, Params, Rendered, Result, RunLog, Step, StepLog, StepRow, Ticket, TicketRow } from '../types'

export const SCHEMA = 1
export const TICK_MS = 60_000
export const GIT_TIMEOUT_MS = 30_000
export const STEP_TIMEOUT_MS = 600_000
export const TOAST_MS = 8_000
/** 認領鎖的存活上限：步驟單次上限 10 分鐘，再留餘裕 */
export const LOCK_STALE_MS = 15 * 60_000

export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/
/** remote 名稱只接受保守的字元集，避免被當成選項或 URL */
export const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '無法解析'
}

/** 分支名稱的第一道關：`git check-ref-format --branch` 之前先擋掉會被當成選項或 refspec 的寫法。 */
export function branchNameShapeOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('-') &&
    !name.startsWith('refs/') &&
    !/[\s:+^~?*[\\\x00-\x1f\x7f]/.test(name)
  )
}

export function slug(branch: string): string {
  const tail = branch.split('/').pop() ?? branch
  return (
    tail
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|-+$/g, '')
      .slice(0, 60) || 'x'
  )
}

/** `<slug>-<UTC yyyymmdd-hhmmss>`；同秒重複時呼叫端加序號。 */
export function ticketId(branch: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  return `${slug(branch)}-${stamp}`
}

export function titleOf(p: Pick<Params, 'branch' | 'target'>): string {
  return `${p.branch} → ${p.target}`
}

/** 交接單 JSON → Ticket。只認得 schema 1 的 ref-land；多出的欄位一律丟掉，不會被讀到。 */
export function parseTicket(id: string, text: string): Parsed<Ticket> {
  let v: any
  try {
    v = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  if (v === null || typeof v !== 'object') return { ok: false, error: '不是 JSON 物件' }
  if (v.schema !== SCHEMA) return { ok: false, error: `未知 schema：${String(v.schema)}` }
  if (v.kind !== 'ref-land') return { ok: false, error: `未知 kind：${String(v.kind)}` }
  if (v.id !== id) return { ok: false, error: 'id 與檔名不符' }
  const p = v.params
  if (p === null || typeof p !== 'object') return { ok: false, error: '缺 params' }
  const params: Params = { branch: p.branch, target: p.target, sha: p.sha }
  if (!branchNameShapeOk(params.branch)) return { ok: false, error: `branch 不合法：${JSON.stringify(p.branch)}` }
  if (!branchNameShapeOk(params.target)) return { ok: false, error: `target 不合法：${JSON.stringify(p.target)}` }
  if (typeof params.sha !== 'string' || !SHA_RE.test(params.sha)) return { ok: false, error: 'sha 必須是完整的 commit 雜湊' }
  if (params.branch === params.target) return { ok: false, error: 'branch 與 target 相同' }
  return {
    ok: true,
    value: {
      schema: SCHEMA,
      id,
      kind: 'ref-land',
      created_at: typeof v.created_at === 'string' ? v.created_at : '',
      issuer: { via: typeof v.issuer?.via === 'string' ? v.issuer.via : '' },
      params,
    },
  }
}

export function parseResult(text: string | null): Result | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && typeof v.outcome === 'string' ? (v as Result) : null
  } catch {
    return null
  }
}

export function isClosed(r: Result | null): boolean {
  return r !== null && (r.outcome === 'passed' || r.outcome === 'dismissed')
}

// ── git 輸出解析 ────────────────────────────────────────────────────────────

export type Worktree = { path: string; branch: string | null; bare: boolean }

export function parseWorktrees(out: string): Worktree[] {
  const items: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of [...out.split('\n'), '']) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), branch: null, bare: false }
    } else if (cur && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (cur && line.trim() === 'bare') {
      cur.bare = true
    } else if (cur && line.trim() === '') {
      items.push(cur)
      cur = null
    }
  }
  return items
}

/** `status --porcelain -z`：已追蹤的修改與未追蹤檔；rename／copy 的兩端都列入。 */
export function parseStatusZ(out: string): Set<string> {
  const paths = new Set<string>()
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    paths.add(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') paths.add(entries[++i] ?? '')
  }
  paths.delete('')
  return paths
}

export function parseNamesZ(out: string): Set<string> {
  return new Set(out.split('\0').filter(Boolean))
}

/** `ls-remote` → `{ ref: sha }`。 */
export function parseLsRemote(out: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t')
    if (sha && ref && SHA_RE.test(sha)) found[ref] = sha
  }
  return found
}

// ── 步驟推導 ────────────────────────────────────────────────────────────────

export type StepInput = {
  /** git common dir（`.git`），沒有持有者時在這裡更新 ref */
  common: string
  params: Params
  /** 目前 checkout 目標分支的 worktree；null 表示沒有 */
  holder: string | null
  /** 推導當下目標分支的 commit，作為 update-ref 的預期舊值 */
  targetTip: string
  /** 本機目標分支已含 sha */
  landed: boolean
  push: { remote: string; done: boolean; detail: string } | null
}

export function buildSteps(i: StepInput): Step[] {
  const { branch, target, sha } = i.params
  const land: string[] = i.holder
    ? ['git', '-C', i.holder, 'merge', '--ff-only', sha]
    : ['git', '-C', i.common, 'update-ref', '-m', `handoff: ${branch} → ${target}`, `refs/heads/${target}`, sha, i.targetTip]
  const steps: Step[] = [
    {
      name: 'S1',
      label: i.holder ? `${target} 快轉到 ${short(sha)}（在 ${i.holder}）` : `${target} 快轉到 ${short(sha)}（只更新 ref）`,
      argv: land,
      done_already: i.landed,
      detail: '',
    },
  ]
  if (i.push) {
    steps.push({
      name: 'S2',
      label: `push ${short(sha)} 到 ${i.push.remote}/${target}`,
      argv: ['git', '-C', i.common, 'push', i.push.remote, `${sha}:refs/heads/${target}`],
      done_already: i.push.done,
      detail: i.push.detail,
    })
  }
  return steps
}

export function fingerprint(steps: Step[]): string {
  return JSON.stringify(steps.map(s => [s.name, s.argv]))
}

/** 執行步驟允許的形狀：`git -C <絕對路徑> {merge --ff-only|update-ref|push}`，不得帶強制選項。 */
export function argvAllowed(argv: readonly string[]): boolean {
  if (argv[0] !== 'git' || argv[1] !== '-C' || !argv[2]?.startsWith('/')) return false
  const rest = argv.slice(3)
  if (rest.some(a => a === '-f' || a.startsWith('--force') || a.startsWith('+') || a === '--delete' || a === '-d')) return false
  if (rest[0] === 'merge') return rest[1] === '--ff-only' && rest.length === 3
  if (rest[0] === 'update-ref') return rest.length === 6 && rest[1] === '-m' && rest[3]!.startsWith('refs/heads/')
  if (rest[0] === 'push') return rest.length === 3 && /^[0-9a-f]+:refs\/heads\//.test(rest[2]!)
  return false
}

/**
 * 執行前的守門：按下時重新推導的結果能不能照畫面執行。
 * 回 null 表示可以；否則回 `RunLog.aborted` 的值。
 */
export function preflight(shown: Rendered | undefined, fresh: Rendered): Aborted {
  if (fresh.status === 'blocked') return 'blocked'
  if (fresh.status !== 'ready') return 'stale'
  if (!shown || shown.fingerprint !== fresh.fingerprint) return 'mismatch'
  if (fresh.steps.some(s => !argvAllowed(s.argv))) return 'mismatch'
  return null
}

export function shouldStop(log: StepLog): boolean {
  return log.ran && log.exit_code !== 0
}

export type Exec = (argv: string[]) => Promise<{ exitCode: number | null; stderr: string }>

/** 依序跑步驟：已完成者略過、失敗即停。exec 由呼叫端提供（唯一的執行點在 mod 的按鈕 handler）。 */
export async function runSteps(steps: Step[], exec: Exec): Promise<StepLog[]> {
  const logs: StepLog[] = []
  for (const step of steps) {
    if (step.done_already) {
      logs.push({ name: step.name, ran: false })
      continue
    }
    let log: StepLog
    try {
      const r = await exec(step.argv)
      log = { name: step.name, ran: true, exit_code: r.exitCode, stderr: r.stderr }
    } catch (err) {
      log = { name: step.name, ran: true, exit_code: null, stderr: String(err) }
    }
    logs.push(log)
    if (shouldStop(log)) break
  }
  return logs
}

export function tail(text: string): string {
  const lines = text.split('\n').filter(l => l.trim())
  return (lines[lines.length - 1] ?? '').slice(0, 200)
}

/** 執行紀錄＋事後驗證 → 結果。 */
export function summarize(log: RunLog, checks: Check[]): { outcome: Outcome; summary: string; steps: StepRow[] } {
  const steps: StepRow[] = log.steps.map(s => ({
    name: String(s.name),
    ran: Boolean(s.ran),
    exit_code: s.exit_code ?? null,
    stderr_tail: tail(String(s.stderr ?? '')),
  }))
  const failed = steps.find(s => s.ran && s.exit_code !== 0)
  const skipped = steps.filter(s => !s.ran).map(s => s.name)
  if (log.aborted === 'stale' || log.aborted === 'mismatch') {
    const why = log.aborted === 'mismatch' ? '（畫面與重新檢查的內容不同）' : ''
    return { outcome: 'stale', summary: `✗ 事前檢查不再成立，未執行任何步驟${why}`, steps }
  }
  if (log.aborted === 'blocked') return { outcome: 'blocked', summary: '✗ 事前檢查擋下，未執行任何步驟', steps }
  if (failed) {
    return { outcome: 'failed', summary: `✗ ${failed.name} 失敗（exit ${failed.exit_code}）：${failed.stderr_tail || '無 stderr'}`, steps }
  }
  const bad = checks.find(c => !c.ok)
  if (bad) return { outcome: 'failed', summary: `✗ 驗證 ${bad.name} 未通過：${bad.detail}`, steps }
  const total = steps.length + checks.length
  return { outcome: 'passed', summary: `✓ ${total}/${total} 通過${skipped.length ? `（${skipped.join('、')} 已略過）` : ''}`, steps }
}

// ── 顯示 ────────────────────────────────────────────────────────────────────

/** 待辦＝尚未通過也未撤單的單子。 */
export function pending(rows: TicketRow[] | null): TicketRow[] {
  return (rows ?? []).filter(r => r.outcome !== 'passed' && r.outcome !== 'dismissed')
}

/** band 文字；null 表示不佔行。 */
export function bandText(rows: TicketRow[] | null, failure: string | null): string | null {
  if (failure !== null) return `⇄ handoff-runner 無法讀取交接單（${failure}）`
  const list = pending(rows)
  if (list.length === 0) return null
  const head = list[0]!.title
  return list.length === 1 ? `⇄ 1 張交接單等你：${head} · /handoff` : `⇄ ${list.length} 張交接單等你：${head} 等 · /handoff`
}

export function stepLine(step: Step): string {
  return `${step.done_already ? '略過' : '執行'} ${step.name} ${step.label}`
}

export function argvText(step: Step): string {
  return step.argv.join(' ')
}

export function checkLine(c: Check): string {
  return `${c.ok ? '✓' : '✗'} ${c.name} ${c.detail}`
}
