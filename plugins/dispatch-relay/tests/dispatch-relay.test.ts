// dispatch-relay 行為測試：`claude plugin test plugins/dispatch-relay`
//
// 測試的 `on` 位於所有 plugin 之下、扮演引擎：檔案系統（mission 目錄與結果檔）、設定、session id、
// `claude agents --json` 名冊由這裡假造，`session.send` 與本 mod 排入的 prompt 記錄下來。mod 不寫檔，所以沒有 fs.write。

import { describe, expect, mock, test } from 'claude-code/testing'

import {
  HOLD_LIMIT_MS,
  WAKE_TEXT,
  bgEntryOf,
  bgRegister,
  bgSettle,
  bgSettleCron,
  bgSettleStopped,
  bgSettleWake,
  buildMessage,
  checkResultFile,
  classifyRecipient,
  classifySendFailure,
  configRefusal,
  degradeFailedLine,
  degradePrompt,
  degradedLine,
  deletedCronIdOf,
  dirRefusal,
  failedAgainLine,
  failureHint,
  findIdentity,
  inactiveLog,
  injectionText,
  mergeHeld,
  parseHeld,
  parseMission,
  parseRoster,
  pickDir,
  resolveStation,
  resultChanged,
  sendCheckVerdict,
  shouldHold,
  stoppedTaskIdOf,
  submitFailure,
  trySubmit,
  wakeStoppedOf,
} from '../hooks/logic'
import type { RelayMission } from '../hooks/logic'

const HOME = '/home/u'
const DIR = `${HOME}/.claude/missions`
const ROOT = `${HOME}/code/shop`
const RESULT = `${ROOT}/.mission-result.md`
const SELF_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const STATION_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const STATION_ID_2 = 'bbbbbbbb-0000-4000-8000-000000000003'
const OTHER_ID = 'cccccccc-0000-4000-8000-000000000004'
const IDS = { missionId: 'shop', nodeId: 'api' }
const KEY = `relay:sent:${RESULT}`

const mission = (o: object) => JSON.stringify({ mission_id: 'shop', station: 'shop-lead', ...o })
const NODES = [
  { id: 'api', session: 'shop-api', done: 'true' },
  { id: 'web', session: 'shop-web', done: 'true' },
]
const ROSTER = [
  { name: 'shop-api', sessionId: SELF_ID },
  { name: 'shop-lead', sessionId: STATION_ID },
  { name: 'shop-web', sessionId: OTHER_ID },
]

// ── 純函式 ──────────────────────────────────────────────────────────────────

describe('logic：buildMessage', () => {
  test('首次寫入送全文，首行格式固定', async () => {
    const b = buildMessage(IDS, undefined, '# 回報\n內容\n', '', false)
    expect(b.parts).toEqual(['result-full'])
    expect(b.text).toBe(`[dispatch-relay] mission=shop node=api parts=result-full chars=${b.chars}\n\n--- result-full ---\n# 回報\n內容\n`)
    expect(b.nextSent).toBe('# 回報\n內容\n')
  })

  test('以上次內容為前綴時只送追加段；非前綴送全文；相同不送；空白不送', async () => {
    const a = buildMessage(IDS, '# 回報\n', '# 回報\n追加\n', '', false)
    expect(a.parts).toEqual(['result-append'])
    expect(a.text).not.toContain('# 回報')
    expect(buildMessage(IDS, '舊', '新', '', false).parts).toEqual(['result-full'])
    expect(buildMessage(IDS, '同', '同', '', false).parts).toEqual([])
    expect(buildMessage(IDS, '', 'abc', '', false).parts).toEqual(['result-full'])
    expect(buildMessage(IDS, undefined, ' \n', '', false).parts).toEqual([])
    const gone = buildMessage(IDS, '同', null, '', false)
    expect(gone.parts).toEqual([])
    expect(gone.nextSent).toBeNull()
  })

  test('最終回覆：單行提問也送；自送時不附；結果檔在前', async () => {
    expect(buildMessage(IDS, 'x', 'x', '要不要 push？', false).parts).toEqual(['final-reply'])
    expect(buildMessage(IDS, 'x', 'x', '收尾', true).parts).toEqual([])
    const both = buildMessage(IDS, undefined, '回報', '好了', false)
    expect(both.parts).toEqual(['result-full', 'final-reply'])
    expect(both.chars).toBe('回報'.length + '好了'.length)
    const self = buildMessage(IDS, undefined, '回報', '收尾', true)
    expect(self.parts).toEqual(['result-full'])
  })
})

describe('logic：mission 檔與結果檔路徑', () => {
  test('parseMission：station、result_file 預設、dispatch-board 的欄位照常存在', async () => {
    const r = parseMission(mission({ nodes: NODES }), 'x.json')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.station).toBe('shop-lead')
      expect(r.value.nodes[0]).toEqual({ id: 'api', session: 'shop-api', resultFile: '.mission-result.md' })
    }
    const noStation = parseMission(JSON.stringify({ nodes: NODES }), 'm2.json')
    expect(noStation.ok && noStation.value.station === '' && noStation.value.missionId === 'm2').toBe(true)
  })

  test('parseMission：result_file 跳出根目錄、絕對路徑、station 型別錯都拒絕', async () => {
    for (const rf of ['/etc/passwd', '../x.md', 'a/../../x', '~/x.md', 'a//b', './x']) {
      const r = parseMission(mission({ nodes: [{ id: 'api', session: 's', result_file: rf }] }), 'x.json')
      expect(r.ok).toBe(false)
    }
    expect(parseMission(mission({ station: 3, nodes: NODES }), 'x.json').ok).toBe(false)
    expect(parseMission('{', 'x.json').ok).toBe(false)
  })

  test('checkResultFile：子目錄可以', async () => {
    expect(checkResultFile('reports/api.md')).toEqual({ ok: true, path: 'reports/api.md' })
    expect(checkResultFile('')).toEqual({ ok: true, path: '.mission-result.md' })
  })

  test('dirRefusal／configRefusal：與 dispatch-board 同一套規則，設定鍵是本 mod 的', async () => {
    const base = { realHome: HOME, realDir: DIR, projectDirs: [ROOT], gitHits: [] }
    expect(dirRefusal(base)).toBe(null)
    expect(dirRefusal({ ...base, realDir: '/etc/m' })).toMatch(/不在家目錄/)
    expect(dirRefusal({ ...base, realDir: `${ROOT}/m` })).toMatch(/專案目錄/)
    expect(dirRefusal({ ...base, gitHits: [`${HOME}/code/.git`] })).toMatch(/git 工作樹/)
    expect(configRefusal('~/m', { pluginConfigs: { 'dispatch-relay@mkt': { options: { missions_dir: '~/m' } } } })).toBe(null)
    expect(configRefusal('~/m', { pluginConfigs: { 'dispatch-board': { options: { missions_dir: '~/m' } } } })).not.toBe(null)
  })
})

describe('logic：名冊與身份', () => {
  const missions = (list: object[]): RelayMission[] =>
    list.map(o => {
      const r = parseMission(JSON.stringify(o), 'x.json')
      if (!r.ok) throw new Error(r.reason)
      return r.value
    })

  test('parseRoster：帶 sessionId；壞輸出是不可用而不是空名冊', async () => {
    expect(parseRoster(0, JSON.stringify(ROSTER), '')).toEqual({ available: true, entries: ROSTER })
    expect(parseRoster(1, '', 'boom').available).toBe(false)
    expect(parseRoster(0, '{}', '').available).toBe(false)
  })

  test('resolveStation：不分大小寫；查無、同名多筆、名冊不可用都不猜', async () => {
    const roster = parseRoster(0, JSON.stringify(ROSTER), '')
    expect(resolveStation(roster, 'Shop-Lead')).toEqual({ ok: true, sessionId: STATION_ID })
    expect(resolveStation(roster, 'nobody').ok).toBe(false)
    const dup = parseRoster(0, JSON.stringify([...ROSTER, { name: 'SHOP-LEAD', sessionId: STATION_ID_2 }]), '')
    const r = resolveStation(dup, 'shop-lead')
    expect(r.ok === false && r.reason.includes('2 個')).toBe(true)
    expect(resolveStation({ available: false, note: 'x' }, 'shop-lead').ok).toBe(false)
  })

  test('findIdentity：恰好一個才啟用，名稱不分大小寫', async () => {
    const one = missions([{ mission_id: 'shop', station: 'shop-lead', nodes: NODES }])
    const m = findIdentity(one, 'SHOP-API')
    expect(m).toEqual({ kind: 'match', identity: { missionId: 'shop', nodeId: 'api', station: 'shop-lead', resultFile: '.mission-result.md' } })
    expect(findIdentity(one, 'someone')).toEqual({ kind: 'none', name: 'someone' })
    expect(findIdentity(one, '')).toEqual({ kind: 'none', name: '' })
    const two = missions([
      { mission_id: 'shop', station: 'shop-lead', nodes: NODES },
      { mission_id: 'blog', station: 'lead', nodes: [{ id: 'x', session: 'shop-api' }] },
    ])
    expect(findIdentity(two, 'shop-api')).toEqual({ kind: 'ambiguous', candidates: ['shop/api', 'blog/x'] })
    const plain = missions([{ mission_id: 'shop', nodes: NODES }])
    expect(findIdentity(plain, 'shop-api').kind).toBe('no-station')
    const selfStation = missions([{ mission_id: 'shop', station: 'Shop-API', nodes: NODES }])
    expect(findIdentity(selfStation, 'shop-api').kind).toBe('self-station')
  })
})

