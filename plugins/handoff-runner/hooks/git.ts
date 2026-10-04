// handoff-runner 的交接單存取與唯讀 git 檢查：簽發、列出、推導（render）、認領、紀錄、撤單。
//
// 這個檔案**沒有執行入口**：
// - 交接單只存 branch／target／sha 三個參數，不存路徑或指令；argv 在 render 當下由參數推導。
// - 這裡的 git 只有唯讀查詢，全部經 `roGit`，它在呼叫前以白名單擋下任何會寫入的子命令。
// - 會改 ref 的步驟只在 register.tsx 的按鈕 handler 裡執行（見 tests/boundary.mjs）。
//
// 交接單住 `<git common dir>/handoffs/`：`<id>.json` 交接單、`<id>.lock/` 認領鎖、
// `<id>.lock.json` 鎖的時間、`<id>.result.json` 最近一次結果。在 `.git` 裡，不會被 commit，
// 同一個 repo 的所有 worktree 都看得到。

import type { Candidate, Check, Params, Rendered, Result, RunLog, Status, Ticket, TicketRow } from '../types'
import {
  ID_RE,
  LOCK_STALE_MS,
  SCHEMA,
  branchNameShapeOk,
  buildSteps,
  fingerprint,
  isClosed,
  parseLsRemote,
  parseNamesZ,
  parseResult,
  parseStatusZ,
  parseTicket,
  parseWorktrees,
  short,
  summarize,
  ticketId,
  titleOf,
} from './logic'
import type { Worktree } from './logic'

export type ProcResult = { exitCode: number | null; stdout: string; stderr: string }

/** mod 提供給這個檔案的能力。`git` 只會被 `roGit` 呼叫。 */
export type Host = {
  /** 跑 `git <args>`（cwd 為 `cwd`）；不 throw */
  git(args: string[], cwd: string): Promise<ProcResult>
  /** 讀檔；不存在回 null */
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
  /** 目錄下的檔名；目錄不存在回 [] */
  list(dir: string): Promise<string[]>
  /** 建立目錄，已存在就失敗（原子操作，當鎖用） */
  mkdirExclusive(path: string): Promise<boolean>
  rmdir(path: string): Promise<void>
  now(): number
}

export type Config = { push: boolean; remote: string }

// ── 唯讀 git ────────────────────────────────────────────────────────────────

/** `roGit` 唯一接受的子命令。新增前先確認它不會改變 ref、物件、工作樹或遠端。 */
export const READONLY_GIT: ReadonlySet<string> = new Set([
  'rev-parse',
  'merge-base',
  'ls-remote',
  'status',
  'worktree',
  'check-ref-format',
  'diff',
])

export async function roGit(host: Host, args: string[], cwd: string): Promise<ProcResult> {
  const sub = args[0] ?? ''
  if (!READONLY_GIT.has(sub)) return { exitCode: -2, stdout: '', stderr: `refused: ${sub} 不是唯讀 git 子命令` }
  if (sub === 'worktree' && args[1] !== 'list') return { exitCode: -2, stdout: '', stderr: 'refused: 只允許 worktree list' }
  if (args.some(a => a.startsWith('--output'))) return { exitCode: -2, stdout: '', stderr: 'refused: 會寫檔的選項' }
  return host.git(args, cwd)
}

/** session 所在 repo 的 git common dir（絕對路徑）；不在 git repo 內回 null。 */
export async function commonDir(host: Host, cwd: string): Promise<string | null> {
  const r = await roGit(host, ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const dir = r.exitCode === 0 ? r.stdout.trim().replace(/\/+$/, '') : ''
  return dir.startsWith('/') ? dir : null
}

export async function rev(host: Host, common: string, ref: string): Promise<string | null> {
  const r = await roGit(host, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], common)
  const out = r.stdout.trim()
  return r.exitCode === 0 && out ? out : null
}

async function branchTip(host: Host, common: string, branch: string): Promise<string | null> {
  return rev(host, common, `refs/heads/${branch}`)
}

/** true／false；讀不到（含物件不在本機）回 null。 */
export async function isAncestor(host: Host, common: string, older: string, newer: string): Promise<boolean | null> {
  const r = await roGit(host, ['merge-base', '--is-ancestor', older, newer], common)
  return r.exitCode === 0 ? true : r.exitCode === 1 ? false : null
}

