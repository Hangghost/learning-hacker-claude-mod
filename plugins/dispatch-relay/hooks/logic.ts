// dispatch-relay 純函式：mission 檔解析、目錄安全邊界、名冊解析、身份判定、訊息組裝、降級與注入文字。
// 不碰 $，供 register.ts 與測試共用。
// 結果檔判定一律比對內容，不看任何工具呼叫的種類或時機（結果檔可能經 Write、Edit、`cat >>` 或 `mv` 寫入）。
// 目錄安全邊界與名冊解析和 dispatch-board 同一套規則，刻意複製而不跨 plugin import：兩個 mod 必須能各自安裝。

import type { Identity, Part, Resolution } from '../types'

export type { Identity, Part, Resolution }

export const PLUGIN = 'dispatch-relay'
export const DEFAULT_DIR = '~/.claude/missions'
export const DEFAULT_RESULT_FILE = '.mission-result.md'
export const ROSTER_TIMEOUT_MS = 10000
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_NODES = 50
export const SECTION_ID = 'dispatch-relay:relay'

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

// ── 目錄與安全邊界（與 dispatch-board 相同）──────────────────────────────────
// relay 會把 mission 檔指定的結果檔內容送給另一個 session，所以 mission 檔只從使用者層級的目錄讀：
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
 * 就能把目錄指到別處、讓 relay 讀對方寫的 mission 檔。預設值不需要來源。
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

/** mission 檔候選：目錄第一層的 `*.json`（子目錄不讀，`done/` 可放收斂完的檔） */
export function isMissionFileName(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.') && name.length > '.json'.length
}

// ── mission 檔（relay 只讀它用得到的欄位）─────────────────────────────────────

export type RelayNode = { id: string; session: string; resultFile: string }
export type RelayMission = { missionId: string; station: string; nodes: RelayNode[] }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

function optString(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error(`${field} 必須是字串`)
  if (v.length > max) throw new Error(`${field} 超過 ${max} 字`)
  return v.trim()
}

/**
 * 結果檔的相對路徑：拒絕絕對路徑、`~`、反斜線與任何 `.`／`..` 段——relay 會把它的內容送出去，
 * 路徑只能落在 session 根目錄底下。實際讀檔前另以解析後的路徑再確認一次（防符號連結）。
 */
export function checkResultFile(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: true, path: DEFAULT_RESULT_FILE }
  if (text.includes('\0') || text.includes('\\')) return { ok: false, error: 'result_file 含不合法字元' }
  if (text.startsWith('/') || text.startsWith('~')) return { ok: false, error: 'result_file 必須是相對於 session 根目錄的路徑' }
  const segs = text.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return { ok: false, error: 'result_file 不能含空段、. 或 ..' }
  return { ok: true, path: text }
}

/** mission 檔文字 → relay 用得到的欄位或原因。mission_id 省略時取檔名（去掉 .json）。 */
export function parseMission(text: string, fileName: string): { ok: true; value: RelayMission } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '不是合法 JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '最外層必須是 JSON 物件' }
  const r = raw as Record<string, unknown>
  try {
    const missionId = optString(r.mission_id, 'mission_id', 80) || fileName.replace(/\.json$/, '')
    if (!ID_RE.test(missionId)) throw new Error(`mission_id「${truncate(missionId, 40)}」只能用英數、_ . -`)
    const station = optString(r.station, 'station', 200)
    if (!Array.isArray(r.nodes) || r.nodes.length === 0) throw new Error('nodes 必須是非空陣列')
    if (r.nodes.length > MAX_NODES) throw new Error(`nodes 超過 ${MAX_NODES} 個`)
    const nodes: RelayNode[] = []
    const ids = new Set<string>()
    r.nodes.forEach((n: unknown, i: number) => {
      if (n === null || typeof n !== 'object' || Array.isArray(n)) throw new Error(`nodes[${i}] 必須是物件`)
      const o = n as Record<string, unknown>
      const id = optString(o.id, `nodes[${i}].id`, 80)
      if (!ID_RE.test(id)) throw new Error(`nodes[${i}].id 缺少或含不合法字元（只能用英數、_ . -）`)
      if (ids.has(id)) throw new Error(`節點 id「${id}」重複`)
      ids.add(id)
      const file = checkResultFile(optString(o.result_file, `${id}.result_file`, 200))
      if (!file.ok) throw new Error(`${id}.${file.error}`)
      nodes.push({ id, session: optString(o.session, `${id}.session`, 200), resultFile: file.path })
    })
    return { ok: true, value: { missionId, station, nodes } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── session 名冊 ────────────────────────────────────────────────────────────

export type RosterEntry = { name: string; sessionId: string }
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
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
    })
  }
  return { available: true, entries }
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** 名冊上本 session 的名稱；查無或沒名稱回 ''。 */
export function ownName(roster: RosterEntry[], sessionId: string): string {
  for (const e of roster) if (e.sessionId === sessionId && e.name.trim()) return e.name.trim()
  return ''
}