describe('logic：注入段、降級文字、tool.check 判定', () => {
  const ID = { missionId: 'shop', nodeId: 'api', station: 'shop-lead', resultFile: 'reports/api.md' }

  test('注入段：結果檔路徑與指揮站名稱、不要另外 SendMessage；不提降級', async () => {
    const t = injectionText(ID)
    expect(t).toContain('reports/api.md')
    expect(t).toContain('shop-lead')
    expect(t).toContain('不要為同一份回報另外呼叫 SendMessage')
    expect(t).not.toContain('降級')
    expect(t).not.toContain('AskUserQuestion')
  })

  test('降級 prompt：station 名稱第一順位、上次位址其次、from 最後且僅限來自指揮站，各占一行', async () => {
    const built = buildMessage(IDS, undefined, 'x', '', false)
    const p = degradePrompt(built, 'gone', 'reports/api.md', { station: 'shop-lead', lastDelivered: 'uds:/tmp/s.sock' })
    expect(p).toContain('gone')
    expect(p).toContain('reports/api.md')
    expect(p).toContain('不要為此另外寫檔')
    const lines = p.split('\n')
    const at = ['收件者：shop-lead', 'uds:/tmp/s.sock', 'from 位址'].map(s => lines.findIndex(l => l.includes(s)))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at[0]! < at[1]! && at[1]! < at[2]!).toBe(true)
    // from 備援只認指揮站的來訊：第三方 session 的訊息不算
    const fromLine = lines[at[2]!]!
    expect(fromLine).toContain('僅當該則來自指揮站 shop-lead')
    expect(fromLine).toContain('來自其他 session 的訊息不算')
    const noAddr = degradePrompt(built, 'gone', 'r.md', { station: 'shop-lead' }).split('\n')
    expect(noAddr.join('\n')).not.toContain('uds:')
    expect(noAddr.findIndex(l => l.includes('收件者：shop-lead'))).toBeLessThan(noAddr.findIndex(l => l.includes('from 位址')))
  })

  test('inactiveLog：分辨「找到節點但 mission 沒有 station」「沒有指派給本 session 的節點」「沒有 mission 選用 relay」', async () => {
    const noStation = inactiveLog({ kind: 'no-station', missionId: 'shop', nodeId: 'api' })
    const none = inactiveLog({ kind: 'none', name: 'shop-api' })
    const noRelay = inactiveLog({ kind: 'no-relay' })
    expect(noStation).toContain('找到指派給本 session 的節點 shop/api')
    expect(noStation).toContain('沒有 station')
    expect(none).toContain('沒有指派給本 session（shop-api）的節點')
    expect(none).not.toContain('station')
    expect(noRelay).toContain('沒有任何 mission 寫 station')
    expect(new Set([noStation, none, noRelay]).size).toBe(3)
  })

  test('pickDir：relay 自己的 → dispatch-board 的 → 預設；都只認使用者層級設定', async () => {
    const cfg = (o: Record<string, string>) => ({ pluginConfigs: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { options: { missions_dir: v } }])) })
    expect(pickDir('~/.claude/missions', {})).toEqual({ ok: true, dir: '~/.claude/missions' })
    expect(pickDir('~/.claude/missions', cfg({ 'dispatch-board@mkt': '~/b' }))).toEqual({ ok: true, dir: '~/b' })
    expect(pickDir('~/r', cfg({ 'dispatch-relay@mkt': '~/r', 'dispatch-board@mkt': '~/b' }))).toEqual({ ok: true, dir: '~/r' })
    // relay 自己在使用者設定明寫預設值：仍以 relay 的為準，不改用 board 的
    expect(pickDir('~/.claude/missions', cfg({ 'dispatch-relay': '~/.claude/missions', 'dispatch-board': '~/b' }))).toEqual({ ok: true, dir: '~/.claude/missions' })
    // relay 的非預設值不是使用者層級給的：拒絕，不退而改用 board 的
    expect(pickDir('~/r', cfg({ 'dispatch-board': '~/b' })).ok).toBe(false)
  })

  test('degradeFailedLine：分別交代結果檔與最終回覆，不暗示有人接手', async () => {
    const resend = degradeFailedLine('x', 'y', { result: 'resend', finalReply: false })
    expect(resend).toContain('下次 turn 結束時重送')
    expect(resend).not.toContain('完成條件')
    expect(degradeFailedLine('x', 'y', { result: 'resend', finalReply: true })).toContain('本則最終回覆不會重送')
    expect(degradeFailedLine('x', 'y', { result: 'lost', finalReply: false })).toContain('無法回滾')
  })

  test('submitFailure／trySubmit：drop 與例外都是失敗', async () => {
    expect(submitFailure({ text: 'ok' })).toBeNull()
    expect(submitFailure({ drop: 'blocked' })).toContain('blocked')
    expect(submitFailure({ drop: undefined })).not.toBeNull()
    expect(await trySubmit(async () => ({ text: 'ok' }))).toBeNull()
    expect(await trySubmit(async () => { throw new Error('nope') })).toContain('nope')
  })

  test('sendCheckVerdict：只放行本 mod 且收件者不是別的 session', async () => {
    const SOCK = { to: 'uds:/tmp/cc-socks/1.sock' }
    expect(sendCheckVerdict(true, 'dispatch-relay', SOCK, STATION_ID)).toEqual({ verdict: 'allow', lax: true })
    expect(sendCheckVerdict(true, 'dispatch-relay', { to: STATION_ID }, STATION_ID)).toEqual({ verdict: 'allow', lax: false })
    expect(sendCheckVerdict(true, 'dispatch-relay', { to: OTHER_ID }, STATION_ID).verdict).toBe('pass')
    expect(sendCheckVerdict(true, 'dispatch-board', SOCK, STATION_ID).verdict).toBe('pass')
    expect(sendCheckVerdict(false, 'dispatch-relay', SOCK, STATION_ID).verdict).toBe('pass')
    expect(classifyRecipient(undefined, STATION_ID)).toBe('unverifiable')
  })
})

// ── 引擎行為 ────────────────────────────────────────────────────────────────

type SendReply = { isDelivered: true } | { isDelivered: false; reason: string } | 'throw'
type SubmitReply = 'ok' | { drop: string }

type World = {
  dirs: Set<string>
  files: Map<string, string>
  links: Map<string, string>
  userSettings: Record<string, unknown>
  projectSettings: Record<string, unknown>
  roster: object[] | 'fail'
  rosterCalls: number
  sessionId: string
  sends: { to: string; text: string }[]
  sendReplies: SendReply[]
  sendCalls: number
  prompts: string[]
  submitReplies: SubmitReply[]
  logs: string[]
  /** `ui.log` 以 `{ to: 'debug' }` 送出的行（不進 `logs`） */
  debugLogs: string[]
  store: Map<string, unknown>
  storeAtPrompt: Record<string, unknown>[]
  /** 各工具 tool.call 的 result；未列者回 `{ ok: true }` */
  toolResults: Record<string, unknown>
  /** 這些工具的 tool.call 結果帶 `isError: true`（錯誤在結果上，不在 result 內） */
  toolErrors: Set<string>
}

function parentOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

