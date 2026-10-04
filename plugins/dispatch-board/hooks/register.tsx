// dispatch-board：多個 Claude Code session 分工時的派工看板。
//
// - 讀使用者層級目錄（預設 ~/.claude/missions/）裡的 mission 檔；每個節點有負責的 session 名稱與
//   完成條件（shell 指令，退出碼 0＝完成）。
// - 安全邊界：完成條件會被執行，所以目錄必須在家目錄底下、不在 git 工作樹內、不在本 session 的
//   專案目錄內；自訂目錄只認使用者層級設定。檔案經符號連結指到目錄外一律拒讀。
// - session 狀態來自 `claude agents --json`（不解析文字輸出）。
// - 計時器每 5 秒一拍；面板開著每 5 秒、關著每 30 秒更新一次。目錄裡沒有 mission 檔時只列目錄，
//   不執行任何指令。狀態轉換時跳 toast（第一份快照只作基準）。
// - 唯讀：不寫檔、不送 prompt、不碰其他 session；「複製收斂指令」只寫剪貼簿。

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BadFile, BoardMission, BoardSnapshot, NodeEval, Roster } from './logic'
import { DEMO_SNAPSHOTS } from './demo'
import {
  BAND_POLL_MS,
  DEFAULT_DIR,
  DONE_TIMEOUT_MS,
  EVAL_CONCURRENCY,
  MAX_FILE_BYTES,
  ROSTER_TIMEOUT_MS,
  TICK_MS,
  TOAST_MS,
  bandText,
  classifyExit,
  configRefusal,
  diffToasts,
  dirRefusal,
  expandDir,
  gitProbePaths,
  isMissionFileName,
  isUnder,
  mapPool,
  missionNode,
  nextBlockedSince,
  nextSeen,
  paneModel,
  parseMission,
  parseRoster,
  pollDue,
  rejectionReason,
  sessionView,
  tildify,
  truncate,
} from './logic'
import type { MissionSpec, PaneRow } from './logic'

const PANE = 'dispatch-board'

const isPaneOpen = atom({ plugin: 'dispatch-board', key: 'isPaneOpen' } as const, false)
const isPaused = atom({ plugin: 'dispatch-board', key: 'isPaused' } as const, false)
const isDemo = atom({ plugin: 'dispatch-board', key: 'isDemo' } as const, false)
const snapshot = atom({ plugin: 'dispatch-board', key: 'snapshot' } as const, null)
const lastOkAt = atom({ plugin: 'dispatch-board', key: 'lastOkAt' } as const, null)
const failure = atom({ plugin: 'dispatch-board', key: 'failure' } as const, null)
const blockedSince = atom({ plugin: 'dispatch-board', key: 'blockedSince' } as const, {})
const seenSessions = atom({ plugin: 'dispatch-board', key: 'seenSessions' } as const, {})
const tickAt = atom({ plugin: 'dispatch-board', key: 'tickAt' } as const, 0)

// 模組層狀態：熱重載時歸零（計時器隨之重建）。
let dirSetting = DEFAULT_DIR
let inFlight = false
let lastAttemptAt: number | null = null
let demoIndex = 0

function toast($: any, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  } catch {}
}

async function realPathOf($: any, path: string): Promise<string | undefined> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return st?.realPath
}

type Located =
  | { kind: 'ok'; home: string; realDir: string; display: string }
  | { kind: 'missing'; display: string }
  | { kind: 'refused'; error: string }

/** 找出 mission 目錄並檢查安全邊界。任何一步不確定都拒讀，不退而求其次。 */
async function locate($: any): Promise<Located> {
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) return { kind: 'refused', error: '讀不到家目錄（HOME 未設定），不讀任何 mission 檔' }
  if (dirSetting.trim() !== DEFAULT_DIR) {
    const userSettings = await $.settings.read({ source: 'user' }).catch(() => ({}))
    const refused = configRefusal(dirSetting, userSettings)
    if (refused) return { kind: 'refused', error: refused }
  }
  const expanded = expandDir(dirSetting, home)
  if (!expanded.ok) return { kind: 'refused', error: expanded.error }
  const display = tildify(expanded.path, home)
  const realHome = await realPathOf($, home)
  if (!realHome) return { kind: 'refused', error: `家目錄 ${home} 解析不了，不讀任何 mission 檔` }
  const dirStat = await $.fs.stat(expanded.path, { resolve: true }).catch(() => undefined)
  if (!dirStat) return { kind: 'missing', display }
  if (dirStat.kind !== 'dir' || !dirStat.realPath) return { kind: 'refused', error: `${display} 不是目錄` }
  const realDir: string = dirStat.realPath
  const projectDirs: string[] = []
  for (const p of [await $.session.root(), await $.session.cwd()]) projectDirs.push((await realPathOf($, p)) ?? p)
  const gitHits: string[] = []
  for (const p of gitProbePaths(realDir, realHome)) if (await $.fs.exists(p)) gitHits.push(p)
  const refused = dirRefusal({ realHome, realDir, projectDirs, gitHits })
  if (refused) return { kind: 'refused', error: refused }
  return { kind: 'ok', home: realHome, realDir, display }
}