/** `tip` 已含 `sha`（等於或為其後代）＝已落地。讀不到一律 false。 */
export async function contains(host: Host, common: string, tip: string | null, sha: string): Promise<boolean> {
  return tip !== null && (tip === sha || (await isAncestor(host, common, sha, tip)) === true)
}

export async function worktrees(host: Host, common: string): Promise<Worktree[] | null> {
  const r = await roGit(host, ['worktree', 'list', '--porcelain'], common)
  return r.exitCode === 0 ? parseWorktrees(r.stdout) : null
}

export async function holderOf(host: Host, common: string, branch: string): Promise<string | null> {
  return (await worktrees(host, common))?.find(w => !w.bare && w.branch === branch)?.path ?? null
}

async function refOk(host: Host, common: string, name: unknown): Promise<boolean> {
  if (!branchNameShapeOk(name)) return false
  return (await roGit(host, ['check-ref-format', '--branch', name], common)).exitCode === 0
}

async function remoteTip(host: Host, common: string, remote: string, target: string): Promise<{ sha: string | null } | null> {
  const ref = `refs/heads/${target}`
  const r = await roGit(host, ['ls-remote', remote, ref], common)
  if (r.exitCode !== 0) return null
  return { sha: parseLsRemote(r.stdout)[ref] ?? null }
}

// ── 檔案 ────────────────────────────────────────────────────────────────────

export function handoffsDir(common: string): string {
  return `${common}/handoffs`
}

function pathOf(common: string, id: string, suffix: string): string {
  if (!ID_RE.test(id)) throw new Error(`交接單 id 不合法：${id}`)
  return `${handoffsDir(common)}/${id}${suffix}`
}

export async function loadTicket(host: Host, common: string, id: string): Promise<{ ticket: Ticket } | { error: string }> {
  if (!ID_RE.test(id)) return { error: `交接單 id 不合法：${id}` }
  const text = await host.read(pathOf(common, id, '.json'))
  if (text === null) return { error: `找不到交接單 ${id}` }
  const p = parseTicket(id, text)
  return p.ok ? { ticket: p.value } : { error: `交接單 ${id} ${p.error}` }
}

export async function loadResult(host: Host, common: string, id: string): Promise<Result | null> {
  return parseResult(await host.read(pathOf(common, id, '.result.json')))
}

async function writeResult(host: Host, common: string, result: Result): Promise<void> {
  await host.write(pathOf(common, result.id, '.result.json'), JSON.stringify(result, null, 2) + '\n')
}

function historyOf(previous: Result | null): string[] {
  return previous ? [...(previous.history ?? []), previous.summary] : []
}

// ── 簽發 ────────────────────────────────────────────────────────────────────

export type Issued = { ok: true; ticket: Ticket; reused: boolean; superseded: string[] } | { ok: false; error: string }

/** 檢查參數並寫一張交接單。sha 在此當下釘住。 */
export async function issue(
  host: Host,
  cwd: string,
  input: { branch: unknown; target: unknown; via: string },
): Promise<Issued> {
  const common = await commonDir(host, cwd)
  if (common === null) return { ok: false, error: '目前的目錄不在 git repo 內' }
  const { branch, target } = input
  if (!(await refOk(host, common, branch))) return { ok: false, error: `branch 不是合法的分支名：${JSON.stringify(branch)}` }
  if (!(await refOk(host, common, target))) return { ok: false, error: `target 不是合法的分支名：${JSON.stringify(target)}` }
  if (branch === target) return { ok: false, error: 'branch 與 target 不能相同' }
  const sha = await branchTip(host, common, branch as string)
  if (sha === null) return { ok: false, error: `找不到本機分支 ${branch}` }
  const tgt = await branchTip(host, common, target as string)
  if (tgt === null) return { ok: false, error: `找不到本機分支 ${target}` }
  if (await contains(host, common, tgt, sha)) return { ok: false, error: `${target} 已含 ${branch}（${short(sha)}），不需要落地` }
  if ((await isAncestor(host, common, tgt, sha)) !== true) {
    return { ok: false, error: `${target} 無法快轉到 ${branch}：先把 ${branch} rebase 到 ${target} 上再簽發` }
  }

  const params: Params = { branch: branch as string, target: target as string, sha }
  const superseded: string[] = []
  for (const row of await listTickets(host, common)) {
    if (!row.params || row.params.branch !== params.branch || row.params.target !== params.target) continue
    if (row.params.sha === sha) {
      const loaded = await loadTicket(host, common, row.id)
      if ('ticket' in loaded) return { ok: true, ticket: loaded.ticket, reused: true, superseded }
    } else if ((await dismiss(host, common, row.id, '已被同分支的新交接單取代')).ok) {
      superseded.push(row.id)
    }
  }

  const now = new Date(host.now())
  let id = ticketId(params.branch, now)
  for (let n = 2; (await host.read(pathOf(common, id, '.json'))) !== null; n++) id = `${ticketId(params.branch, now)}-${n}`
  const ticket: Ticket = { schema: SCHEMA, id, kind: 'ref-land', created_at: now.toISOString(), issuer: { via: input.via }, params }
  await host.write(pathOf(common, id, '.json'), JSON.stringify(ticket, null, 2) + '\n')
  return { ok: true, ticket, reused: false, superseded }
}