function world(
  on: any,
  opts: {
    files?: Record<string, string>
    send?: SendReply[]
    submit?: SubmitReply[]
    roster?: object[] | 'fail'
    store?: Record<string, unknown>
    /** store 寫入（set／delete）只有前 N 次成功，之後一律拒絕；未設＝永遠成功 */
    storeWritesOk?: number
  } = {},
): World {
  let storeWrites = 0
  const storeWriteDenied = () => {
    storeWrites += 1
    return opts.storeWritesOk !== undefined && storeWrites > opts.storeWritesOk
  }
  const w: World = {
    dirs: new Set([HOME, `${HOME}/.claude`, DIR, `${HOME}/code`, ROOT]),
    files: new Map(Object.entries(opts.files ?? { [`${DIR}/shop.json`]: mission({ nodes: NODES }) })),
    links: new Map(),
    userSettings: {},
    projectSettings: {},
    roster: opts.roster ?? ROSTER,
    rosterCalls: 0,
    sessionId: SELF_ID,
    sends: [],
    sendReplies: opts.send ?? [{ isDelivered: true }],
    sendCalls: 0,
    prompts: [],
    submitReplies: opts.submit ?? ['ok'],
    logs: [],
    debugLogs: [],
    store: new Map(Object.entries(opts.store ?? {})),
    storeAtPrompt: [],
    toolResults: {},
    toolErrors: new Set(),
  }
  const value = (v: unknown) => ({ value: v })
  const real = (p: string) => {
    for (const [from, to] of w.links) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
    return p
  }
  on('env.get', (_$: any, e: any) => value(e.name === 'HOME' ? HOME : undefined))
  on('settings.read', (_$: any, e: any) => value(e?.source === 'user' ? w.userSettings : w.projectSettings))
  on('session.root', () => value(ROOT))
  on('session.cwd', () => value(ROOT))
  on('session.id', () => value(w.sessionId))
  on('fs.stat', (_$: any, e: any) => {
    const r = real(e.path)
    const extra = e.resolve ? { realPath: r } : {}
    if (w.dirs.has(r)) return value({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...extra })
    const t = w.files.get(r)
    if (t !== undefined) return value({ kind: 'file', size: t.length, mtimeMs: 0, isLink: false, ...extra })
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', (_$: any, e: any) => value(w.dirs.has(e.path) || w.files.has(e.path)))
  on('fs.list', (_$: any, e: any) => {
    const out: any[] = []
    for (const [f, t] of w.files) if (parentOf(f) === e.path) out.push({ name: f.slice(e.path.length + 1), kind: 'file', size: t.length, mtimeMs: 0, isLink: false })
    return value(out)
  })
  on('fs.read', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : value(t)
  })
  on('process.run', (_$: any, e: any) => {
    const argv: readonly string[] = e.argv
    const ok = (exitCode: number, stdout = '', stderr = '') => value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
    if (argv[0] === 'claude' && argv[1] === 'agents') {
      w.rosterCalls += 1
      return w.roster === 'fail' ? ok(1, '', 'error: unknown command') : ok(0, JSON.stringify(w.roster))
    }
    return ok(1)
  })
  on('ui.log', (_$: any, e: any) => {
    if (e.to === 'debug') w.debugLogs.push(String(e.text))
    else w.logs.push(String(e.text))
    return value(undefined)
  })
  on('session.send', (_$: any, e: any) => {
    w.sends.push({ to: String(e.to), text: String(e.text) })
    const r = w.sendReplies[Math.min(w.sendCalls, w.sendReplies.length - 1)]
    w.sendCalls += 1
    if (r === 'throw') throw new Error('socket closed')
    return r
  })
  on('store.get', (_$: any, e: any) => value(w.store.get(e.key)))
  on('store.set', (_$: any, e: any) => {
    if (storeWriteDenied()) return { deny: 'store write failed' }
    w.store.set(e.key, e.value)
    return value(undefined)
  })
  on('store.delete', (_$: any, e: any) => {
    if (storeWriteDenied()) return { deny: 'store write failed' }
    w.store.delete(e.key)
    return value(undefined)
  })
  on('session.end', (_$: any, e: any) => ({ sessionId: String(e.sessionId) }))
  on('prompt.submit', (_$: any, e: any) => {
    if (e.origin?.kind === 'plugin') {
      w.prompts.push(String(e.text))
      w.storeAtPrompt.push(Object.fromEntries(w.store))
      const r = w.submitReplies[Math.min(w.prompts.length - 1, w.submitReplies.length - 1)]
      if (r !== 'ok') return { drop: r.drop }
    }
    return { text: String(e.text) }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: String(e.answer) }))
  on('tool.call', (_$: any, e: any) => ({
    result: w.toolResults[String(e.tool)] ?? { ok: true },
    ...(w.toolErrors.has(String(e.tool)) ? { isError: true } : {}),
  }))
  on('tool.check', () => ({ decision: 'ask' }))
  return w
}

async function start($: any, on: any): Promise<void> {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
}

let turnN = 0
async function runTurn(
  $: any,
  answer: string,
  opts: { reason?: string; agentId?: string; selfSend?: boolean; calls?: Record<string, unknown>[] } = {},
): Promise<string> {
  turnN += 1
  const turnId = `t${turnN}`
  await $.turn.start({ text: 'go', turnId })
  if (opts.selfSend) {
    await $.tool.call({ tool: 'SendMessage', input: { to: 'shop-lead', message: 'x' }, tool_use_id: `u${turnN}` } as any)
  }
  for (const [i, call] of (opts.calls ?? []).entries()) await $.tool.call({ ...call, tool_use_id: `c${turnN}-${i}` } as any)
  const r: any = await $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: opts.reason === 'aborted',
    turnId,
    reason: (opts.reason ?? 'answer') as any,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  } as any)
  return String(r?.text ?? '')
}

const submit = ($: any, text = 'kickoff') => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } } as any)
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any
const composeIds = async ($: any): Promise<string[]> => ((await $.prompt.compose(COMPOSE)) as any).sections.map((s: any) => s.id)

/** 未啟用＝零行為：不注入、不放行、turn 結束不送件。 */
async function expectInert($: any, w: World): Promise<void> {
  expect(await composeIds($)).toEqual([])
  const check: any = await $.tool.check({ tool: 'SendMessage', input: { to: 'x' }, tool_use_id: 'u0' } as any)
  expect(check.decision).toBe('ask')
  expect(await runTurn($, '做完了')).toBe('做完了')
  expect(w.sends).toEqual([])
  expect(w.prompts).toEqual([])
}

describe('啟用判定', () => {
  test('唯一匹配且 mission 有 station → 啟用、注入段、日誌', async ($: any, on: any) => {
    const w = world(on)
    await start($, on)
    expect(await composeIds($)).toEqual(['dispatch-relay:relay'])
    expect(w.logs.some(l => l.includes('已啟用') && l.includes('shop-lead'))).toBe(true)
  })

  test('mission 目錄不存在：零行為，也不讀名冊', async ($: any, on: any) => {
    const w = world(on, { files: {} })
    w.dirs.delete(DIR)
    await start($, on)
    await submit($)
    await expectInert($, w)
    expect(w.rosterCalls).toBe(0)
  })

  test('沒有任何 mission 寫 station（只用 dispatch-board）：零行為，也不讀名冊', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: JSON.stringify({ mission_id: 'shop', nodes: NODES }) } })
    await start($, on)
    await submit($)
    await expectInert($, w)
    expect(w.rosterCalls).toBe(0)
  })

  const inactive: [string, (w: World) => void, string][] = [
    ['多重匹配', w => w.files.set(`${DIR}/blog.json`, JSON.stringify({ mission_id: 'blog', station: 'x', nodes: [{ id: 'b', session: 'SHOP-API' }] })), 'blog/b'],
    ['本節點的 mission 沒有 station', w => {
      w.files.set(`${DIR}/shop.json`, JSON.stringify({ mission_id: 'shop', nodes: NODES }))
      w.files.set(`${DIR}/other.json`, JSON.stringify({ mission_id: 'other', station: 'x', nodes: [{ id: 'o', session: 'zzz' }] }))
    }, '沒有 station'],
    ['名冊上沒有本 session', w => (w.sessionId = 'dddddddd-0000-4000-8000-000000000009'), '找不到本 session'],
    ['名冊不可用', w => (w.roster = 'fail'), '名冊不可用'],
    ['station 就是自己', w => w.files.set(`${DIR}/shop.json`, mission({ station: 'shop-api', nodes: NODES })), '不轉送給自己'],
  ]
  for (const [label, setup, expected] of inactive) {
    test(`不啟用且零行為：${label}`, async ($: any, on: any) => {
      const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: '回報' } })
      setup(w)
      await start($, on)
      await submit($)
      await expectInert($, w)
      expect(w.logs.some(l => l.includes('未啟用') && l.includes(expected))).toBe(true)
    })
  }

  test('安全：mission 目錄在 git 工作樹內就拒讀，不讀名冊', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: '回報' } })
    w.dirs.add(`${HOME}/.claude/.git`)
    await start($, on)
    await expectInert($, w)
    expect(w.rosterCalls).toBe(0)
    expect(w.logs.some(l => l.includes('git 工作樹'))).toBe(true)
  })

  test('安全：自訂 missions_dir 不是使用者層級設定給的就拒讀', { options: { missions_dir: '~/elsewhere' } }, async ($: any, on: any) => {
    const w = world(on, { files: { [`${HOME}/elsewhere/shop.json`]: mission({ nodes: NODES }), [RESULT]: '回報' } })
    w.dirs.add(`${HOME}/elsewhere`)
    await start($, on)
    await expectInert($, w)
    expect(w.logs.some(l => l.includes('使用者層級設定'))).toBe(true)
  })

  test('自訂 missions_dir 來自使用者層級設定 → 可用', { options: { missions_dir: '~/elsewhere' } }, async ($: any, on: any) => {
    const w = world(on, { files: { [`${HOME}/elsewhere/shop.json`]: mission({ nodes: NODES }) } })
    w.dirs.add(`${HOME}/elsewhere`)
    w.userSettings = { pluginConfigs: { 'dispatch-relay@learning-hacker-claude-mod': { options: { missions_dir: '~/elsewhere' } } } }
    await start($, on)
    expect(await composeIds($)).toEqual(['dispatch-relay:relay'])
  })

  test('啟動時還沒有 mission 檔：下一個 prompt 重試後啟用', async ($: any, on: any) => {
    const w = world(on, { files: {} })
    await start($, on)
    expect(await composeIds($)).toEqual([])
    w.files.set(`${DIR}/shop.json`, mission({ nodes: NODES }))
    await submit($)
    expect(await composeIds($)).toEqual(['dispatch-relay:relay'])
  })

  test('成功後不再每個 prompt 重查名冊', async ($: any, on: any) => {
    const w = world(on)
    await start($, on)
    const n = w.rosterCalls
    await submit($, 'one')
    await submit($, 'two')
    expect(w.rosterCalls).toBe(n)
  })
})