type Loaded = { specs: { file: string; spec: MissionSpec }[]; bad: BadFile[] }

/** 讀目錄第一層的 *.json；經符號連結指到目錄外、太大、格式錯的檔列為讀不了，附原因。 */
async function loadMissions($: any, realDir: string): Promise<Loaded> {
  const out: Loaded = { specs: [], bad: [] }
  const entries = await $.fs.list(realDir)
  const names = entries
    .filter((e: any) => e.kind !== 'dir' && isMissionFileName(e.name))
    .map((e: any) => String(e.name))
    .sort()
  const ids = new Set<string>()
  for (const name of names) {
    const path = `${realDir}/${name}`
    const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (!st?.realPath || !isUnder(st.realPath, realDir)) {
      out.bad.push({ file: path, reason: '經符號連結指到 mission 目錄外，拒讀' })
      continue
    }
    if (st.kind !== 'file') continue
    if (st.size > MAX_FILE_BYTES) {
      out.bad.push({ file: path, reason: `檔案超過 ${MAX_FILE_BYTES / 1024} KB` })
      continue
    }
    let text: string
    try {
      text = await $.fs.read(st.realPath)
    } catch (err) {
      out.bad.push({ file: path, reason: `讀檔失敗：${truncate(String(err), 60)}` })
      continue
    }
    const parsed = parseMission(text, name)
    if (!parsed.ok) {
      out.bad.push({ file: path, reason: parsed.reason })
      continue
    }
    if (ids.has(parsed.value.mission_id)) {
      out.bad.push({ file: path, reason: `mission_id「${parsed.value.mission_id}」和另一個檔重複` })
      continue
    }
    ids.add(parsed.value.mission_id)
    out.specs.push({ file: st.realPath, spec: parsed.value })
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

/** 一條完成條件：`sh -c`，cwd 為家目錄，5 秒逾時；跑不起來或逾時＝無法判定。 */
async function evaluate($: any, cmd: string, cwd: string): Promise<NodeEval> {
  const startedAt: number = await $.clock.now()
  try {
    const r = await $.process.run(['/bin/sh', '-c', cmd], { cwd, timeoutMs: DONE_TIMEOUT_MS })
    return classifyExit(r.exitCode, r.stderr)
  } catch (err) {
    return { kind: 'unknown', reason: rejectionReason(err, (await $.clock.now()) - startedAt) }
  }
}

type Fetched = { ok: true; value: BoardSnapshot; roster: Roster; names: string[] } | { ok: false; error: string }

async function fetchBoard($: any): Promise<Fetched> {
  if (await read($, isDemo)) {
    const value = DEMO_SNAPSHOTS[Math.min(demoIndex, DEMO_SNAPSHOTS.length - 1)] as BoardSnapshot
    demoIndex += 1
    return { ok: true, value, roster: { available: false, note: 'demo' }, names: [] }
  }
  const loc = await locate($)
  if (loc.kind === 'refused') return { ok: false, error: loc.error }
  const empty = { dir: loc.display, roster: { available: true, note: '' }, missions: [], bad: [] }
  if (loc.kind === 'missing') return { ok: true, value: empty, roster: { available: true, entries: [] }, names: [] }
  let loaded: Loaded
  try {
    loaded = await loadMissions($, loc.realDir)
  } catch (err) {
    return { ok: false, error: `讀不了 mission 目錄 ${loc.display}：${truncate(String(err), 80)}` }
  }
  // 沒有 mission 就不叫名冊、不執行任何指令
  if (!loaded.specs.length) return { ok: true, value: { ...empty, bad: loaded.bad }, roster: { available: true, entries: [] }, names: [] }
  const roster = await fetchRoster($)
  const seen = await read($, seenSessions)
  const jobs = loaded.specs.flatMap(({ spec }) => spec.nodes.map(n => n.done))
  const evals = await mapPool(jobs, EVAL_CONCURRENCY, cmd => evaluate($, cmd, loc.home))
  let i = 0
  const missions: BoardMission[] = loaded.specs.map(({ file, spec }) => ({
    mission_id: spec.mission_id,
    title: spec.title,
    file,
    nodes: spec.nodes.map(n => missionNode(n, evals[i++] as NodeEval, sessionView(n.session, roster, seen))),
  }))
  const names = loaded.specs.flatMap(({ spec }) => spec.nodes.map(n => n.session))
  return {
    ok: true,
    value: { dir: loc.display, roster: roster.available ? { available: true, note: '' } : roster, missions, bad: loaded.bad },
    roster,
    names,
  }
}

async function applyResult($: any, fetched: Fetched, now: number): Promise<void> {
  if (!fetched.ok) {
    const prevFailure = await read($, failure)
    await update($, failure, () => fetched.error)
    if (prevFailure !== fetched.error) toast($, `dispatch-board：${fetched.error}`)
    return
  }
  const prev = await read($, snapshot)
  const toasts = diffToasts(prev, fetched.value)
  const since = await read($, blockedSince)
  const seen = await read($, seenSessions)
  await update($, seenSessions, () => nextSeen(seen, fetched.roster, fetched.names, now))
  await update($, blockedSince, () => nextBlockedSince(since, fetched.value, now))
  await update($, snapshot, () => fetched.value)
  await update($, lastOkAt, () => now)
  await update($, failure, () => null)
  for (const t of toasts) toast($, t)
}

async function poll($: any): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    lastAttemptAt = await $.clock.now()
    const fetched = await fetchBoard($)
    // 輪詢期間被 /dispatch off 停掉時，結果不再套用
    if (await read($, isPaused)) return
    await applyResult($, fetched, await $.clock.now())
  } finally {
    inFlight = false
  }
}