// ── 列出 ────────────────────────────────────────────────────────────────────

export async function listTickets(host: Host, common: string, includeClosed = false): Promise<TicketRow[]> {
  const names = (await host.list(handoffsDir(common))).filter(n => n.endsWith('.json') && !n.endsWith('.result.json') && !n.endsWith('.lock.json'))
  const rows: TicketRow[] = []
  for (const name of names.sort()) {
    const id = name.slice(0, -'.json'.length)
    if (!ID_RE.test(id)) continue
    const result = await loadResult(host, common, id)
    if (isClosed(result) && !includeClosed) continue
    const loaded = await loadTicket(host, common, id)
    if ('error' in loaded) {
      rows.push({ id, title: id, error: loaded.error, outcome: result?.outcome ?? null, summary: result?.summary ?? null })
      continue
    }
    const t = loaded.ticket
    rows.push({ id, title: titleOf(t.params), created_at: t.created_at, params: t.params, outcome: result?.outcome ?? null, summary: result?.summary ?? null })
  }
  return rows
}

/** 面板手動簽發的候選：被 worktree 持有、可快轉進 target、還沒落地也還沒有同 sha 待辦單的分支。 */
export async function candidates(host: Host, common: string, target: string): Promise<Candidate[]> {
  if (!branchNameShapeOk(target)) return []
  const tgt = await branchTip(host, common, target)
  const trees = await worktrees(host, common)
  if (tgt === null || trees === null) return []
  const open = new Set((await listTickets(host, common)).filter(r => r.params?.target === target).map(r => `${r.params!.branch}@${r.params!.sha}`))
  const out: Candidate[] = []
  for (const w of trees) {
    if (w.bare || !w.branch || w.branch === target || !branchNameShapeOk(w.branch)) continue
    const sha = await branchTip(host, common, w.branch)
    if (sha === null || open.has(`${w.branch}@${sha}`)) continue
    if (await contains(host, common, tgt, sha)) continue
    if ((await isAncestor(host, common, tgt, sha)) !== true) continue
    out.push({ branch: w.branch, sha, target, worktree: w.path })
  }
  return out
}

// ── render：事前檢查＋步驟推導（只讀） ─────────────────────────────────────

