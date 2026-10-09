// dispatch-relay：worker session 的回報由 mod 在 turn 結束時轉送給指揮站。
//
// 作用面（全部）：
//   - prompt.compose 尾端加一段說明（只在啟用時）。
//   - turn.complete 讀結果檔（預設 `<session 根目錄>/.mission-result.md`），內容有變更才轉送；
//     worker 本 turn 沒自送時附帶最終回覆。
//   - tool.check 只放行「本 mod 自己發出」的送件；worker 自己的 SendMessage 原樣通過。
//   - session.send 只觀察本 mod 自己的送件，記下送達時引擎使用的位址（供降級 prompt 引用），原樣放行。
//   - 送件失敗時請 worker 自己 SendMessage（先記為已處理，同一內容至多降級一次；降級排不進去則回滾，下次 turn 重送）。
// 不做：不寫任何檔案（日誌走 ui.log、狀態走 store）、不寫結果檔、不執行 mission 檔的完成條件。
//
// 啟用判定：`$.session.id()` → `claude agents --json` 反查本 session 的名稱 → mission 目錄裡恰好一個節點的
// `session` 是這個名稱，且該 mission 有 `station` 欄位（opt-in）。mission 目錄的安全邊界與 dispatch-board 相同。

import type { Register } from 'claude-code'

import {
  DEFAULT_DIR,
  MAX_FILE_BYTES,
  PLUGIN,
  ROSTER_TIMEOUT_MS,
  SECTION_ID,
  buildMessage,
  degradeFailedLine,
  degradePrompt,
  degradedLine,
  deliveredLine,
  dirRefusal,
  expandDir,
  failedAgainLine,
  findIdentity,
  gitProbePaths,
  inactiveLog,
  injectionText,
  isMissionFileName,
  isUnder,
  ownName,
  parseMission,
  parseRoster,
  pickDir,
  resolveStation,
  sendCheckVerdict,
  truncate,
  trySubmit,
} from './logic'
import type { Built, Identity, RelayMission, Resolution, Roster } from './logic'

// ── 模組狀態（熱重載即重來；持久狀態只放 $.store）─────────────────────────────
let dirSetting = DEFAULT_DIR
let identity: Identity | null = null // 啟用後的節點身份；每個答覆 turn 結束時重新判定
let lastStationId = '' // 最近一次解析到的指揮站 session id：tool.check 比對用
let lastDelivered = '' // 最近一次成功送達時引擎實際使用的收件位址（uds:…），降級 prompt 引用；綁行程，不進 $.store
let lastDeliveredStation = '' // 取得 lastDelivered 的那次送件，送往的指揮站 id；與目前 id 不同時不引用該位址
// forward() 送件期間的指揮站 id，供 session.send 觀察 hook 與位址一起記下。
// 前提：forward() 不並行——它只在主迴圈的 turn.complete 被呼叫，同一 session 的主迴圈 turn 不重疊。
let sendingTo = ''
let selfSent = false // 本 turn worker 是否自己呼叫過 SendMessage（turn.start 重置）
let pendingDegrade = false // 本 mod 剛排入一個降級 prompt，等它的 turn.start
let inDegradedTurn = false // 目前這個 turn 是本 mod 排入的降級 turn
let lastInactiveLog = '' // 未啟用的原因只在改變時出聲，避免每個 prompt 重複同一行
let laxRecipientLogged = false

function log($: any, text: string): void {
  try {
    $.ui.log(text)
  } catch {}
}

function logInactive($: any, text: string): void {
  if (text === lastInactiveLog) return
  lastInactiveLog = text
  log($, text)
}

// ── mission 目錄（安全邊界與 dispatch-board 相同）────────────────────────────

async function realPathOf($: any, path: string): Promise<string | undefined> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return st?.realPath
}

type Located = { kind: 'ok'; realDir: string } | { kind: 'missing' } | { kind: 'refused'; error: string }