describe('mission 目錄沿用 dispatch-board 的設定', () => {
  const at = (dir: string) => ({ [`${HOME}/${dir}/shop.json`]: mission({ nodes: NODES }) })
  const cfg = (o: Record<string, string>) => ({ pluginConfigs: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { options: { missions_dir: v } }])) })

  test('只有 dispatch-board 鍵：讀 board 的目錄', async ($: any, on: any) => {
    const w = world(on, { files: at('boarddir') })
    w.dirs.add(`${HOME}/boarddir`)
    w.userSettings = cfg({ 'dispatch-board@learning-hacker-claude-mod': '~/boarddir' })
    await start($, on)
    expect(await composeIds($)).toEqual(['dispatch-relay:relay'])
  })

  test('兩鍵並存且不同：以 dispatch-relay 自己的為準', { options: { missions_dir: '~/relaydir' } }, async ($: any, on: any) => {
    const w = world(on, { files: { ...at('relaydir'), [`${HOME}/boarddir/blog.json`]: JSON.stringify({ mission_id: 'blog', station: 'x', nodes: [{ id: 'b', session: 'shop-api' }] }) } })
    w.dirs.add(`${HOME}/relaydir`)
    w.dirs.add(`${HOME}/boarddir`)
    w.userSettings = cfg({ 'dispatch-relay@learning-hacker-claude-mod': '~/relaydir', 'dispatch-board@learning-hacker-claude-mod': '~/boarddir' })
    await start($, on)
    expect(await composeIds($)).toEqual(['dispatch-relay:relay'])
    expect(w.logs.some(l => l.includes('已啟用：mission shop'))).toBe(true)
  })

  test('安全：dispatch-board 鍵只寫在專案設定 → 不採用，仍讀預設目錄', async ($: any, on: any) => {
    const w = world(on, { files: at('boarddir') })
    w.dirs.add(`${HOME}/boarddir`)
    w.projectSettings = cfg({ 'dispatch-board': '~/boarddir' })
    await start($, on)
    await submit($)
    await expectInert($, w)
    expect(w.rosterCalls).toBe(0)
  })
})

describe('turn.complete 轉送', () => {
  test('首次寫入：送給名冊解析出的指揮站 session id，畫面一行，store 記為已處理', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: '# 回報\n' } })
    await start($, on)
    await submit($)
    const text = await runTurn($, '結果檔已更新')
    expect(w.sends.length).toBe(1)
    expect(w.sends[0]!.to).toContain(STATION_ID)
    expect(w.sends[0]!.text.split('\n')[0]).toMatch(/^\[dispatch-relay\] mission=shop node=api parts=result-full,final-reply chars=\d+$/)
    expect(text).toContain('已送達指揮站 shop-lead')
    expect(w.store.get(KEY)).toBe('# 回報\n')
  })

  test('追加只送追加段；未變只附最終回覆；自送時只送結果檔變更', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' } })
    await start($, on)
    await runTurn($, '一')
    w.files.set(RESULT, 'A\nB\n')
    await runTurn($, '二')
    expect(w.sends[1]!.text).toContain('parts=result-append,final-reply')
    expect(w.sends[1]!.text).toContain('--- result-append ---\nB\n')
    await runTurn($, '三')
    expect(w.sends[2]!.text).toContain('parts=final-reply')
    await runTurn($, '收尾', { selfSend: true })
    expect(w.sends.length).toBe(3)
  })

  test('非答覆結束、subagent 的 turn 不送；下一次成功 turn 補送', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' } })
    await start($, on)
    await runTurn($, '中斷', { reason: 'aborted' })
    await runTurn($, 'sub', { agentId: 'ag1' })
    expect(w.sends.length).toBe(0)
    await runTurn($, '好了')
    expect(w.sends[0]!.text).toContain('parts=result-full,final-reply')
  })

  test('自訂 result_file：讀節點指定的檔', async ($: any, on: any) => {
    const nodes = [{ id: 'api', session: 'shop-api', result_file: 'reports/api.md' }]
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes }), [`${ROOT}/reports/api.md`]: '報告', [RESULT]: '別的' } })
    w.dirs.add(`${ROOT}/reports`)
    await start($, on)
    await runTurn($, '')
    expect(w.sends[0]!.text).toContain('--- result-full ---\n報告')
    expect(w.sends[0]!.text).not.toContain('別的')
  })

  test('安全：結果檔經符號連結指到 session 根目錄外，不讀也不送', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [`${HOME}/secret.txt`]: '機密' } })
    w.links.set(RESULT, `${HOME}/secret.txt`)
    await start($, on)
    await runTurn($, '')
    expect(w.sends).toEqual([])
    expect(w.logs.some(l => l.includes('不在 session 根目錄底下'))).toBe(true)
  })

  test('指揮站重開換了 session id：下一次送件跟著新 id', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }) } })
    await start($, on)
    await runTurn($, '一')
    w.roster = [{ name: 'shop-api', sessionId: SELF_ID }, { name: 'shop-lead', sessionId: STATION_ID_2 }]
    await runTurn($, '二')
    expect(w.sends[0]!.to).toContain(STATION_ID)
    expect(w.sends[1]!.to).toContain(STATION_ID_2)
  })

  test('啟用後 mission 拿掉 station：停用訊息說「找到節點但沒有 station」，不是「沒有指派」', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }) } })
    await start($, on)
    w.files.set(`${DIR}/shop.json`, JSON.stringify({ mission_id: 'shop', nodes: NODES }))
    await runTurn($, '還有一句')
    expect(w.sends).toEqual([])
    const line = w.logs.find(l => l.includes('停用')) ?? ''
    expect(line).toContain('找到指派給本 session 的節點 shop/api')
    expect(line).toContain('沒有 station')
    expect(line).not.toContain('沒有指派給本 session')
  })

  test('mission 檔搬走（收斂）後停用：不送、不再注入', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }) } })
    await start($, on)
    w.files.delete(`${DIR}/shop.json`)
    await runTurn($, '還有一句')
    expect(w.sends).toEqual([])
    expect(await composeIds($)).toEqual([])
    expect(w.logs.some(l => l.includes('停用'))).toBe(true)
  })
})

describe('降級', () => {
  test('名冊上找不到指揮站：不猜，先記已處理再請 worker 自送', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' } })
    await start($, on)
    w.roster = [{ name: 'shop-api', sessionId: SELF_ID }]
    const text = await runTurn($, '做完了')
    expect(w.sends).toEqual([])
    expect(text).toContain('轉送失敗')
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0]).toContain('名冊上沒有名為 shop-lead')
    expect(w.prompts[0]).toContain('SendMessage')
    expect(w.storeAtPrompt[0]![KEY]).toBe('A\n')
    await runTurn($, '已自送', { selfSend: true })
    expect(w.sends).toEqual([])
    expect(w.prompts.length).toBe(1)
  })

  test('指揮站同名多筆：不猜，降級', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' } })
    await start($, on)
    w.roster = [...ROSTER, { name: 'shop-lead', sessionId: STATION_ID_2 }]
    await runTurn($, '做完了')
    expect(w.sends).toEqual([])
    expect(w.prompts[0]).toContain('不猜')
  })

  test('降級 turn 內再度失敗不形成迴圈；上次成功位址只在同一個指揮站 id 時引用', async ($: any, on: any) => {
    const fail = { isDelivered: false as const, reason: 'gone' }
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' }, send: [{ isDelivered: true }, fail, fail] })
    await start($, on)
    await runTurn($, '一')
    const modTo = w.sends[0]!.to
    w.files.set(RESULT, 'A\nB\n')
    await runTurn($, '二')
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0]).toContain(`改用上次成功送達指揮站時使用的位址 ${modTo}`)
    const text = await runTurn($, '我只回覆文字')
    expect(w.prompts.length).toBe(1)
    expect(text).toContain('再度失敗')
  })

  test('名冊查無指揮站型的送件失敗：畫面與日誌附辨識說明，降級規則不變', async ($: any, on: any) => {
    const reason = 'no live session on this machine has id 7f3a'
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' }, send: [{ isDelivered: false, reason }] })
    await start($, on)
    const text = await runTurn($, '做完了')
    expect(text).toContain('缺 pid')
    expect(w.logs.some(l => l.includes('缺 pid'))).toBe(true)
    expect(w.prompts.length).toBe(1) // 仍照原規則請 worker 自送一次
    expect(w.store.get(KEY)).toBe('A\n')
  })

  test('送件拋例外同樣降級', async ($: any, on: any) => {
    const w = world(on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' }, send: ['throw'] })
    await start($, on)
    await runTurn($, '做完了')
    expect(w.prompts.length).toBe(1)
    expect(w.store.get(KEY)).toBe('A\n')
  })

  test('降級 prompt 被擋下（drop）：回滾為未處理，下一個答覆 turn 重送全文', async ($: any, on: any) => {
    const fail = { isDelivered: false as const, reason: 'gone' }
    const w = world(on, {
      files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' },
      send: [fail, { isDelivered: true }],
      submit: [{ drop: 'blocked' }],
    })
    await start($, on)
    const text = await runTurn($, '')
    expect(text).toContain('下次 turn 結束時重送')
    expect(w.store.has(KEY)).toBe(false)
    await runTurn($, '')
    expect(w.sends[1]!.text).toContain('parts=result-full')
    expect(w.store.get(KEY)).toBe('A\n')
  })
})