async function prechecks(host: Host, common: string, p: Params, cfg: Config): Promise<{ checks: Check[]; status: Status; holder: string | null; targetTip: string; landed: boolean; pushDone: boolean; pushDetail: string }> {
  const { branch, target, sha } = p
  const checks: Check[] = []
  let status: Status = 'ready'
  const block = () => {
    if (status === 'ready') status = 'blocked'
  }
  const tgt = (await branchTip(host, common, target)) ?? ''
  const holder = await holderOf(host, common, target)
  const landed = await contains(host, common, tgt || null, sha)

  if (landed) {
    checks.push({ name: 'P1', ok: true, detail: `${target}（${short(tgt)}）已含 ${short(sha)}，快轉已完成` })
  } else {
    const src = await branchTip(host, common, branch)
    const p1 = src === sha
    checks.push({ name: 'P1', ok: p1, detail: `${branch} = ${short(src)}，交接單釘住 ${short(sha)}` })
    const p2 = tgt !== '' && (await isAncestor(host, common, tgt, sha)) === true
    checks.push({ name: 'P2', ok: p2, detail: `${target}（${short(tgt || null)}）${p2 ? '可快轉到' : '無法快轉到'} ${short(sha)}` })
    if (!(p1 && p2)) status = 'stale'

    if (holder === null) {
      checks.push({ name: 'P3', ok: true, detail: `${target} 沒有被任何 worktree checkout，直接更新 ref` })
    } else {
      const st = await roGit(host, ['status', '--porcelain', '-z', '--untracked-files=all'], holder)
      const df = tgt ? await roGit(host, ['diff', '--name-only', '-z', '--no-renames', tgt, sha], common) : null
      if (st.exitCode !== 0 || !df || df.exitCode !== 0) {
        checks.push({ name: 'P3', ok: false, detail: `${holder} 無法判定未 commit 變更是否與這次落地重疊` })
        block()
      } else {
        const dirty = parseStatusZ(st.stdout)
        const landing = parseNamesZ(df.stdout)
        const overlap = [...dirty].filter(x => landing.has(x)).sort()
        if (overlap.length) {
          const list = overlap.slice(0, 5).join('、') + (overlap.length > 5 ? '…' : '')
          checks.push({ name: 'P3', ok: false, detail: `${holder} 有與這次落地重疊的未 commit 變更：${list}` })
          block()
        } else {
          const note = dirty.size ? `（另有 ${dirty.size} 個未 commit 變更，與這次落地無重疊）` : '，工作樹乾淨'
          checks.push({ name: 'P3', ok: true, detail: `${holder} 持有 ${target}${note}` })
        }
      }
    }
  }

  let pushDone = false
  let pushDetail = ''
  if (cfg.push) {
    const remote = await remoteTip(host, common, cfg.remote, target)
    if (remote === null) {
      checks.push({ name: 'P4', ok: false, detail: `讀不到 ${cfg.remote}（ls-remote 失敗）；關掉 push 設定可只做本機落地` })
      block()
    } else if (remote.sha === null) {
      checks.push({ name: 'P4', ok: true, detail: `${cfg.remote} 還沒有 ${target}，push 會建立它` })
    } else if (await contains(host, common, remote.sha, sha)) {
      pushDone = true
      checks.push({ name: 'P4', ok: true, detail: `${cfg.remote}/${target}（${short(remote.sha)}）已含 ${short(sha)}` })
    } else if ((await isAncestor(host, common, remote.sha, sha)) === true) {
      checks.push({ name: 'P4', ok: true, detail: `${cfg.remote}/${target}（${short(remote.sha)}）可快轉到 ${short(sha)}` })
    } else {
      pushDetail = `${cfg.remote}/${target} 有本機沒有的 commit`
      checks.push({ name: 'P4', ok: false, detail: `${cfg.remote}/${target}（${short(remote.sha)}）無法快轉到 ${short(sha)}：先 fetch 並更新本機` })
      block()
    }
  }
  return { checks, status, holder, targetTip: tgt, landed, pushDone, pushDetail }
}

export async function render(host: Host, common: string, id: string, cfg: Config): Promise<Rendered> {
  const result = ID_RE.test(id) ? await loadResult(host, common, id) : null
  const loaded = await loadTicket(host, common, id)
  const empty = { prechecks: [], steps: [], fingerprint: '', last_result: result }
  if ('error' in loaded) return { id, status: 'invalid', title: id, reason: loaded.error, ...empty }
  const p = loaded.ticket.params
  const title = titleOf(p)
  if (isClosed(result)) return { id, status: 'done', title, reason: result!.summary, ...empty }
  if (!(await refOk(host, common, p.branch)) || !(await refOk(host, common, p.target))) {
    return { id, status: 'invalid', title, reason: '分支名不合法', ...empty }
  }
  if ((await branchTip(host, common, p.target)) === null) {
    return { id, status: 'invalid', title, reason: `找不到本機分支 ${p.target}`, ...empty }
  }
  const pre = await prechecks(host, common, p, cfg)
  const steps = buildSteps({
    common,
    params: p,
    holder: pre.holder,
    targetTip: pre.targetTip,
    landed: pre.landed,
    push: cfg.push ? { remote: cfg.remote, done: pre.pushDone, detail: pre.pushDetail } : null,
  })
  const reason = pre.checks.filter(c => !c.ok).map(c => c.detail).join('；')
  return { id, status: pre.status, title, prechecks: pre.checks, steps, fingerprint: fingerprint(steps), reason, last_result: result }
}

// ── verify：事後驗證（只讀） ────────────────────────────────────────────────