/** 指揮站名稱 → session id。查無、同名多筆都不猜。 */
export function resolveStation(
  roster: Roster,
  station: string,
): { ok: true; sessionId: string } | { ok: false; reason: string } {
  if (!roster.available) return { ok: false, reason: `名冊不可用（${roster.note}）` }
  const key = normalizeName(station)
  const ids = [...new Set(roster.entries.filter(e => normalizeName(e.name) === key && e.sessionId).map(e => e.sessionId))]
  if (ids.length === 0) return { ok: false, reason: `名冊上沒有名為 ${station} 的 session` }
  if (ids.length > 1) return { ok: false, reason: `名冊上有 ${ids.length} 個名為 ${station} 的 session，不猜` }
  return { ok: true, sessionId: ids[0] as string }
}

// ── 身份判定 ────────────────────────────────────────────────────────────────

/**
 * 本 session 的名稱 → 它在 mission 目錄裡負責的節點。名稱比對不分大小寫。
 * 恰好一個節點才算數：零個是「不是 worker」、多個是「不知道是哪一個」，都不啟用——錯認身份會把
 * 別人的結果檔送出去。對到的 mission 沒有 `station`＝沒有選用 relay，同樣不啟用。
 */
export function findIdentity(missions: readonly RelayMission[], name: string): Resolution {
  if (!name) return { kind: 'none' }
  const key = normalizeName(name)
  const hits: { m: RelayMission; n: RelayNode }[] = []
  for (const m of missions) for (const n of m.nodes) if (n.session && normalizeName(n.session) === key) hits.push({ m, n })
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map(h => `${h.m.missionId}/${h.n.id}`) }
  const { m, n } = hits[0] as { m: RelayMission; n: RelayNode }
  if (!m.station) return { kind: 'no-station', missionId: m.missionId, nodeId: n.id }
  if (normalizeName(m.station) === key) return { kind: 'self-station', missionId: m.missionId, nodeId: n.id }
  return { kind: 'match', identity: { missionId: m.missionId, nodeId: n.id, station: m.station, resultFile: n.resultFile } }
}

/** 未啟用時的日誌一行。 */
export function inactiveLog(r: Exclude<Resolution, { kind: 'match' }>): string {
  switch (r.kind) {
    case 'unavailable':
      return `未啟用：${r.reason}`
    case 'none':
      return '未啟用：mission 目錄裡沒有指派給本 session 的節點'
    case 'ambiguous':
      return `未啟用：多重匹配，候選 ${r.candidates.join('、')}，不任選其一`
    case 'no-station':
      return `未啟用：mission ${r.missionId} 沒有 station 欄位（沒有選用 dispatch-relay），節點 ${r.nodeId} 照原本方式回報`
    case 'self-station':
      return `未啟用：mission ${r.missionId} 的 station 就是本 session，不轉送給自己`
  }
}

// ── 訊息組裝 ────────────────────────────────────────────────────────────────

export type Built = {
  /** 空陣列＝沒有東西要送。 */
  parts: Part[]
  /** 含固定首行的完整訊息；parts 為空時為 ''。 */
  text: string
  /** 本文總字數（各部分原文長度加總，不含首行與段落標題）。 */
  chars: number
  /** 送出（或交給 worker 自送）後要記為「已處理」的結果檔內容；沒有結果檔部分時為 null。 */
  nextSent: string | null
}

/**
 * 組出本 turn 要轉送的訊息。
 *
 * - 結果檔：`content` 非 null、非空白、且與 `prev` 不同才轉送；以 `prev` 為前綴且 `prev` 非空時只送追加段，
 *   否則送全文。`prev` 缺失（狀態被清空）視為從未處理 → 全文：偏向重複而非漏送。
 * - 最終回覆：非空、且 worker 本 turn 沒自送時附帶為 `final-reply`，**不設長度或行數門檻**——
 *   worker 結束 turn 只有回報與提問兩種原因，兩者都要送達；以「超過一行」為門檻會吞掉單行提問。
 * - 自送時不附最終回覆，但結果檔變更仍轉送（結果檔是回報正本，自送的可能只是提問）。
 */