describe('tool.check', () => {
  test('其他來源的 SendMessage 不被放行；worker 自己的 tool.call 原樣通過', async ($: any, on: any) => {
    world(on)
    await start($, on)
    const r: any = await $.tool.check({ tool: 'SendMessage', input: { to: STATION_ID, message: 'x' }, tool_use_id: 'u1' } as any)
    expect(r.decision).toBe('ask')
    const c: any = await $.tool.call({ tool: 'SendMessage', input: { to: 'shop-lead', message: '問題' }, tool_use_id: 'u2' } as any)
    expect(c.result).toEqual({ ok: true })
  })
})

// ── 暫存的等待中回覆與時限叫醒 ──────────────────────────────────────────────

describe('logic：暫存與背景工作帳', () => {
  test('buildMessage：held-reply 排在結果檔之後、最終回覆之前，自送時仍帶出', async () => {
    const all = buildMessage(IDS, undefined, '回報', '好了', false, '先前等待中')
    expect(all.parts).toEqual(['result-full', 'held-reply', 'final-reply'])
    expect(all.chars).toBe('回報'.length + '先前等待中'.length + '好了'.length)
    expect(all.text).toContain('--- held-reply ---\n先前等待中')
    const self = buildMessage(IDS, 'x', 'x', '收尾', true, '先前等待中')
    expect(self.parts).toEqual(['held-reply'])
    expect(self.nextSent).toBeNull()
    expect(buildMessage(IDS, 'x', 'x', '', false, '  ').parts).toEqual([])
  })

  test('resultChanged：缺席、空白、相同都不算變更', async () => {
    expect(resultChanged(undefined, null)).toBe(false)
    expect(resultChanged('a', 'a')).toBe(false)
    expect(resultChanged(undefined, ' \n')).toBe(false)
    expect(resultChanged(undefined, 'a')).toBe(true)
    expect(resultChanged('a', 'ab')).toBe(true)
  })

  test('shouldHold：帳上有工作、非叫醒、未自送、結果檔未變、回覆非空才暫存', async () => {
    const base = { answer: '等待中', resultChanged: false, selfSent: false, pending: 1, mustFlush: false }
    expect(shouldHold(base)).toBe(true)
    expect(shouldHold({ ...base, pending: 0 })).toBe(false)
    expect(shouldHold({ ...base, mustFlush: true })).toBe(false)
    expect(shouldHold({ ...base, selfSent: true })).toBe(false)
    expect(shouldHold({ ...base, resultChanged: true })).toBe(false)
    expect(shouldHold({ ...base, answer: ' ' })).toBe(false)
  })

  test('mergeHeld／parseHeld：連續暫存以空行串接，起算時間沿用第一則；壞資料視為沒有暫存', async () => {
    const a = mergeHeld(null, ' 一 ', 100)
    expect(a).toEqual({ text: '一', since: 100 })
    expect(mergeHeld(a, '二', 900)).toEqual({ text: '一\n\n二', since: 100 })
    expect(parseHeld(a)).toEqual(a)
    for (const bad of [null, 'x', {}, { text: '', since: 1 }, { text: 'a', since: '1' }]) expect(parseHeld(bad)).toBeNull()
  })

  test('bgEntryOf：Bash／Monitor／背景 Agent 取 id，排程取 prompt 原文；前景與隨回覆終止的不登', async () => {
    expect(bgEntryOf('Bash', {}, { backgroundTaskId: 'b1' })).toEqual({ id: 'b1' })
    expect(bgEntryOf('Bash', {}, { backgroundTaskId: 'b1', backgroundEndsWithFinalResponse: true })).toBeNull()
    expect(bgEntryOf('Bash', {}, { stdout: 'x' })).toBeNull()
    expect(bgEntryOf('Monitor', {}, { taskId: 'm1' })).toEqual({ id: 'm1' })
    expect(bgEntryOf('Agent', {}, { isAsync: true, agentId: 'a1' })).toEqual({ id: 'a1' })
    expect(bgEntryOf('Agent', {}, { agentId: 'a1' })).toBeNull()
    expect(bgEntryOf('ScheduleWakeup', { prompt: 'check' }, { scheduledFor: 1 })).toEqual({ text: 'check', sched: { wake: true } })
    expect(bgEntryOf('CronCreate', { input: { prompt: 'tick' } }, { id: 'c1' })).toEqual({ text: 'tick', sched: { cronId: 'c1' } })
    // stop: true 的結果也帶 scheduledFor（為 0），是銷帳不是登帳
    expect(bgEntryOf('ScheduleWakeup', { prompt: 'check' }, { scheduledFor: 0, stopped: true, cancelledWakeups: 1 })).toBeNull()
    expect(bgEntryOf('TaskStop', {}, { ok: true })).toBeNull()
    expect(bgEntryOf('Bash', {}, undefined)).toBeNull()
  })

  test('bgSettle：status 才銷；event 不銷；對不上 id 不銷；無 id 只銷同類最舊；peer 與排程各依規則', async () => {
    const ledger = [{ id: 'b1' }, { text: 'check' }, { id: 'b2' }]
    const done = (id: string) => `<task-id>${id}</task-id><status>completed</status>`
    expect(bgSettle(ledger, 'task-notification', done('b1'))).toEqual([{ text: 'check' }, { id: 'b2' }])
    expect(bgSettle(ledger, 'task-notification', '<task-id>b1</task-id><event>x</event>')).toEqual(ledger)
    expect(bgSettle(ledger, 'task-notification', done('zzz'))).toEqual(ledger)
    expect(bgSettle(ledger, 'task-notification', '完成了')).toEqual([{ text: 'check' }, { id: 'b2' }])
    expect(bgSettle(ledger, 'peer', '<agent-message from="b2">done</agent-message>')).toEqual([{ id: 'b1' }, { text: 'check' }])
    expect(bgSettle(ledger, 'peer', '<cross-session-message from="uds:/x">hi</cross-session-message>')).toEqual(ledger)
    expect(bgSettle(ledger, 'scheduled-trigger', 'check')).toEqual([{ id: 'b1' }, { id: 'b2' }])
    expect(bgSettle(ledger, 'scheduled-trigger', '別的')).toEqual([{ id: 'b1' }, { id: 'b2' }])
    expect(bgSettle(ledger, 'sdk', 'x')).toEqual(ledger)
  })

  test('stoppedTaskIdOf：只認成功的 TaskStop 且帶非空 task_id；錯誤、字串結果、缺 id、別的工具都不算', async () => {
    const ok = { message: 'Successfully stopped task: b1 (sleep 300)', task_id: 'b1', task_type: 'local_bash', command: 'sleep 300' }
    expect(stoppedTaskIdOf('TaskStop', ok, undefined)).toBe('b1')
    expect(stoppedTaskIdOf('TaskStop', ok, false)).toBe('b1')
    expect(stoppedTaskIdOf('TaskStop', ok, true)).toBeNull() // isError 在結果上
    expect(stoppedTaskIdOf('TaskStop', 'Error: No task found with ID: zzz', true)).toBeNull()
    expect(stoppedTaskIdOf('TaskStop', 'Error: No task found with ID: zzz', undefined)).toBeNull() // 字串結果沒有 task_id
    expect(stoppedTaskIdOf('TaskStop', { message: 'x' }, undefined)).toBeNull()
    expect(stoppedTaskIdOf('TaskStop', { task_id: '' }, undefined)).toBeNull()
    expect(stoppedTaskIdOf('TaskStop', { task_id: 7 }, undefined)).toBeNull()
    expect(stoppedTaskIdOf('TaskStop', undefined, undefined)).toBeNull()
    expect(stoppedTaskIdOf('Bash', ok, undefined)).toBeNull()
  })

  test('bgSettleStopped：只銷 id 相符的一筆；對不上不動帳（不以最舊猜測）；不就地修改', async () => {
    const ledger = [{ id: 'b1' }, { text: 'check' }, { id: 'b2' }]
    expect(bgSettleStopped(ledger, 'b2')).toEqual([{ id: 'b1' }, { text: 'check' }])
    expect(bgSettleStopped(ledger, 'b1')).toEqual([{ text: 'check' }, { id: 'b2' }])
    expect(bgSettleStopped(ledger, 'zzz')).toEqual(ledger)
    expect(bgSettleStopped([], 'b1')).toEqual([])
    expect(ledger.length).toBe(3)
  })

  test('deletedCronIdOf：只認成功的 CronDelete 且帶非空 id（取輸入，容忍 input 內層）；失敗、缺 id、別的工具都不算', async () => {
    expect(deletedCronIdOf('CronDelete', { id: 'c1' }, undefined)).toBe('c1')
    expect(deletedCronIdOf('CronDelete', { input: { id: 'c2' } }, false)).toBe('c2')
    expect(deletedCronIdOf('CronDelete', { id: 'c1' }, true)).toBeNull()
    expect(deletedCronIdOf('CronDelete', {}, undefined)).toBeNull()
    expect(deletedCronIdOf('CronDelete', { id: '' }, undefined)).toBeNull()
    expect(deletedCronIdOf('CronCreate', { id: 'c1' }, undefined)).toBeNull()
  })

  test('wakeStoppedOf：只認成功且 stopped 為真的 ScheduleWakeup', async () => {
    expect(wakeStoppedOf('ScheduleWakeup', { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }, undefined)).toBe(true)
    expect(wakeStoppedOf('ScheduleWakeup', { scheduledFor: 0, stopped: true }, true)).toBe(false)
    expect(wakeStoppedOf('ScheduleWakeup', { scheduledFor: 1234 }, undefined)).toBe(false)
    expect(wakeStoppedOf('ScheduleWakeup', 'Error: x', undefined)).toBe(false)
    expect(wakeStoppedOf('CronDelete', { stopped: true }, undefined)).toBe(false)
  })

  test('bgRegister：新的喚醒取代舊的喚醒；cron 排程與背景工作不受影響；不就地修改', async () => {
    const ledger = [{ id: 'b1' }, { text: 'old', sched: { wake: true as const } }, { text: 'tick', sched: { cronId: 'c1' } }]
    const next = bgRegister(ledger, { text: 'new', sched: { wake: true } })
    expect(next).toEqual([{ id: 'b1' }, { text: 'tick', sched: { cronId: 'c1' } }, { text: 'new', sched: { wake: true } }])
    expect(bgRegister(ledger, { id: 'b2' })).toEqual([...ledger, { id: 'b2' }])
    expect(bgRegister(ledger, { text: 't2', sched: { cronId: 'c2' } }).length).toBe(4)
    expect(ledger.length).toBe(3)
  })

  test('bgSettleCron／bgSettleWake：只銷 cronId 相符的一筆／全部喚醒類；對不上不動帳', async () => {
    const ledger = [{ id: 'b1' }, { text: 'w', sched: { wake: true as const } }, { text: 'a', sched: { cronId: 'c1' } }, { text: 'b', sched: { cronId: 'c2' } }]
    expect(bgSettleCron(ledger, 'c1')).toEqual([ledger[0], ledger[1], ledger[3]])
    expect(bgSettleCron(ledger, 'zzz')).toEqual(ledger)
    expect(bgSettleWake(ledger)).toEqual([ledger[0], ledger[2], ledger[3]])
    expect(ledger.length).toBe(4)
  })

  test('classifySendFailure／failureHint：名冊查無指揮站型附說明，其餘型不變', async () => {
    const roster = 'Error: no live session on this machine has id 7f3a'
    expect(classifySendFailure(roster)).toBe('roster-missing')
    expect(classifySendFailure('gone')).toBe('other')
    expect(failureHint('other')).toBe('')
    expect(failureHint('roster-missing')).toContain('缺 pid')
    expect(degradedLine(roster)).toContain('缺 pid')
    expect(degradedLine('gone')).not.toContain('缺 pid')
    expect(failedAgainLine(roster)).toContain('缺 pid')
    expect(degradeFailedLine(roster, 'blocked', { result: 'resend', finalReply: false })).toContain('缺 pid')
    expect(degradeFailedLine('gone', 'blocked', { result: 'resend', finalReply: false })).not.toContain('缺 pid')
  })

  test('degradeFailedLine／degradePrompt／injectionText 涵蓋 held-reply', async () => {
    expect(degradeFailedLine('x', 'y', { result: 'none', finalReply: false, heldReply: true })).toContain('暫存的等待中回覆不會重送')
    const built = buildMessage(IDS, undefined, null, '', true, '暫存')
    expect(degradePrompt(built, 'gone', 'r.md', { station: 'shop-lead' })).toContain('先前暫存的等待中回覆')
    const t = injectionText({ missionId: 'shop', nodeId: 'api', station: 'shop-lead', resultFile: 'r.md' })
    expect(t).toContain('暫存')
    expect(t).toContain('自送不受延後')
  })
})