async function onTick($: any): Promise<void> {
  if (await read($, isPaused)) return
  const now = await $.clock.now()
  const s = await read($, snapshot)
  // 只在 band 有東西時重繪「N 秒前」，沒有 mission 的 session 不必每拍重畫
  if ((s && (s.missions.length || s.bad.length)) || (await read($, failure)) !== null) await update($, tickAt, () => now)
  if (pollDue(now, lastAttemptAt, await read($, isPaneOpen))) await poll($)
}

async function resetBaseline($: any): Promise<void> {
  await update($, snapshot, () => null)
  await update($, blockedSince, () => ({}))
  await update($, failure, () => null)
  await update($, lastOkAt, () => null)
  lastAttemptAt = null
}

async function onSessionStart($: any, e: any, next: any) {
  const out = await next(e)
  await $.command.register({ name: 'dispatch', description: '派工看板：開關面板；/dispatch off 停止、/dispatch demo 用假資料試看' })
  let envDemo = false
  try {
    envDemo = (await $.env.get('DISPATCH_BOARD_DEMO')) === '1'
  } catch {}
  if (envDemo && !(await read($, isDemo))) {
    await update($, isDemo, () => true)
    await resetBaseline($)
  }
  // claude -p 與 SDK 沒有人看，不輪詢
  if (e.isInteractive) {
    $.clock.every(TICK_MS, () => {
      void onTick($).catch(() => {})
    })
    void onTick($).catch(() => {})
  }
  return out
}

async function openPane($: any): Promise<void> {
  await update($, isPaneOpen, () => true)
  await $.ui.open({ id: PANE, title: 'dispatch-board' })
  lastAttemptAt = null
  void poll($).catch(() => {})
}