export function buildMessage(
  ids: { missionId: string; nodeId: string },
  prev: string | undefined,
  content: string | null,
  answer: string,
  selfSent: boolean,
): Built {
  const before = prev ?? ''
  const sections: { part: Part; body: string }[] = []
  let nextSent: string | null = null
  if (content !== null && content !== before && content.trim() !== '') {
    if (before !== '' && content.startsWith(before)) {
      sections.push({ part: 'result-append', body: content.slice(before.length) })
    } else {
      sections.push({ part: 'result-full', body: content })
    }
    nextSent = content
  }
  if (!selfSent && answer.trim() !== '') sections.push({ part: 'final-reply', body: answer.trim() })
  if (sections.length === 0) return { parts: [], text: '', chars: 0, nextSent: null }
  const chars = sections.reduce((n, s) => n + s.body.length, 0)
  const head = `[dispatch-relay] mission=${ids.missionId} node=${ids.nodeId} parts=${sections.map(s => s.part).join(',')} chars=${chars}`
  const text = [head, ...sections.map(s => `--- ${s.part} ---\n${s.body}`)].join('\n\n')
  return { parts: sections.map(s => s.part), text, chars, nextSent }
}

// ── 畫面一行、降級 prompt、注入段 ───────────────────────────────────────────

const PART_LABEL: Record<Part, string> = {
  'result-full': '結果檔全文',
  'result-append': '結果檔追加段',
  'final-reply': '最終回覆',
}

export function partsLabel(parts: readonly Part[]): string {
  return parts.map(p => PART_LABEL[p]).join('＋')
}

export function deliveredLine(built: Built, station: string): string {
  return `↪ dispatch-relay：${partsLabel(built.parts)}（${built.chars} 字）已送達指揮站 ${station}`
}

export function degradedLine(reason: string): string {
  return `⚠ dispatch-relay：轉送失敗（${truncate(reason, 80)}），已請 worker 自行 SendMessage`
}

/**
 * `$.prompt.submit` 正常 resolve 時的結果 → 排入失敗的原因；**進入了回 `null`**。
 * `{ drop }` 是「沒進入 session、也沒拋例外」的那一型：漏掉它，內容會停在已處理卻沒有人送。
 * 有 `drop` 鍵就算失敗，不看它的型別。以 `null` 而非空字串表示成功：空字串是合法的失敗原因。
 */
export function submitFailure(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || !('drop' in result)) return null
  const drop = (result as { drop?: unknown }).drop
  return `被擋下：${typeof drop === 'string' && drop ? drop : '（未附原因）'}`
}

/**
 * 執行一次排入並把結局歸成失敗原因；**進入了回 `null`**。拋例外（含同步拋出）與 resolve 為 `{ drop }` 皆為失敗。
 * 排入呼叫由參數傳入，讓例外路徑可測（測試引擎的 prompt.submit 做不出「拋例外」）。
 */
export async function trySubmit(submit: () => Promise<unknown>): Promise<string | null> {
  try {
    return submitFailure(await submit())
  } catch (err) {
    return String(err) || '排入時拋出例外（無訊息）'
  }
}

/**
 * 送件失敗且降級 prompt 也沒排進去：沒有人會送出這份內容，畫面不得暗示有人接手。
 *
 * - `result`：`resend`＝已回滾為未處理、下一個以答覆結束的 turn 會重送；`lost`＝回滾本身失敗，不會重送；
 *   `none`＝本次沒有結果檔部分。
 * - `finalReply`：本次是否附帶最終回覆。最終回覆沒有比對狀態可回滾，排入失敗即不會重送，SHALL 明說。
 */
export function degradeFailedLine(
  sendReason: string,
  submitReason: string,
  outcome: { result: 'resend' | 'lost' | 'none'; finalReply: boolean },
): string {
  const parts: string[] = []
  if (outcome.result === 'resend') parts.push('結果檔內容維持未送出，下次 turn 結束時重送')
  if (outcome.result === 'lost') parts.push('結果檔內容無法回滾為未處理，不會重送')
  if (outcome.finalReply) parts.push('本則最終回覆不會重送')
  if (outcome.result !== 'resend' || outcome.finalReply) parts.push('請指揮站以完成條件判定進度')
  return `⚠ dispatch-relay：轉送失敗（${truncate(sendReason, 80)}），也無法請 worker 自行送出（${truncate(submitReason, 80)}）；${parts.join('；')}`
}

export function failedAgainLine(reason: string): string {
  return `⚠ dispatch-relay：降級 turn 內轉送再度失敗（${truncate(reason, 80)}），不再請 worker 自送；請指揮站以完成條件判定進度`
}