export async function verify(host: Host, common: string, p: Params, cfg: Config): Promise<Check[]> {
  const { target, sha } = p
  const checks: Check[] = []
  const tgt = await branchTip(host, common, target)
  checks.push({ name: 'V1', ok: await contains(host, common, tgt, sha), detail: `本機 ${target}（${short(tgt)}）已含 ${short(sha)}` })
  const holder = await holderOf(host, common, target)
  if (holder !== null) {
    const head = await rev(host, holder, 'HEAD')
    checks.push({ name: 'V2', ok: head !== null && head === tgt, detail: `${holder} 的 HEAD（${short(head)}）跟上 ${target}` })
  }
  if (cfg.push) {
    const remote = await remoteTip(host, common, cfg.remote, target)
    const ok = remote !== null && (await contains(host, common, remote.sha, sha))
    checks.push({ name: 'V3', ok, detail: remote === null ? `讀不到 ${cfg.remote}（ls-remote 失敗）` : `${cfg.remote}/${target} 已含 ${short(sha)}` })
  }
  return checks
}

// ── claim／record／dismiss：只寫 handoffs/ 底下的檔 ─────────────────────────

export type Claim = { ok: boolean; forced: boolean; detail: string }

/** 以「建立目錄」當鎖：已存在且未逾時就拿不到；逾時則強制接手並標記。 */
export async function claim(host: Host, common: string, id: string): Promise<Claim> {
  const loaded = await loadTicket(host, common, id)
  if ('error' in loaded) return { ok: false, forced: false, detail: loaded.error }
  const dir = pathOf(common, id, '.lock')
  const stamp = pathOf(common, id, '.lock.json')
  let forced = false
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await host.mkdirExclusive(dir)) {
      await host.write(stamp, JSON.stringify({ at: host.now() }) + '\n')
      return { ok: true, forced, detail: '' }
    }
    let at = 0
    try {
      at = Number(JSON.parse((await host.read(stamp)) ?? '{}').at) || 0
    } catch {}
    if (host.now() - at <= LOCK_STALE_MS) return { ok: false, forced: false, detail: '另一個 session 正在執行這張單' }
    await host.rmdir(dir)
    forced = true
  }
  return { ok: false, forced: false, detail: '無法建立認領鎖' }
}

export async function release(host: Host, common: string, id: string): Promise<void> {
  await host.rmdir(pathOf(common, id, '.lock'))
}

/**
 * 合併執行紀錄與事後驗證，寫 `<id>.result.json`，回傳結果。
 * 已通過或已撤單的單是終態：不重寫結果檔，回傳前一次結果並把摘要換成「無需再執行」。
 * 不釋放認領鎖，由呼叫端在 finally 釋放。
 */
export async function record(host: Host, common: string, id: string, log: RunLog, cfg: Config): Promise<Result> {
  const loaded = await loadTicket(host, common, id)
  const previous = await loadResult(host, common, id)
  if (previous !== null && isClosed(previous)) {
    const what = previous.outcome === 'passed' ? '✓ 已落地' : '已撤單'
    return { ...previous, summary: `${what}，無需再執行（上次：${previous.summary}）` }
  }
  const checks = 'ticket' in loaded && !log.aborted ? await verify(host, common, loaded.ticket.params, cfg) : []
  const s = summarize(log, checks)
  const result: Result = {
    schema: SCHEMA,
    id,
    outcome: s.outcome,
    summary: s.summary,
    finished_at: new Date(host.now()).toISOString(),
    forced_stale_lock: Boolean(log.forced_stale_lock),
    steps: s.steps,
    checks,
    history: historyOf(previous),
  }
  await writeResult(host, common, result)
  return result
}

/** 撤單：先拿認領鎖，避免撤掉正在執行的單。 */
export async function dismiss(host: Host, common: string, id: string, summary = '已撤單（未執行）'): Promise<{ ok: boolean; detail: string }> {
  const c = await claim(host, common, id)
  if (!c.ok) return { ok: false, detail: c.detail }
  try {
    const previous = await loadResult(host, common, id)
    await writeResult(host, common, {
      schema: SCHEMA,
      id,
      outcome: 'dismissed',
      summary,
      finished_at: new Date(host.now()).toISOString(),
      forced_stale_lock: c.forced,
      steps: [],
      checks: [],
      history: historyOf(previous),
    })
    return { ok: true, detail: '' }
  } finally {
    await release(host, common, id)
  }
}
