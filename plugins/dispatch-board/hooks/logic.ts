// dispatch-board 純函式：mission 檔解析、路徑安全檢查、名冊對照、快照比對、band 與面板版面。
// 不碰 $，供 register.tsx 與測試共用。

import type { BadFile, BoardMission, BoardNode, BoardSnapshot, NodeEval, SessionView } from '../types'

export type { BadFile, BoardMission, BoardNode, BoardSnapshot, NodeEval, SessionView }

export const PLUGIN = 'dispatch-board'
export const DEFAULT_DIR = '~/.claude/missions'
export const TICK_MS = 5000
export const PANE_POLL_MS = 5000
export const BAND_POLL_MS = 30000
export const DONE_TIMEOUT_MS = 5000
export const ROSTER_TIMEOUT_MS = 10000
export const TOAST_MS = 8000
/** 同時求值的完成條件數上限 */
export const EVAL_CONCURRENCY = 4
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_NODES = 50

// ── 目錄與安全邊界 ─────────────────────────────────────────────────────────
// 完成條件是 shell 指令、mod 會執行它，所以 mission 檔只從使用者層級的目錄讀：
// 家目錄底下、不在任何 git 工作樹內、也不在本 session 的專案目錄內。

/** 設定值 → 絕對路徑；只收 `~`、`~/…` 或絕對路徑。 */
export function expandDir(raw: string, home: string): { ok: true; path: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'missions_dir 是空的' }
  if (text.includes('\0')) return { ok: false, error: 'missions_dir 含不合法字元' }
  if (text === '~') return { ok: true, path: home }
  if (text.startsWith('~/')) return { ok: true, path: `${home}/${text.slice(2)}` }
  if (text.startsWith('/')) return { ok: true, path: text }
  return { ok: false, error: `missions_dir 須為 ~/… 或絕對路徑（收到 ${truncate(text, 60)}）` }
}

export function isUnder(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, '')
  return child.startsWith(`${p}/`)
}

export function isSameOrUnder(child: string, parent: string): boolean {
  return child === parent.replace(/\/+$/, '') || isUnder(child, parent)
}

/** realDir 往上到（不含）realHome 的每一層：檢查 `.git` 用。 */
export function gitProbePaths(realDir: string, realHome: string): string[] {
  const out: string[] = []
  let p = realDir.replace(/\/+$/, '')
  while (isUnder(p, realHome)) {
    out.push(`${p}/.git`)
    p = p.slice(0, p.lastIndexOf('/'))
  }
  return out
}

export type DirFacts = {
  realHome: string
  realDir: string
  /** 本 session 的專案根與工作目錄（已解析） */
  projectDirs: readonly string[]
  /** gitProbePaths 裡存在的那些 */
  gitHits: readonly string[]
}

/** 安全邊界判定；回 null＝可讀，否則回拒絕原因。 */
export function dirRefusal(f: DirFacts): string | null {
  if (!isUnder(f.realDir, f.realHome)) return `mission 目錄 ${f.realDir} 不在家目錄底下，拒讀`
  for (const p of f.projectDirs) {
    if (isSameOrUnder(f.realDir, p)) return `mission 目錄 ${f.realDir} 在本 session 的專案目錄內，拒讀`
  }
  if (f.gitHits.length) return `mission 目錄 ${f.realDir} 在 git 工作樹內（${f.gitHits[0]}），拒讀`
  return null
}

/**
 * 自訂的 missions_dir 必須來自使用者層級設定（~/.claude/settings.json）。
 * 專案的 .claude/settings.json 也能寫 pluginConfigs；不檢查來源的話，clone 一個陌生 repo
 * 就能把目錄指到別處。預設值不需要來源。
 */