/** 找出 mission 目錄並檢查安全邊界。任何一步不確定都拒讀，不退而求其次。 */
async function locate($: any): Promise<Located> {
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) return { kind: 'refused', error: '讀不到家目錄（HOME 未設定），不讀任何 mission 檔' }
  // 只讀使用者層級設定：本 mod 自訂值的來源檢查，以及沿用 dispatch-board 的 missions_dir。
  const userSettings = await $.settings.read({ source: 'user' }).catch(() => ({}))
  const picked = pickDir(dirSetting, userSettings ?? {})
  if (!picked.ok) return { kind: 'refused', error: picked.error }
  const expanded = expandDir(picked.dir, home)
  if (!expanded.ok) return { kind: 'refused', error: expanded.error }
  const realHome = await realPathOf($, home)
  if (!realHome) return { kind: 'refused', error: `家目錄 ${home} 解析不了，不讀任何 mission 檔` }
  const dirStat = await $.fs.stat(expanded.path, { resolve: true }).catch(() => undefined)
  if (!dirStat) return { kind: 'missing' }
  if (dirStat.kind !== 'dir' || !dirStat.realPath) return { kind: 'refused', error: `${expanded.path} 不是目錄` }
  const realDir: string = dirStat.realPath
  const projectDirs: string[] = []
  for (const p of [await $.session.root(), await $.session.cwd()]) projectDirs.push((await realPathOf($, p)) ?? p)
  const gitHits: string[] = []
  for (const p of gitProbePaths(realDir, realHome)) if (await $.fs.exists(p)) gitHits.push(p)
  const refused = dirRefusal({ realHome, realDir, projectDirs, gitHits })
  if (refused) return { kind: 'refused', error: refused }
  return { kind: 'ok', realDir }
}

/** 讀目錄第一層的 *.json；經符號連結指到目錄外、太大、格式錯、mission_id 重複的檔一律略過（dispatch-board 會列出原因）。 */
async function loadMissions($: any, realDir: string): Promise<RelayMission[]> {
  const out: RelayMission[] = []
  const entries = await $.fs.list(realDir)
  const names = entries
    .filter((e: any) => e.kind !== 'dir' && isMissionFileName(e.name))
    .map((e: any) => String(e.name))
    .sort()
  const ids = new Set<string>()
  for (const name of names) {
    const st = await $.fs.stat(`${realDir}/${name}`, { resolve: true }).catch(() => undefined)
    if (!st?.realPath || !isUnder(st.realPath, realDir) || st.kind !== 'file' || st.size > MAX_FILE_BYTES) continue
    let text: string
    try {
      text = await $.fs.read(st.realPath)
    } catch {
      continue
    }
    const parsed = parseMission(text, name)
    if (!parsed.ok || ids.has(parsed.value.missionId)) continue
    ids.add(parsed.value.missionId)
    out.push(parsed.value)
  }
  return out
}

async function fetchRoster($: any): Promise<Roster> {
  try {
    const r = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: ROSTER_TIMEOUT_MS })
    return parseRoster(r.exitCode, r.stdout, r.stderr)
  } catch (err) {
    return { available: false, note: `claude agents --json 跑不起來：${truncate(String(err), 80)}` }
  }
}

/**
 * 身份判定；never throw。沒有任何 mission 選用 relay（沒有 `station`）時不讀名冊、不啟動任何程式：
 * 本 mod 經 marketplace 安裝會在每個 session 載入，沒用到它的 session 不該付這個成本。
 * `full`：已啟用的 worker 重新判定時一律讀名冊，停用訊息才能分辨「節點還在但 mission 拿掉了 station」與「沒有節點」。
 */
async function resolve($: any, full = false): Promise<{ res: Resolution; roster: Roster | null }> {
  try {
    const where = await locate($)
    if (where.kind === 'refused') return { res: { kind: 'unavailable', reason: where.error }, roster: null }
    if (where.kind === 'missing') return { res: { kind: 'no-missions' }, roster: null }
    const missions = await loadMissions($, where.realDir)
    if (missions.length === 0) return { res: { kind: 'no-missions' }, roster: null }
    if (!full && !missions.some(m => m.station)) return { res: { kind: 'no-relay' }, roster: null }
    let sessionId = ''
    try {
      sessionId = String((await $.session.id()) ?? '')
    } catch {}
    if (!sessionId) return { res: { kind: 'unavailable', reason: '取不到本 session 的 id' }, roster: null }
    const roster = await fetchRoster($)
    if (!roster.available) return { res: { kind: 'unavailable', reason: `名冊不可用（${roster.note}）` }, roster }
    const name = ownName(roster.entries, sessionId)
    if (!name) return { res: { kind: 'unavailable', reason: '名冊上找不到本 session 的名稱（用 --name 命名的 session 才能對到節點）' }, roster }
    return { res: findIdentity(missions, name), roster }
  } catch (err) {
    return { res: { kind: 'unavailable', reason: `判定身份時出錯：${truncate(String(err), 120)}` }, roster: null }
  }
}