async function onDispatchCommand($: any, e: any) {
  const arg = String(e.args ?? '').trim()
  if (arg === 'off') {
    await update($, isPaused, () => true)
    await resetBaseline($)
    if (await read($, isPaneOpen)) await $.ui.close({ id: PANE }).catch(() => {})
    return { text: 'dispatch-board 已停止（本 session 不再讀 mission、不再執行完成條件）。/dispatch 重新開始。' }
  }
  if (arg === 'demo') {
    const next = !(await read($, isDemo))
    await update($, isDemo, () => next)
    await update($, isPaused, () => false)
    demoIndex = 0
    await resetBaseline($)
    if (next && !(await read($, isPaneOpen))) await openPane($)
    else void poll($).catch(() => {})
    return { text: next ? 'dispatch-board demo 模式：假資料，每次更新往下一格。再打 /dispatch demo 結束。' : 'dispatch-board 已離開 demo 模式。' }
  }
  if (arg !== '') return { text: '用法：/dispatch（開關面板）、/dispatch off（停止）、/dispatch demo（假資料試看）' }
  if (await read($, isPaused)) {
    await update($, isPaused, () => false)
    await resetBaseline($)
  }
  if (await read($, isPaneOpen)) {
    await $.ui.close({ id: PANE }).catch(() => {})
    return { text: `dispatch-board 面板已關閉（仍每 ${BAND_POLL_MS / 1000} 秒更新 band；/dispatch off 停止）。` }
  }
  await openPane($)
  return { text: 'dispatch-board 面板已開啟。' }
}

async function onPaneClose($: any, e: any, next: any) {
  if (e.id === PANE) await update($, isPaneOpen, () => false)
  return next(e)
}

async function onAbovePrompt($: any, e: any, next: any) {
  if ((await read($, isPaused)) || e.props?.hasSurvey) return next(e)
  await read($, tickAt) // 訂閱：每拍重繪，讓「N 秒前」跟著走
  const fail = await read($, failure)
  const text = bandText(await read($, snapshot), fail, await read($, lastOkAt), await $.clock.now())
  if (text === null) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  // AbovePrompt 是一條 hook 鏈：不呼叫 next 的 hook 會吃掉下層 plugin 的 band。
  // 一律先畫自己那一行，再接上下層的結果。
  const below = await next(e)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" dimColor={fail === null} color={fail !== null ? 'yellow' : undefined}>
        {text}
      </Text>
      {below}
    </Box>
  )
}

async function onPane($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  await read($, tickAt)
  const s = await read($, snapshot)
  const fail = await read($, failure)
  const since = await read($, blockedSince)
  const okAt = await read($, lastOkAt)
  const demo = await read($, isDemo)
  const now = await $.clock.now()

  const paneRow = (row: PaneRow, i: number) => {
    const text = (
      <Text
        key={`t${i}`}
        wrap="truncate-end"
        bold={row.tone === 'bold' || undefined}
        dimColor={row.tone === 'dim' || undefined}
        color={row.tone === 'warn' ? 'yellow' : undefined}
      >
        {row.text}
      </Text>
    )
    if (!row.copy) return text
    const { key, text: cmd } = row.copy
    // 只寫剪貼簿：mod 不搬檔
    return (
      <Box key={`row:${key}`} flexDirection="column">
        {text}
        <Button key={key} label="複製搬移指令" dimColor onPress={(p: any) => void $.ui.copy({ text: cmd, surface: p.surface }).catch(() => {})} />
      </Box>
    )
  }

  const rows: any[] = []
  if (demo) rows.push(<Text key="demo" color="cyan">demo 模式：假資料（/dispatch demo 結束）</Text>)
  if (fail !== null) rows.push(<Text key="fail" color="yellow" wrap="truncate-end">{fail}</Text>)
  if (s === null) rows.push(<Text key="loading" dimColor>{fail === null ? '讀取中…' : '尚無成功的快照'}</Text>)
  else paneModel(s, since, now).forEach((row, i) => rows.push(paneRow(row, i)))
  rows.push(
    <Text key="footer" dimColor wrap="truncate-end">
      {okAt === null ? '尚未成功更新' : `上次更新：${Math.max(0, Math.round((now - okAt) / 1000))}s 前`}
    </Text>,
  )
  return (
    <Box flexDirection="column">
      {rows}
      <Box>
        <Button
          key="refresh"
          label="立即更新"
          onPress={() => {
            lastAttemptAt = null
            void poll($).catch(() => {})
          }}
        />
        <Button key="close" label="關閉" onPress={() => $.ui.close({ id: PANE }).catch(() => {})} />
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const configured = (options as Record<string, unknown> | undefined)?.missions_dir
  dirSetting = typeof configured === 'string' && configured.trim() ? configured : DEFAULT_DIR
  on('session.start', onSessionStart)
  on('command.run', { command: 'dispatch' }, onDispatchCommand)
  on('ui.close', onPaneClose)
  on('ui.render', { component: 'AbovePrompt' }, onAbovePrompt)
  on('ui.render', { component: 'Pane', requestId: PANE }, onPane)
}
