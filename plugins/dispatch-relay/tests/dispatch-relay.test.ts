// dispatch-relay 行為測試：`claude plugin test plugins/dispatch-relay`
//
// 測試的 `on` 位於所有 plugin 之下、扮演引擎：檔案系統（mission 目錄與結果檔）、設定、session id、
// `claude agents --json` 名冊由這裡假造，`session.send` 與本 mod 排入的 prompt 記錄下來。mod 不寫檔，所以沒有 fs.write。

import { describe, expect, test } from 'claude-code/testing'

import {
  buildMessage,
  checkResultFile,
  classifyRecipient,
  configRefusal,
  degradeFailedLine,
  degradePrompt,
  dirRefusal,
  findIdentity,
  injectionText,
  parseMission,
  parseRoster,
  resolveStation,
  sendCheckVerdict,
  submitFailure,
  trySubmit,
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
    expect(findIdentity(one, 'someone')).toEqual({ kind: 'none' })
    expect(findIdentity(one, '')).toEqual({ kind: 'none' })
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

  test('降級 prompt：from 指引在前、上次位址其次、station 名稱最後，各占一行', async () => {
    const built = buildMessage(IDS, undefined, 'x', '', false)
    const p = degradePrompt(built, 'gone', 'reports/api.md', { station: 'shop-lead', lastDelivered: 'uds:/tmp/s.sock' })
    expect(p).toContain('gone')
    expect(p).toContain('reports/api.md')
    expect(p).toContain('不要為此另外寫檔')
    const lines = p.split('\n')
    const at = ['from 位址', 'uds:/tmp/s.sock', 'shop-lead'].map(s => lines.findIndex(l => l.includes(s)))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at[0]! < at[1]! && at[1]! < at[2]!).toBe(true)
    expect(degradePrompt(built, 'gone', 'r.md', { station: 'shop-lead' })).not.toContain('uds:')
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
  roster: object[] | 'fail'
  rosterCalls: number
  sessionId: string
  sends: { to: string; text: string }[]
  sendReplies: SendReply[]
  sendCalls: number
  prompts: string[]
  submitReplies: SubmitReply[]
  logs: string[]
  store: Map<string, unknown>
  storeAtPrompt: Record<string, unknown>[]
}

function parentOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

function world(on: any, opts: { files?: Record<string, string>; send?: SendReply[]; submit?: SubmitReply[]; roster?: object[] | 'fail' } = {}): World {
  const w: World = {
    dirs: new Set([HOME, `${HOME}/.claude`, DIR, `${HOME}/code`, ROOT]),
    files: new Map(Object.entries(opts.files ?? { [`${DIR}/shop.json`]: mission({ nodes: NODES }) })),
    links: new Map(),
    userSettings: {},
    roster: opts.roster ?? ROSTER,
    rosterCalls: 0,
    sessionId: SELF_ID,
    sends: [],
    sendReplies: opts.send ?? [{ isDelivered: true }],
    sendCalls: 0,
    prompts: [],
    submitReplies: opts.submit ?? ['ok'],
    logs: [],
    store: new Map(),
    storeAtPrompt: [],
  }
  const value = (v: unknown) => ({ value: v })
  const real = (p: string) => {
    for (const [from, to] of w.links) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
    return p
  }
  on('env.get', (_$: any, e: any) => value(e.name === 'HOME' ? HOME : undefined))
  on('settings.read', () => value(w.userSettings))
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
    w.logs.push(String(e.text))
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
    w.store.set(e.key, e.value)
    return value(undefined)
  })
  on('store.delete', (_$: any, e: any) => {
    w.store.delete(e.key)
    return value(undefined)
  })
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
  on('tool.call', () => ({ result: { ok: true } }))
  on('tool.check', () => ({ decision: 'ask' }))
  return w
}

async function start($: any, on: any): Promise<void> {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
}

let turnN = 0
async function runTurn($: any, answer: string, opts: { reason?: string; agentId?: string; selfSend?: boolean } = {}): Promise<string> {
  turnN += 1
  const turnId = `t${turnN}`
  await $.turn.start({ text: 'go', turnId })
  if (opts.selfSend) {
    await $.tool.call({ tool: 'SendMessage', input: { to: 'shop-lead', message: 'x' }, tool_use_id: `u${turnN}` } as any)
  }
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
    expect(w.prompts[0]).toContain(`上次成功送達指揮站時使用的位址是 ${modTo}`)
    const text = await runTurn($, '我只回覆文字')
    expect(w.prompts.length).toBe(1)
    expect(text).toContain('再度失敗')
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