/** 啟用嘗試：尚未啟用時才查。 */
async function tryActivate($: any): Promise<void> {
  if (identity !== null) return
  const { res } = await resolve($)
  if (res.kind === 'match') {
    identity = res.identity
    lastInactiveLog = ''
    log($, `已啟用：mission ${identity.missionId} 節點 ${identity.nodeId}，回報轉送給 ${identity.station}`)
    return
  }
  logInactive($, inactiveLog(res))
}

// ── 轉送與降級 ──────────────────────────────────────────────────────────────

/** 唯一的送件點：把訊息送給指揮站（每次送件前由名冊把名稱解析成 session id，不猜）。 */
async function forward($: any, built: Built, roster: Roster | null, station: string): Promise<{ ok: boolean; reason: string }> {
  const to = resolveStation(roster ?? { available: false, note: '沒有名冊' }, station)
  if (!to.ok) return { ok: false, reason: to.reason }
  lastStationId = to.sessionId
  sendingTo = to.sessionId
  try {
    const sent: any = await $.session.send({ to: { sessionId: to.sessionId }, text: built.text })
    return sent && sent.isDelivered ? { ok: true, reason: '' } : { ok: false, reason: String(sent?.reason ?? '未送達') }
  } catch (err) {
    return { ok: false, reason: String(err) }
  } finally {
    sendingTo = ''
  }
}

/**
 * 唯一的降級點：排一個 turn 請 worker 自己 SendMessage。呼叫端 SHALL 已先把內容記為已處理。
 * 排入呼叫拋例外，或 resolve 為 `{ drop }`，皆為失敗——後者若當成功，內容會停在「已處理」卻沒有人送。
 */
async function degrade($: any, id: Identity, built: Built, reason: string): Promise<{ ok: boolean; reason: string }> {
  pendingDegrade = true
  // 上次成功送達的位址只在「送往的正是目前這個指揮站 id」時才給：id 改變代表指揮站重開，舊位址綁的是舊行程。
  const usable = lastDelivered && lastDeliveredStation === lastStationId ? lastDelivered : ''
  const text = degradePrompt(built, reason, id.resultFile, { station: id.station, lastDelivered: usable })
  const failure = await trySubmit(() => $.prompt.submit({ text }))
  if (failure === null) return { ok: true, reason: '' }
  pendingDegrade = false
  log($, `降級 prompt 排入失敗：${truncate(failure, 120)}`)
  return { ok: false, reason: failure }
}

/** 讀結果檔；不存在回 null。解析符號連結後不在 session 根目錄底下的一律不讀——它的內容會被送出去。 */
async function readResult($: any, root: string, file: string): Promise<string | null> {
  try {
    const realRoot = (await realPathOf($, root)) ?? root
    const st = await $.fs.stat(`${root}/${file}`, { resolve: true }).catch(() => undefined)
    if (!st) return null
    if (!st.realPath || !isUnder(st.realPath, realRoot)) {
      log($, `結果檔 ${file} 解析後不在 session 根目錄底下，不讀也不送`)
      return null
    }
    if (st.kind !== 'file') return null
    if (st.size > MAX_FILE_BYTES) {
      log($, `結果檔 ${file} 超過 ${MAX_FILE_BYTES / 1024} KB，不送`)
      return null
    }
    return String(await $.fs.read(st.realPath))
  } catch {
    return null
  }
}

function sentKey(root: string, file: string): string {
  return `relay:sent:${root}/${file}`
}