/** 降級 prompt 可引用的收件位址。`lastDelivered`：最近一次成功送達時引擎實際使用的位址。 */
export type DegradeAddress = { station: string; lastDelivered?: string }

/**
 * 降級 prompt：載明失敗原因；要求 worker 自己 SendMessage 全文；不要求落成另一個檔案；告訴 worker 送去哪裡。
 * 位址依可靠度排序：指揮站最近一則訊息的 `from` 位址 → 上次成功送達時的位址 → mission 檔的 station 名稱。
 * 各位址候選各占一行，model 不必從連成一串的句子裡切出位址。
 */
export function degradePrompt(built: Built, reason: string, resultFile: string, addr: DegradeAddress): string {
  const what: string[] = []
  if (built.parts.some(p => p === 'result-full' || p === 'result-append')) {
    what.push(`${resultFile} 的內容（${built.parts.includes('result-append') ? '本次新增的部分' : '全文'}）`)
  }
  if (built.parts.includes('final-reply')) what.push('你剛才那則最終回覆')
  const lines = [
    `dispatch-relay 沒能把回報轉送給指揮站（${reason}）。`,
    `請改用 SendMessage，把${what.join('與')}原文放進訊息本體送給指揮站。`,
    '收件者：回覆指揮站最近一則送給你的訊息的 from 位址（該則 <cross-session-message> 的 from 屬性）。',
  ]
  if (addr.lastDelivered) {
    lines.push(`上次成功送達指揮站時使用的位址是 ${addr.lastDelivered}（指揮站若已重開可能失效，以 from 位址為優先）。`)
  }
  lines.push(`沒有 from 位址時，mission 檔記錄的指揮站名稱是 ${addr.station}（名稱有重複時無法送達）。`)
  lines.push('不要為此另外寫檔。')
  return lines.join('\n')
}

/** `prompt.compose` 注入段。刻意只說「寫進結果檔、以一行結束、不要另外 SendMessage」，不提降級細節。 */
export function injectionText(id: Identity): string {
  return [
    `本 session 是 mission ${id.missionId} 節點 ${id.nodeId} 的 worker，掛了 dispatch-relay（回報轉送）。`,
    `每個 turn 結束時，dispatch-relay 會把專案根目錄 ${id.resultFile} 新增或變更的內容、以及你的最終回覆，原文送給指揮站 ${id.station}。`,
    `因此：回報寫進 ${id.resultFile} 後直接以一行結束本 turn；不要為同一份回報另外呼叫 SendMessage，也不要為回報再讀取或驗證結果檔。`,
    '需要問指揮站、被擋住或需要它決策時，照常用 SendMessage，或把問題寫在最終回覆，同樣會送達。',
    '節點是否完成仍以 mission 檔的完成條件為準。',
  ].join('')
}

// ── tool.check 的收件者判斷 ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `SendMessage` 的 `tool.check` 輸入裡的收件者 vs 指揮站 id。
 * plugin 以 `{ sessionId }` 送件時，事件的收件者通常是引擎解析後的位址（`uds:…`），無從對回 session id：
 * 此時是 `unverifiable`，退回只驗證寄件 mod。收件者明確是另一個 session id 時是 `mismatch`。
 */
export function classifyRecipient(input: unknown, station: string): 'match' | 'mismatch' | 'unverifiable' {
  const to = input && typeof input === 'object' ? (input as any).to ?? (input as any).recipient : undefined
  if (typeof to !== 'string' || to === '') return 'unverifiable'
  if (station && to === station) return 'match'
  return UUID_RE.test(to) ? 'mismatch' : 'unverifiable'
}

/**
 * `tool.check { tool: 'SendMessage' }` 的判定：只放行「由本 mod 發出、且收件者不是別的 session」的送件。
 * 其餘一律 `pass`（交給下一個 hook／引擎原本的流程）——worker 自己的 SendMessage 不被攔截、改寫或拒絕。
 * `lax` 為真代表收件者無法驗證、只驗證了寄件 mod，呼叫端 SHALL 出聲。
 */
export function sendCheckVerdict(
  active: boolean,
  originPlugin: string | undefined,
  input: unknown,
  station: string,
): { verdict: 'allow' | 'pass'; lax: boolean } {
  if (!active || originPlugin !== PLUGIN) return { verdict: 'pass', lax: false }
  const recipient = classifyRecipient(input, station)
  if (recipient === 'mismatch') return { verdict: 'pass', lax: false }
  return { verdict: 'allow', lax: recipient === 'unverifiable' }
}