describe('暫存的等待中回覆與時限叫醒', () => {
  const HELD = `relay:held:${ROOT}`
  const BASH_BG = { tool: 'Bash', command: 'make test', run_in_background: true }
  const done = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`
  const notify = ($: any, text: string, kind = 'task-notification') => $.prompt.submit({ text, wait: false, origin: { kind } } as any)
  const FAIL = { isDelivered: false as const, reason: 'no live session' }
  const DROP: SubmitReply = { drop: 'blocked' }
  const head = (text: string) => text.split('\n')[0]!

  /** 啟用並在一個 turn 內起背景 Bash、以「等待中」結束 turn（暫存）。 */
  async function holdFirst($: any, on: any, opts: Parameters<typeof world>[1] = {}, answer = '等待全套測試結果中。') {
    const w = world(on, opts)
    const clock = mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    const text = await runTurn($, answer, { calls: [BASH_BG] })
    return { w, clock, text }
  }

  test('等待背景測試的 turn 不單獨送出：暫存、畫面載明、不改寫工具呼叫的結果', async ($: any, on: any) => {
    const { w, text } = await holdFirst($, on)
    expect(w.sends).toEqual([])
    expect(text).toContain('已暫存')
    expect(w.store.get(HELD)).toEqual({ text: '等待全套測試結果中。', since: 0 })
    const r: any = await $.tool.call({ ...BASH_BG, tool_use_id: 'x' } as any)
    expect(r.result).toEqual({ backgroundTaskId: 'bt1' })
  })

  test('背景工作完成後的 turn 帶上暫存的回覆：result-full,held-reply,final-reply，暫存清空', async ($: any, on: any) => {
    const { w } = await holdFirst($, on)
    await notify($, done('bt1'))
    w.files.set(RESULT, '# 回報\n全綠\n')
    await runTurn($, '測試通過')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=result-full,held-reply,final-reply chars=\d+$/)
    expect(w.sends[0]!.text).toContain('--- held-reply ---\n等待全套測試結果中。')
    expect(w.store.has(HELD)).toBe(false)
  })

  test('時限到時叫醒 worker：回呼內不送，叫醒 turn 的 turn.complete 送出 held-reply，且不附帶自己的「ok」', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await clock.advance(HOLD_LIMIT_MS - 1)
    expect(w.prompts).toEqual([])
    await clock.advance(1)
    expect(w.prompts).toEqual([WAKE_TEXT])
    expect(w.sends).toEqual([]) // 回呼內 SHALL NOT 直接送
    const text = await runTurn($, 'ok') // 叫醒 turn
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply chars=\d+$/)
    expect(w.sends[0]!.text).toContain('等待全套測試結果中。')
    expect(w.sends[0]!.text).not.toContain('--- final-reply ---')
    expect(text).toContain('已送達指揮站 shop-lead')
    expect(w.store.has(HELD)).toBe(false)
  })

  test('被叫醒的 turn 帳上仍有背景工作也無條件送出，不再暫存、不再叫醒', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await clock.advance(HOLD_LIMIT_MS)
    await runTurn($, '還在跑')
    expect(w.sends.length).toBe(1)
    expect(w.store.has(HELD)).toBe(false)
    await clock.advance(HOLD_LIMIT_MS * 3)
    expect(w.prompts.length).toBe(1)
    // 叫醒旗標已消費：之後帳上仍有工作的 turn 恢復一般暫存
    await runTurn($, '又在等')
    expect(w.sends.length).toBe(1)
    expect(w.store.has(HELD)).toBe(true)
  })

  test('連續等待不重設時限：兩則合併，第一則起算 10 分鐘內叫醒', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on, {}, '等待中一')
    await clock.advance(6 * 60 * 1000)
    await runTurn($, '等待中二')
    expect(w.sends).toEqual([])
    await clock.advance(4 * 60 * 1000 - 1)
    expect(w.prompts).toEqual([])
    await clock.advance(1)
    expect(w.prompts).toEqual([WAKE_TEXT])
    await runTurn($, 'ok')
    expect(w.sends.length).toBe(1)
    expect(w.sends[0]!.text).toContain('--- held-reply ---\n等待中一\n\n等待中二')
  })

  test('帳卡住只造成有上界的延後：完成通知始終未被辨識，每則仍在時限內送出', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on, {}, '進度一')
    await notify($, '背景工作完成') // 取不到 task id → 銷最舊一筆背景工作
    w.toolResults.Bash = { backgroundTaskId: 'bt2' }
    await runTurn($, '進度二', { calls: [BASH_BG] })
    await notify($, done('不是我的'))
    await runTurn($, '進度三')
    expect(w.sends).toEqual([])
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts.length).toBe(1)
    await runTurn($, 'ok')
    expect(w.sends.length).toBe(1)
    for (const s of ['進度一', '進度二', '進度三']) expect(w.sends[0]!.text).toContain(s)
  })

  test('結果檔有變更時不暫存：result-append 與 final-reply 本 turn 送出', async ($: any, on: any) => {
    const { w } = await holdFirst($, on, { files: { [`${DIR}/shop.json`]: mission({ nodes: NODES }), [RESULT]: 'A\n' } }, '等待中')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=result-full,final-reply /)
    expect(w.store.has(HELD)).toBe(false)
    w.files.set(RESULT, 'A\nB\n')
    await runTurn($, '又在等')
    expect(w.sends.length).toBe(2)
    expect(head(w.sends[1]!.text)).toMatch(/parts=result-append,final-reply /)
  })

  test('沒有背景工作時的單行提問立即送出', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    await start($, on)
    await submit($)
    await runTurn($, '要不要 push？')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=final-reply /)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('worker 自送的 turn 仍帶出暫存的回覆，且不附帶該 turn 的最終回覆', async ($: any, on: any) => {
    const { w } = await holdFirst($, on)
    await runTurn($, '收尾說明', { selfSend: true })
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply /)
    expect(w.sends[0]!.text).not.toContain('收尾說明')
  })

  test('時限到時 worker 正在 turn 中：不叫醒，該 turn 結束時無條件送出（即使帳上仍有背景工作）', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await $.turn.start({ text: 'go', turnId: 'long' })
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts).toEqual([])
    await $.turn.complete({ answer: '還在等', durationMs: 1, isAborted: false, turnId: 'long', reason: 'answer' } as any)
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
    // 重確認的計時器已隨送出取消
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts).toEqual([])
  })

  test('時限到時 worker 在 turn 中、該 turn 未以答覆結束：60 秒重確認，閒置了才叫醒', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await $.turn.start({ text: 'go', turnId: 'long' })
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts).toEqual([])
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'long', reason: 'aborted' } as any)
    expect(w.sends).toEqual([])
    await clock.advance(60 * 1000 - 1)
    expect(w.prompts).toEqual([])
    await clock.advance(1)
    expect(w.prompts).toEqual([WAKE_TEXT])
    await runTurn($, 'ok')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply /)
  })

  test('inTurn 被誤設（turn.start 之後沒有主迴圈 turn.complete）：重確認有次數上限，到上限直接叫醒', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await $.turn.start({ text: 'go', turnId: 'stuck' })
    await clock.advance(HOLD_LIMIT_MS + 5 * 60 * 1000 - 1)
    expect(w.prompts).toEqual([])
    await clock.advance(1)
    expect(w.prompts).toEqual([WAKE_TEXT])
    await clock.advance(HOLD_LIMIT_MS * 3)
    expect(w.prompts.length).toBe(1)
  })

  test('叫醒的 prompt 被擋下：記日誌、不重新叫醒；暫存留到下一個答覆 turn 無條件送出', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on, { submit: [DROP] })
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts.length).toBe(1)
    expect(w.logs.some(l => l.includes('叫醒 prompt 排入失敗') && l.includes('blocked'))).toBe(true)
    await clock.advance(HOLD_LIMIT_MS * 3)
    expect(w.prompts.length).toBe(1)
    await runTurn($, '終於回來了')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
  })

  test('叫醒 turn 沒有以答覆結束：不再叫醒，下一個答覆 turn 送出暫存', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    await clock.advance(HOLD_LIMIT_MS)
    expect(w.prompts.length).toBe(1)
    await runTurn($, '', { reason: 'error' })
    expect(w.sends).toEqual([])
    await clock.advance(HOLD_LIMIT_MS * 3)
    expect(w.prompts.length).toBe(1)
    await runTurn($, '好了')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
  })

  test('熱重載不丟暫存：store 有暫存、模組狀態全新，依原起算時間排計時器', async ($: any, on: any) => {
    const w = world(on, { store: { [HELD]: { text: '重載前暫存的回覆', since: 0 } } })
    const clock = mock.clock(on, { now: 4 * 60 * 1000 })
    await start($, on)
    await clock.advance(6 * 60 * 1000 - 1)
    expect(w.prompts).toEqual([])
    await clock.advance(1)
    expect(w.prompts).toEqual([WAKE_TEXT])
    await runTurn($, 'ok')
    expect(w.sends.length).toBe(1)
    expect(w.sends[0]!.text).toContain('重載前暫存的回覆')
  })

  test('session.end 送出暫存的回覆（沿用啟用時解析到的指揮站 id，不再讀名冊）', async ($: any, on: any) => {
    const { w } = await holdFirst($, on)
    const before = w.rosterCalls
    await $.session.end({ reason: 'other', sessionId: SELF_ID, resume: {} } as any)
    expect(w.sends.length).toBe(1)
    expect(w.sends[0]!.to).toContain(STATION_ID)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply /)
    expect(w.rosterCalls).toBe(before)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('暫存回覆送件失敗且降級排入失敗：不重送，畫面載明，暫存已清空', async ($: any, on: any) => {
    const { w } = await holdFirst($, on, { send: [FAIL], submit: [DROP] })
    const text = await runTurn($, '收尾', { selfSend: true })
    expect(text).toContain('暫存的等待中回覆不會重送')
    expect(text).toContain('完成條件')
    expect(w.store.has(HELD)).toBe(false)
    expect(w.sends.length).toBe(1)
    await runTurn($, '再一個 turn', { selfSend: true })
    expect(w.sends.length).toBe(1)
  })

  test('暫存回覆送件失敗、降級排入成功：降級 prompt 帶上先前暫存的回覆', async ($: any, on: any) => {
    const { w } = await holdFirst($, on, { send: [FAIL] })
    await runTurn($, '收尾', { selfSend: true })
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0]).toContain('先前暫存的等待中回覆')
  })

  test('暫存寫不進 store：改為立即送出，不延後', async ($: any, on: any) => {
    const w = world(on, { storeWritesOk: 0 })
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '等待中', { calls: [BASH_BG] })
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=final-reply /)
    expect(w.logs.some(l => l.includes('無法暫存'))).toBe(true)
  })

  test('Monitor：只帶 event 的通知不銷帳，帶 status 才銷', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Monitor = { taskId: 'mon1' }
    await start($, on)
    await submit($)
    await runTurn($, '監看中', { calls: [{ tool: 'Monitor', command: 'tail -f x' }] })
    await notify($, '<task-notification>\n<task-id>mon1</task-id>\n<event>MON1</event>\n</task-notification>')
    await runTurn($, '收到事件，繼續等')
    expect(w.sends).toEqual([])
    expect(String((w.store.get(HELD) as any).text)).toBe('監看中\n\n收到事件，繼續等')
    await notify($, done('mon1'))
    await runTurn($, '監看結束')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
  })

  test('背景 Agent 的完成是 peer 訊息：銷帳；指揮站的一般來信不動帳', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Agent = { isAsync: true, agentId: 'a167', status: 'async_launched' }
    await start($, on)
    await submit($)
    await runTurn($, '子代理跑中', { calls: [{ tool: 'Agent', prompt: '去查', run_in_background: true }] })
    await notify($, '<cross-session-message from="uds:/tmp/cc-socks/1.sock">請回報進度</cross-session-message>', 'peer')
    await runTurn($, '仍在等子代理')
    expect(w.sends).toEqual([])
    await notify($, '<agent-message from="a167">[Subagent hand-back] done</agent-message>', 'peer')
    await runTurn($, '子代理回來了')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
  })

  test('ScheduleWakeup：以排程時的 prompt 原文對回 scheduled-trigger', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.ScheduleWakeup = { scheduledFor: 1234, clampedDelaySeconds: 60, wasClamped: false }
    await start($, on)
    await submit($)
    await runTurn($, '等排程', { calls: [{ tool: 'ScheduleWakeup', delaySeconds: 60, prompt: 'check-ci', reason: 'poll' }] })
    expect(w.sends).toEqual([])
    await notify($, 'check-ci', 'scheduled-trigger')
    await runTurn($, 'CI 綠了')
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
  })

  const CRON_CREATE = { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'tick' }

  test('CronDelete 成功：銷掉 CronCreate 登的那一筆，其後的進度回覆在本 turn 送出', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.CronCreate = { id: 'cr1' }
    await start($, on)
    await submit($)
    await runTurn($, '排好定時', { calls: [CRON_CREATE] })
    expect(w.store.has(HELD)).toBe(true)
    w.toolResults.CronDelete = { id: 'cr1' }
    await runTurn($, '已刪掉排程', { calls: [{ tool: 'CronDelete', id: 'cr1' }] })
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('CronDelete 失敗或 id 對不上：不動帳，等待中的 turn 照現行規則暫存', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.CronCreate = { id: 'cr1' }
    await start($, on)
    await submit($)
    await runTurn($, '排好定時', { calls: [CRON_CREATE] })
    w.toolResults.CronDelete = "Error: No scheduled job with id 'zzz'"
    w.toolErrors.add('CronDelete')
    await runTurn($, '刪不存在的', { calls: [{ tool: 'CronDelete', id: 'zzz' }] })
    expect(w.sends).toEqual([])
    w.toolErrors.delete('CronDelete')
    w.toolResults.CronDelete = { id: 'other' }
    await runTurn($, '刪別的', { calls: [{ tool: 'CronDelete', id: 'other' }] })
    expect(w.sends).toEqual([])
    expect(w.store.has(HELD)).toBe(true)
  })

  test('ScheduleWakeup stop：不登帳，且銷掉先前的喚醒', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.ScheduleWakeup = { scheduledFor: 1234, clampedDelaySeconds: 60, wasClamped: false }
    await start($, on)
    await submit($)
    await runTurn($, '等排程', { calls: [{ tool: 'ScheduleWakeup', delaySeconds: 60, prompt: 'check-ci', reason: 'poll' }] })
    expect(w.store.has(HELD)).toBe(true)
    w.toolResults.ScheduleWakeup = { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }
    await runTurn($, '停掉排程', { calls: [{ tool: 'ScheduleWakeup', stop: true }] })
    expect(w.sends.length).toBe(1)
    expect(w.store.has(HELD)).toBe(false)
    // 帳已空：stop 本身沒有被登成新的待觸發喚醒
    await runTurn($, '收尾')
    expect(w.sends.length).toBe(2)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('ScheduleWakeup stop 在帳上本來沒有喚醒時：不登帳（不誤暫存）', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.ScheduleWakeup = { scheduledFor: 0, stopped: true, cancelledWakeups: 0 }
    await start($, on)
    await submit($)
    await runTurn($, '停止排程', { calls: [{ tool: 'ScheduleWakeup', stop: true }] })
    expect(w.sends.length).toBe(1)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('新的 ScheduleWakeup 取代舊的：一次觸發即清空帳，不留殘帳', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.ScheduleWakeup = { scheduledFor: 1234, clampedDelaySeconds: 60, wasClamped: false }
    await start($, on)
    await submit($)
    await runTurn($, '排第一個', { calls: [{ tool: 'ScheduleWakeup', delaySeconds: 60, prompt: 'first', reason: 'poll' }] })
    await runTurn($, '改排第二個', { calls: [{ tool: 'ScheduleWakeup', delaySeconds: 60, prompt: 'second', reason: 'poll' }] })
    expect(w.sends).toEqual([])
    await notify($, 'second', 'scheduled-trigger')
    await runTurn($, '觸發了')
    expect(w.sends.length).toBe(1)
    await runTurn($, '之後')
    expect(w.sends.length).toBe(2) // 帳已空，立即送出
  })

  test('subagent 內的 CronDelete 不動帳', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.CronCreate = { id: 'cr1' }
    await start($, on)
    await submit($)
    await runTurn($, '排好定時', { calls: [CRON_CREATE] })
    w.toolResults.CronDelete = { id: 'cr1' }
    await runTurn($, '二', { calls: [{ tool: 'CronDelete', id: 'cr1', agentId: 'sub-1' }] })
    expect(w.sends).toEqual([])
    expect(w.store.has(HELD)).toBe(true)
  })

  test('subagent 內的背景呼叫與隨最終回覆終止的背景指令都不登帳：照現行規則立即送出', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '一', { calls: [{ ...BASH_BG, agentId: 'sub-1' }] })
    expect(w.sends.length).toBe(1)
    w.toolResults.Bash = { backgroundTaskId: 'bt2', backgroundEndsWithFinalResponse: true }
    await runTurn($, '二', { calls: [BASH_BG] })
    expect(w.sends.length).toBe(2)
    expect(w.store.has(HELD)).toBe(false)
  })

  const STOP_OK = (id: string) => ({ message: `Successfully stopped task: ${id} (sleep 300)`, task_id: id, task_type: 'local_bash', command: 'sleep 300' })
  const STOP = (id: string) => ({ tool: 'TaskStop', task_id: id })

  test('TaskStop 成功：帳上那一筆銷掉，其後的進度回覆在本 turn 送出，不暫存到時限', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '一', { calls: [BASH_BG, ...[]] }) // 起背景 Bash：暫存
    expect(w.store.has(HELD)).toBe(true)
    w.toolResults.TaskStop = STOP_OK('bt1')
    await runTurn($, '已停掉背景測試', { calls: [STOP('bt1')] })
    expect(w.sends.length).toBe(1)
    expect(head(w.sends[0]!.text)).toMatch(/parts=held-reply,final-reply /)
    expect(w.store.has(HELD)).toBe(false)
    // 帳已空：之後的 turn 立即送出，不再暫存
    await runTurn($, '收尾')
    expect(w.sends.length).toBe(2)
    expect(w.store.has(HELD)).toBe(false)
  })

  test('TaskStop 失敗（結果帶 isError）不銷帳：其後的等待中 turn 照現行規則暫存', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '一', { calls: [BASH_BG] })
    w.toolResults.TaskStop = 'Error: No task found with ID: zzz'
    w.toolErrors.add('TaskStop')
    await runTurn($, '停一個不存在的', { calls: [STOP('zzz')] })
    expect(w.sends).toEqual([])
    expect(w.store.get(HELD)).toMatchObject({ text: '一\n\n停一個不存在的' })
  })

  test('TaskStop 只銷它停掉的那一筆：另一筆還在，等待中的 turn 照現行規則暫存', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '一', { calls: [BASH_BG] })
    w.toolResults.Bash = { backgroundTaskId: 'bt2' }
    await runTurn($, '二', { calls: [BASH_BG] })
    w.toolResults.TaskStop = STOP_OK('bt1')
    await runTurn($, '停掉第一個', { calls: [STOP('bt1')] })
    expect(w.sends).toEqual([]) // bt2 還在
    expect(w.store.get(HELD)).toMatchObject({ text: '一\n\n二\n\n停掉第一個' })
    await notify($, done('bt2'))
    await runTurn($, '都好了')
    expect(w.sends.length).toBe(1)
  })

  test('被停掉的背景 Agent 之後的 killed 通知不誤銷其他工作', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Agent = { isAsync: true, agentId: 'ag1' }
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '起 agent 與 bash', { calls: [{ tool: 'Agent' }, BASH_BG] })
    w.toolResults.TaskStop = { ...STOP_OK('ag1'), task_type: 'local_agent' }
    await runTurn($, '停掉 agent', { calls: [STOP('ag1')] })
    await notify($, `<task-notification>\n<task-id>ag1</task-id>\n<status>killed</status>\n</task-notification>`)
    await runTurn($, '還在等 bash') // bt1 仍在帳上：暫存
    expect(w.sends).toEqual([])
    expect(w.store.has(HELD)).toBe(true)
  })

  test('subagent 內的 TaskStop 不動帳', async ($: any, on: any) => {
    const w = world(on)
    mock.clock(on)
    w.toolResults.Bash = { backgroundTaskId: 'bt1' }
    await start($, on)
    await submit($)
    await runTurn($, '一', { calls: [BASH_BG] })
    w.toolResults.TaskStop = STOP_OK('bt1')
    await runTurn($, '二', { calls: [{ ...STOP('bt1'), agentId: 'sub-1' }] })
    expect(w.sends).toEqual([]) // 帳上 bt1 仍在
    expect(w.store.has(HELD)).toBe(true)
  })

  test('subagent 的 turn.start 不動主迴圈的 turn 狀態：不讓 inTurn 卡住，時限到時閒置的 worker 直接被叫醒', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    // 主迴圈已閒置；subagent 的 turn.start 不應把 inTurn 設起
    await $.turn.start({ text: 'sub', turnId: 'sub-t', agentId: 'sub-1' } as any)
    await clock.advance(HOLD_LIMIT_MS)
    // 閒置 → 直接叫醒（沒有進入「在 turn 中」重確認）
    expect(w.prompts).toEqual([WAKE_TEXT])
  })

  test('停用（mission 檔搬走）後取消計時器：不叫醒、不送', async ($: any, on: any) => {
    const { w, clock } = await holdFirst($, on)
    w.files.delete(`${DIR}/shop.json`)
    await runTurn($, '還有一句') // 停用
    await clock.advance(HOLD_LIMIT_MS * 2)
    expect(w.prompts).toEqual([])
    expect(w.sends).toEqual([])
  })

  test('注入段提醒：背景工作進行中要立即回應就用 SendMessage（自送不延後）', async ($: any, on: any) => {
    world(on)
    await start($, on)
    await submit($)
    const sections = ((await $.prompt.compose(COMPOSE)) as any).sections
    expect(sections[0].text).toContain('暫存')
    expect(sections[0].text).toContain('SendMessage')
    expect(sections[0].text).not.toContain('AskUserQuestion')
  })
})