async function readSent($: any, key: string): Promise<string | undefined> {
  try {
    const v = await $.store.get(key)
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

async function markSent($: any, key: string, content: string): Promise<void> {
  try {
    await $.store.set(key, content)
  } catch (err) {
    log($, `無法記錄已處理的結果檔內容（下次會重送）：${truncate(String(err), 120)}`)
  }
}

/**
 * 降級排入失敗時把「已處理」恢復為轉送前的值；轉送前沒有值就刪鍵（缺失視為從未處理，下次送全文）。
 * 回傳是否恢復成功：失敗時內容仍停在已處理、不會重送，畫面須照實說。
 */
async function restoreSent($: any, key: string, prev: string | undefined): Promise<boolean> {
  try {
    if (prev === undefined) await $.store.delete(key)
    else await $.store.set(key, prev)
    return true
  } catch (err) {
    log($, `無法回滾已處理狀態（這份內容不會自動重送）：${truncate(String(err), 120)}`)
    return false
  }
}

export const register: Register = (on, options) => {
  const configured = (options as Record<string, unknown> | undefined)?.missions_dir
  dirSetting = typeof configured === 'string' && configured.trim() ? configured : DEFAULT_DIR

  on('session.start', async ($, e, next) => {
    await tryActivate($)
    return next(e)
  })

  // 啟動時 mission 檔可能還沒寫好、session 可能還沒命名：每個新 prompt 在尚未啟用時重試。
  // 本 mod 自己排入的降級 prompt 不觸發重試（能降級代表已啟用）。
  on('prompt.submit', async ($, e, next) => {
    const own = (e as any).origin?.kind === 'plugin' && (e as any).origin?.name === PLUGIN
    if (identity === null && !own) await tryActivate($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (identity === null) return r
    return { ...r, sections: [...r.sections, { id: SECTION_ID, text: injectionText(identity), scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    selfSent = false
    inDegradedTurn = pendingDegrade
    pendingDegrade = false
    return next(e)
  })

  // 只觀察、原樣放行：記下 worker 本 turn 是否自己送過件。
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (identity !== null && (e as any).agentId === undefined) selfSent = true
    return next(e)
  })

  // 只觀察本 mod 自己的送件、原樣放行：送達時記下引擎實際使用的收件位址，供降級 prompt 引用。
  // origin 形狀是 { kind: 'plugin', name }（與 tool.check 的 next.origin.plugin 不同）。
  on('session.send', async ($, e, next) => {
    const origin = (e as any).origin
    if (!(origin?.kind === 'plugin' && origin?.name === PLUGIN)) return next(e)
    const r: any = await next(e)
    if (r?.isDelivered && typeof (e as any).to === 'string' && (e as any).to) {
      lastDelivered = (e as any).to
      lastDeliveredStation = sendingTo
    }
    return r
  })

  // 只放行本 mod 自己的送件（auto mode 的分類器會拒絕 plugin 的送件）。其他來源一律交給下一個 hook。
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    const origin = (next as any).origin
    const { verdict, lax } = sendCheckVerdict(identity !== null, origin?.plugin, (e as any).input, lastStationId)
    if (verdict === 'pass') return next(e)
    if (lax && !laxRecipientLogged) {
      laxRecipientLogged = true
      log($, '放行送件時無法驗證收件者（事件的收件者是引擎解析後的位址，不是 session id）：只驗證寄件 mod 為 dispatch-relay')
    }
    return { decision: 'allow' as const, reason: 'dispatch-relay 轉送回報給指揮站' }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const wasDegraded = inDegradedTurn
    inDegradedTurn = false
    if (identity === null || e.reason !== 'answer') return r

    // 每次送件前重新判定：mission 檔被搬走或改派、session 改名時停用；指揮站重開換 id 也跟得上。
    const { res, roster } = await resolve($, true)
    if (res.kind !== 'match') {
      identity = null
      logInactive($, `停用（${inactiveLog(res)}）`)
      return r
    }
    const id = res.identity
    identity = id

    let root = ''
    try {
      root = await $.session.root()
    } catch {
      return r
    }
    const key = sentKey(root, id.resultFile)
    const content = await readResult($, root, id.resultFile)
    const prev = await readSent($, key)
    const built = buildMessage(id, prev, content, e.answer, selfSent)
    if (built.parts.length === 0) return r

    const sent = await forward($, built, roster, id.station)
    if (sent.ok) {
      if (built.nextSent !== null) await markSent($, key, built.nextSent)
      return { ...r, text: deliveredLine(built, id.station) }
    }
    // 失敗：先把內容記為已處理，才排降級 turn——順序顛倒時，worker 在補記之前就自送並結束 turn 會被重送。
    if (built.nextSent !== null) await markSent($, key, built.nextSent)
    if (wasDegraded) {
      log($, `降級 turn 內轉送再度失敗：${truncate(sent.reason, 120)}`)
      return { ...r, text: failedAgainLine(sent.reason) }
    }
    const queued = await degrade($, id, built, sent.reason)
    if (queued.ok) return { ...r, text: degradedLine(sent.reason) }
    // 降級沒排進去：沒有人會送出這份內容。回滾為轉送前的狀態，讓下一個以答覆結束的 turn 重送（偏向重複而非漏送）；
    // 不自行排任何 prompt，所以不構成迴圈。
    const result = built.nextSent === null ? 'none' : (await restoreSent($, key, prev)) ? 'resend' : 'lost'
    const finalReply = built.parts.includes('final-reply')
    return { ...r, text: degradeFailedLine(sent.reason, queued.reason, { result, finalReply }) }
  })
}