export function configRefusal(configured: string, userSettings: Readonly<Record<string, unknown>>): string | null {
  if (configured.trim() === DEFAULT_DIR) return null
  const configs = userSettings.pluginConfigs
  if (configs && typeof configs === 'object') {
    for (const [key, entry] of Object.entries(configs as Record<string, unknown>)) {
      if (key !== PLUGIN && !key.startsWith(`${PLUGIN}@`)) continue
      const options = (entry as { options?: Record<string, unknown> } | null)?.options
      if (options && options.missions_dir === configured) return null
    }
  }
  return 'missions_dir 只接受使用者層級設定（~/.claude/settings.json）；其他來源的值不採用'
}

/** 家目錄縮寫成 ~，顯示用。 */
export function tildify(path: string, home: string): string {
  if (path === home) return '~'
  return isUnder(path, home) ? `~${path.slice(home.replace(/\/+$/, '').length)}` : path
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** mission 檔候選：目錄第一層的 `*.json`（子目錄不讀，`done/` 可放收斂完的檔） */
export function isMissionFileName(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.') && name.length > '.json'.length
}

// ── mission 檔 ──────────────────────────────────────────────────────────────

export type MissionNode = { id: string; title: string; session: string; done: string; depends_on: string[] }
export type MissionSpec = { mission_id: string; title: string; nodes: MissionNode[] }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

function optString(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error(`${field} 必須是字串`)
  if (v.length > max) throw new Error(`${field} 超過 ${max} 字`)
  return v.trim()
}

/** mission 檔文字 → 規格或原因。mission_id 省略時取檔名（去掉 .json）。 */
export function parseMission(text: string, fileName: string): { ok: true; value: MissionSpec } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '不是合法 JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '最外層必須是 JSON 物件' }
  const r = raw as Record<string, unknown>
  try {
    const mission_id = optString(r.mission_id, 'mission_id', 80) || fileName.replace(/\.json$/, '')
    if (!ID_RE.test(mission_id)) throw new Error(`mission_id「${truncate(mission_id, 40)}」只能用英數、_ . -`)
    const title = optString(r.title, 'title', 200)
    if (!Array.isArray(r.nodes) || r.nodes.length === 0) throw new Error('nodes 必須是非空陣列')
    if (r.nodes.length > MAX_NODES) throw new Error(`nodes 超過 ${MAX_NODES} 個`)
    const nodes: MissionNode[] = []
    const ids = new Set<string>()
    r.nodes.forEach((n: unknown, i: number) => {
      if (n === null || typeof n !== 'object' || Array.isArray(n)) throw new Error(`nodes[${i}] 必須是物件`)
      const o = n as Record<string, unknown>
      const id = optString(o.id, `nodes[${i}].id`, 80)
      if (!ID_RE.test(id)) throw new Error(`nodes[${i}].id 缺少或含不合法字元（只能用英數、_ . -）`)
      if (ids.has(id)) throw new Error(`節點 id「${id}」重複`)
      ids.add(id)
      const done = optString(o.done, `${id}.done`, 2000)
      if (!done) throw new Error(`${id}.done 缺少（完成條件指令）`)
      const deps = o.depends_on ?? []
      if (!Array.isArray(deps) || deps.some(d => typeof d !== 'string')) throw new Error(`${id}.depends_on 必須是字串陣列`)
      nodes.push({
        id,
        title: optString(o.title, `${id}.title`, 200),
        session: optString(o.session, `${id}.session`, 200),
        done,
        depends_on: (deps as string[]).map(d => d.trim()),
      })
    })
    for (const n of nodes) {
      for (const d of n.depends_on) {
        if (d === n.id) throw new Error(`${n.id} 依賴自己`)
        if (!ids.has(d)) throw new Error(`${n.id} 依賴不存在的節點「${truncate(d, 40)}」`)
      }
    }
    return { ok: true, value: { mission_id, title, nodes } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── 完成條件求值 ────────────────────────────────────────────────────────────

/** `sh -c` 的退出碼 → 求值結果。126／127 是 shell 自己的「不能執行／找不到指令」，算無法判定。 */
export function classifyExit(exitCode: number, stderr: string): NodeEval {
  if (exitCode === 0) return { kind: 'done' }
  if (exitCode === 126 || exitCode === 127) {
    const line = stderr.trim().split('\n').pop() ?? ''
    return { kind: 'unknown', reason: `指令跑不起來（exit ${exitCode}${line ? `：${truncate(line, 80)}` : ''}）` }
  }
  return { kind: 'open', exitCode }
}

/**
 * `$.process.run` reject 的原因。逾時的錯誤訊息不保證寫明是逾時，所以用經過時間判定：
 * 跑到逾時上限附近才 reject 就算逾時，否則是指令跑不起來。
 */
export function rejectionReason(err: unknown, elapsedMs: number): string {
  if (elapsedMs >= DONE_TIMEOUT_MS - 500) return `逾時 ${DONE_TIMEOUT_MS / 1000}s`
  const text = (err instanceof Error ? err.message : String(err)).replace(/^(HooksError:\s*)?dispatch-board:\s*/, '')
  return `跑不起來：${truncate(text, 60)}`
}

/** 以固定併發數依序處理，保留輸入順序。 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

// ── session 名冊 ────────────────────────────────────────────────────────────

export type RosterEntry = { name: string; state: string; status: string; startedAt: number | null }
export type Roster = { available: true; entries: RosterEntry[] } | { available: false; note: string }

/** `claude agents --json` 的結果 → 名冊。任何非預期都算不可用，不當成「名冊是空的」。 */
export function parseRoster(exitCode: number, stdout: string, stderr: string): Roster {
  if (exitCode !== 0) {
    const line = stderr.trim().split('\n').pop() ?? ''
    return { available: false, note: `claude agents --json exit ${exitCode}${line ? `：${truncate(line, 80)}` : ''}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { available: false, note: 'claude agents --json 輸出不是 JSON' }
  }
  if (!Array.isArray(raw)) return { available: false, note: 'claude agents --json 輸出不是陣列' }
  const entries: RosterEntry[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    entries.push({
      name: typeof o.name === 'string' ? o.name : '',
      state: typeof o.state === 'string' ? o.state : '',
      status: typeof o.status === 'string' ? o.status : '',
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : null,
    })
  }
  return { available: true, entries }
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function liveState(e: RosterEntry): 'working' | 'idle' | 'blocked' {
  if (e.state === 'blocked') return 'blocked'
  if (e.status === 'busy' || e.state === 'working') return 'working'
  return 'idle'
}

const LIVE_RANK = { blocked: 0, working: 1, idle: 2 } as const

/** 節點的 session 名稱 → 名冊上的樣子。同名多筆時取最需要注意的（blocked＞working＞idle）。 */
export function sessionView(name: string, roster: Roster, seen: Readonly<Record<string, number>>): SessionView {
  if (!name) return { kind: 'none' }
  if (!roster.available) return { kind: 'unavailable' }
  const key = normalizeName(name)
  let best: SessionView | null = null
  for (const e of roster.entries) {
    if (normalizeName(e.name) !== key) continue
    const v = { kind: 'live' as const, state: liveState(e), startedAt: e.startedAt }
    if (best === null || (best.kind === 'live' && LIVE_RANK[v.state] < LIVE_RANK[best.state])) best = v
  }
  if (best) return best
  return seen[key] !== undefined ? { kind: 'gone' } : { kind: 'absent' }
}

/** 記下這次在名冊上看到的 session（只記 mission 用到的名稱）。名冊不可用時原樣保留。 */
export function nextSeen(
  prev: Readonly<Record<string, number>>,
  roster: Roster,
  names: readonly string[],
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  const wanted = new Set(names.filter(Boolean).map(normalizeName))
  for (const [k, v] of Object.entries(prev)) if (wanted.has(k)) out[k] = v
  if (!roster.available) return out
  for (const e of roster.entries) {
    const k = normalizeName(e.name)
    if (wanted.has(k)) out[k] = now
  }
  return out
}

export function missionNode(spec: MissionNode, ev: NodeEval, live: SessionView): BoardNode {
  return { ...spec, eval: ev, live }
}

// ── 狀態判定 ────────────────────────────────────────────────────────────────

export function isDone(n: BoardNode): boolean {
  return n.eval.kind === 'done'
}

export function isUnknown(n: BoardNode): boolean {
  return n.eval.kind === 'unknown'
}

/** 節點在等你：還沒完成，且負責的 session blocked。 */
export function waitingOnUser(n: BoardNode): boolean {
  return !isDone(n) && n.live.kind === 'live' && n.live.state === 'blocked'
}

/** session 已結束但完成條件沒達成：多半是 session 半途掛了或忘了收尾。 */
export function endedUndone(n: BoardNode): boolean {
  return !isDone(n) && n.live.kind === 'gone'
}

export function nodeNeedsYou(n: BoardNode): boolean {
  return waitingOnUser(n) || isUnknown(n) || endedUndone(n)
}

export function depsPending(m: BoardMission, n: BoardNode): string[] {
  const byId = new Map(m.nodes.map(x => [x.id, x]))
  return n.depends_on.filter(d => {
    const dep = byId.get(d)
    return !dep || !isDone(dep)
  })
}

export function progressOf(m: BoardMission): { done: number; total: number } {
  return { done: m.nodes.filter(isDone).length, total: m.nodes.length }
}

export function missionDone(m: BoardMission): boolean {
  return m.nodes.length > 0 && m.nodes.every(isDone)
}

export function nodeKey(missionId: string, nodeId: string): string {
  return `${missionId}/${nodeId}`
}

/**
 * 「需要你」的件數：blocked 的 session（跨 mission 去重，你只需要去回一個 session）
 * ＋無法判定的節點＋session 已結束但沒完成的節點＋讀不了的 mission 檔。
 */
export function needYou(s: BoardSnapshot): number {
  const blocked = new Set<string>()
  let n = s.bad.length
  for (const m of s.missions) {
    for (const node of m.nodes) {
      if (waitingOnUser(node)) blocked.add(normalizeName(node.session))
      else if (isUnknown(node) || endedUndone(node)) n += 1
    }
  }
  return n + blocked.size
}

export type Group = 'need' | 'running' | 'converge'
export const GROUP_LABEL: Record<Group, string> = { need: '需要你', running: '跑著', converge: '做完待收斂' }
const GROUP_ORDER: readonly Group[] = ['need', 'running', 'converge']

export function groupOf(m: BoardMission): Group {
  if (m.nodes.some(nodeNeedsYou)) return 'need'
  return missionDone(m) ? 'converge' : 'running'
}

/** 最急：需要你的 mission 優先，其次跑著的，再依 mission_id。 */
export function mostUrgent(missions: readonly BoardMission[]): BoardMission | null {
  const rank = (m: BoardMission) => GROUP_ORDER.indexOf(groupOf(m))
  return [...missions].sort((a, b) => rank(a) - rank(b) || a.mission_id.localeCompare(b.mission_id))[0] ?? null
}

// ── 時間與文字 ──────────────────────────────────────────────────────────────

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/** shell 單引號字串（給「複製收斂指令」用；mod 自己不執行它）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ── band ───────────────────────────────────────────────────────────────────

/** band 一行；回 null＝不佔行（沒有 mission、沒有讀不了的檔、也沒有失敗）。 */
export function bandText(s: BoardSnapshot | null, failure: string | null, lastOkAt: number | null, now: number): string | null {
  if (failure !== null) return `⧉ dispatch-board：${failure}`
  if (s === null || (s.missions.length === 0 && s.bad.length === 0)) return null
  const ago = lastOkAt === null ? '' : ` · ${duration(now - lastOkAt)} 前`
  const need = needYou(s)
  if (s.missions.length === 0) return `⧉ ${s.bad.length} 份 mission 檔讀不了 · /dispatch 看原因${ago}`
  if (s.missions.length === 1) {
    const m = s.missions[0] as BoardMission
    const p = progressOf(m)
    return `⧉ ${m.mission_id} ${p.done}/${p.total} · ${need} 需要你${ago}`
  }
  let done = 0
  let total = 0
  for (const m of s.missions) {
    const p = progressOf(m)
    done += p.done
    total += p.total
  }
  const urgent = mostUrgent(s.missions)
  return `⧉ ${s.missions.length} missions ${done}/${total} · ${need} 需要你 · 最急 ${urgent?.mission_id ?? '—'}${ago}`
}

// ── toast ──────────────────────────────────────────────────────────────────

/** 與上一份快照比對：只在狀態轉換時跳。prev 為 null（第一份）只作基準。 */
export function diffToasts(prev: BoardSnapshot | null, next: BoardSnapshot): string[] {
  if (prev === null) return []
  const out: string[] = []
  const prevMissions = new Map(prev.missions.map(m => [m.mission_id, m]))
  for (const m of next.missions) {
    const pm = prevMissions.get(m.mission_id)
    if (!pm) continue
    const prevNodes = new Map(pm.nodes.map(n => [n.id, n]))
    for (const n of m.nodes) {
      const pn = prevNodes.get(n.id)
      if (!pn) continue
      const key = nodeKey(m.mission_id, n.id)
      if (!isDone(pn) && isDone(n)) out.push(`${key} 完成`)
      if (!isUnknown(pn) && n.eval.kind === 'unknown') out.push(`${key} 完成條件無法判定：${truncate(n.eval.reason, 80)}`)
      if (!waitingOnUser(pn) && waitingOnUser(n)) out.push(`${key} 在等你（${n.session}）`)
      if (!endedUndone(pn) && endedUndone(n)) out.push(`${key} 的 session 已結束，但完成條件沒達成`)
    }
    if (!missionDone(pm) && missionDone(m)) out.push(`${m.mission_id} 全部完成，待收斂`)
  }
  const prevBad = new Set(prev.bad.map(b => b.file))
  for (const b of next.bad) if (!prevBad.has(b.file)) out.push(`${baseName(b.file)} 讀不了：${truncate(b.reason, 80)}`)
  return out
}

/** blocked 起始時間只能由快照比對得知。 */
export function nextBlockedSince(prev: Readonly<Record<string, number>>, s: BoardSnapshot, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of s.missions) {
    for (const n of m.nodes) {
      if (!waitingOnUser(n)) continue
      const key = nodeKey(m.mission_id, n.id)
      out[key] = prev[key] ?? now
    }
  }
  return out
}

// ── 面板 ───────────────────────────────────────────────────────────────────

const BAR_MAX_CELLS = 10

export function progressBar(m: BoardMission): string {
  const { done, total } = progressOf(m)
  if (total === 0) return '0/0'
  const cells = Math.min(total, BAR_MAX_CELLS)
  const filled = Math.round((done / total) * cells)
  return `${'▓'.repeat(filled)}${'░'.repeat(cells - filled)} ${done}/${total}`
}

/** 節點符號：✓ 完成、✗ 無法判定、⏸ 等你、▶ session 活著、○ 其餘。 */
export function nodeSymbol(n: BoardNode): string {
  if (isDone(n)) return '✓'
  if (isUnknown(n)) return '✗'
  if (waitingOnUser(n)) return '⏸'
  return n.live.kind === 'live' ? '▶' : '○'
}

/** session 欄：狀態詞在前、名稱在後，窄面板截斷時先吃掉名稱。 */
export function sessionText(n: BoardNode): string {
  const v = n.live
  if (v.kind === 'none') return ''
  const status =
    v.kind === 'live'
      ? { working: '工作中', idle: '閒置', blocked: 'blocked' }[v.state]
      : v.kind === 'gone'
        ? '已結束'
        : v.kind === 'absent'
          ? '不在名冊'
          : '名冊不可用'
  return `${status} ${n.session}`
}

export function waitText(missionId: string, n: BoardNode, blockedSince: Readonly<Record<string, number>>, now: number): string {
  if (isDone(n)) return ''
  const since = blockedSince[nodeKey(missionId, n.id)]
  if (waitingOnUser(n) && since !== undefined) return `等你 ${duration(now - since)}`
  if (n.live.kind === 'live' && n.live.state === 'working' && n.live.startedAt !== null) return `跑了 ${duration(now - n.live.startedAt)}`
  return ''
}

export function nodeLine(m: BoardMission, n: BoardNode, blockedSince: Readonly<Record<string, number>>, now: number): string {
  const pending = isDone(n) ? [] : depsPending(m, n)
  const parts = [
    `${nodeSymbol(n)} ${n.id}${n.title ? ` ${n.title}` : ''}`,
    waitText(m.mission_id, n, blockedSince, now),
    pending.length ? `等依賴 ${pending.join(',')}` : '',
    endedUndone(n) ? '已結束但沒完成' : '',
    sessionText(n),
  ]
  return parts.filter(Boolean).join(' · ')
}

export type PaneTone = 'plain' | 'bold' | 'dim' | 'warn'

/** 面板的一列；`copy` 表示附一顆把該文字放上剪貼簿的按鈕。每列只佔一行（截斷，不換行）。 */
export type PaneRow = { text: string; tone: PaneTone; copy?: { key: string; text: string } }

export function archiveCommand(file: string): string {
  const dir = file.slice(0, file.lastIndexOf('/'))
  return `mkdir -p ${shellQuote(`${dir}/done`)} && mv ${shellQuote(file)} ${shellQuote(`${dir}/done/`)}`
}

/** 快照 → 面板各列（不含讀取中、失敗與頁尾，那些屬於 register 的輪詢狀態）。 */
export function paneModel(s: BoardSnapshot, blockedSince: Readonly<Record<string, number>>, now: number): PaneRow[] {
  const rows: PaneRow[] = []
  rows.push({ text: `mission 目錄 ${s.dir}`, tone: 'dim' })
  if (!s.roster.available) rows.push({ text: `session 名冊不可用：${s.roster.note}`, tone: 'warn' })
  if (s.missions.length === 0 && s.bad.length === 0) {
    rows.push({ text: '沒有 mission。在 mission 目錄放一個 .json 檔就會出現（格式見 README）', tone: 'dim' })
  }
  for (const g of GROUP_ORDER) {
    const ms = s.missions.filter(m => groupOf(m) === g)
    if (!ms.length) continue
    rows.push({ text: `${GROUP_LABEL[g]}（${ms.length}）`, tone: 'bold' })
    for (const m of ms) {
      rows.push({ text: `${m.mission_id}  ${progressBar(m)}${m.title ? `  ${m.title}` : ''}`, tone: 'plain' })
      for (const n of m.nodes) {
        const tone: PaneTone = isDone(n) ? 'dim' : nodeNeedsYou(n) ? 'warn' : 'plain'
        rows.push({ text: `  ${nodeLine(m, n, blockedSince, now)}`, tone })
        if (n.eval.kind === 'unknown') rows.push({ text: `      條件 ${truncate(n.done, 70)} → ${truncate(n.eval.reason, 60)}`, tone: 'warn' })
      }
      if (g === 'converge') {
        const cmd = archiveCommand(m.file)
        rows.push({ text: `  收斂後把 mission 檔移到 done/，看板就不再求值`, tone: 'dim', copy: { key: `copy-archive:${m.mission_id}`, text: cmd } })
      }
    }
  }
  if (s.bad.length) {
    rows.push({ text: `讀不了的 mission 檔（${s.bad.length}）`, tone: 'bold' })
    for (const b of s.bad) rows.push({ text: `  ${baseName(b.file)} · ${truncate(b.reason, 100)}`, tone: 'warn' })
  }
  return rows
}

export function pollDue(now: number, lastAttemptAt: number | null, paneOpen: boolean): boolean {
  if (lastAttemptAt === null) return true
  const period = paneOpen ? PANE_POLL_MS : BAND_POLL_MS
  // 計時器每 TICK_MS 觸發，留半個 tick 的寬限，避免 30 秒週期因抖動拖成 35 秒
  return now - lastAttemptAt >= period - TICK_MS / 2
}
