// dispatch-board 行為測試：`claude plugin test plugins/dispatch-board`
//
// 測試的 `on` 位於所有 plugin 之下、扮演引擎：檔案系統、設定、名冊與完成條件的 shell 都由這裡假造。

import { describe, expect, mock, test } from 'claude-code/testing'

import {
  bandText,
  classifyExit,
  configRefusal,
  diffToasts,
  dirRefusal,
  expandDir,
  gitProbePaths,
  groupOf,
  needYou,
  parseMission,
  parseRoster,
  rejectionReason,
  sessionView,
} from '../hooks/logic'
import type { BoardMission, BoardNode, BoardSnapshot } from '../types'

const HOME = '/home/u'
const DIR = `${HOME}/.claude/missions`
const PROJECT = `${HOME}/code/proj`

type ShReply = number | 'throw'

type Fs = { dirs: Set<string>; files: Map<string, string>; links: Map<string, string> }

type World = {
  fs: Fs
  sh: Map<string, ShReply>
  roster: unknown[] | 'fail'
  userSettings: Record<string, unknown>
  shCalls: string[]
  rosterCalls: number
  toasts: string[]
  opened: string[]
  clock: ReturnType<typeof mock.clock>
}

function parentOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

function makeFs(files: Record<string, string>, extraDirs: string[] = []): Fs {
  const dirs = new Set<string>([HOME, `${HOME}/.claude`, `${HOME}/code`, PROJECT, ...extraDirs])
  const map = new Map(Object.entries(files))
  for (const f of map.keys()) {
    let d = parentOf(f)
    while (d.length > 1) {
      dirs.add(d)
      d = parentOf(d)
    }
  }
  return { dirs, files: map, links: new Map() }
}

function world(on: any, w0: Partial<World> & { fs: Fs }, env: Record<string, string> = { HOME }): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    sh: new Map(),
    roster: [],
    userSettings: {},
    shCalls: [],
    rosterCalls: 0,
    toasts: [],
    opened: [],
    ...w0,
  }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  const resolve = (p: string) => w.fs.links.get(p) ?? p
  on('fs.stat', (_$: any, e: any) => {
    const real = resolve(e.path)
    const isLink = w.fs.links.has(e.path)
    if (w.fs.dirs.has(real)) return value({ kind: 'dir', size: 0, mtimeMs: 0, isLink, ...(e.resolve ? { realPath: real } : {}) })
    const text = w.fs.files.get(real)
    if (text !== undefined) return value({ kind: 'file', size: text.length, mtimeMs: 0, isLink, ...(e.resolve ? { realPath: real } : {}) })
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', (_$: any, e: any) => value(w.fs.dirs.has(e.path) || w.fs.files.has(e.path)))
  on('fs.list', (_$: any, e: any) => {
    const out: any[] = []
    for (const d of w.fs.dirs) if (parentOf(d) === e.path && d !== e.path) out.push({ name: d.slice(e.path.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    for (const [f, t] of w.fs.files) if (parentOf(f) === e.path) out.push({ name: f.slice(e.path.length + 1), kind: 'file', size: t.length, mtimeMs: 0, isLink: false })
    for (const l of w.fs.links.keys()) if (parentOf(l) === e.path) out.push({ name: l.slice(e.path.length + 1), kind: 'other', size: 0, mtimeMs: 0, isLink: true })
    return value(out)
  })
  on('fs.read', (_$: any, e: any) => {
    const t = w.fs.files.get(e.path)
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : value(t)
  })
  on('session.root', () => value(PROJECT))
  on('session.cwd', () => value(PROJECT))
  on('settings.read', () => value(w.userSettings))
  on('process.run', async (_$: any, e: any) => {
    const argv: readonly string[] = e.argv
    const ok = (exitCode: number, stdout = '', stderr = '') =>
      value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
    if (argv[0] === 'claude') {
      w.rosterCalls += 1
      return w.roster === 'fail' ? ok(1, '', 'error: unknown command') : ok(0, JSON.stringify(w.roster))
    }
    if (argv[0] === '/bin/sh') {
      const cmd = argv[2] ?? ''
      w.shCalls.push(cmd)
      const r = w.sh.get(cmd) ?? 1
      if (r === 'throw') {
        // 引擎的逾時：跑滿 timeoutMs 才 reject，訊息不保證寫明是逾時
        await w.clock.sleep(e.init?.timeoutMs ?? 30_000)
        return { deny: 'still running' }
      }
      return ok(r, '', r === 127 ? 'sh: nope: command not found' : '')
    }
    return ok(1)
  })
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.open', (_$: any, e: any) => {
    w.opened.push(e.id)
    return value({ isPlaced: true })
  })
  on('ui.close', () => value(undefined))
  // 引擎的預設繪製：plugin 回 next(e) 時由這裡接住
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  return w
}

const mission = (id: string, nodes: object[], extra: object = {}) => JSON.stringify({ mission_id: id, nodes, ...extra })

async function start($: any, on: any, w: World): Promise<void> {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

async function dispatch($: any, w: World, args = ''): Promise<string> {
  const r: any = await $.command.run({ command: 'dispatch', args, origin: { kind: 'composer' } } as any)
  await w.clock.settle()
  return String(r?.text ?? '')
}

const BAND = { plugin: 'dispatch-board', component: 'AbovePrompt', props: {} } as const
const PANE = { plugin: 'dispatch-board', component: 'Pane', requestId: 'dispatch-board', props: {} } as const

async function texts($: any, spec: object, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...spec, surface } as any)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map((t: any) => String(t.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

// ── 純函式 ──────────────────────────────────────────────────────────────────

describe('logic', () => {
  test('parseMission：合法檔、mission_id 預設取檔名', async () => {
    const r = parseMission(JSON.stringify({ nodes: [{ id: 'a', done: 'true', session: 's1' }, { id: 'b', done: 'true', depends_on: ['a'] }] }), 'm1.json')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mission_id).toBe('m1')
      expect(r.value.nodes[1]?.depends_on).toEqual(['a'])
    }
  })

  test('parseMission：缺 done、重複 id、依賴不存在、非 JSON 都附原因', async () => {
    const bad = (o: unknown) => parseMission(typeof o === 'string' ? o : JSON.stringify(o), 'x.json')
    expect(bad('{')).toEqual({ ok: false, reason: '不是合法 JSON' })
    expect(bad({ nodes: [] }).ok).toBe(false)
    const noDone = bad({ nodes: [{ id: 'a' }] })
    expect(noDone.ok === false && noDone.reason.includes('a.done')).toBe(true)
    const dup = bad({ nodes: [{ id: 'a', done: 'x' }, { id: 'a', done: 'y' }] })
    expect(dup.ok === false && dup.reason.includes('重複')).toBe(true)
    const dep = bad({ nodes: [{ id: 'a', done: 'x', depends_on: ['zz'] }] })
    expect(dep.ok === false && dep.reason.includes('zz')).toBe(true)
    expect(bad({ mission_id: '../etc', nodes: [{ id: 'a', done: 'x' }] }).ok).toBe(false)
  })

  test('expandDir：只收 ~ 開頭或絕對路徑', async () => {
    expect(expandDir('~/.claude/missions', HOME)).toEqual({ ok: true, path: DIR })
    expect(expandDir('/abs/dir', HOME)).toEqual({ ok: true, path: '/abs/dir' })
    expect(expandDir('missions', HOME).ok).toBe(false)
    expect(expandDir('./missions', HOME).ok).toBe(false)
  })

  test('dirRefusal：家目錄外、專案目錄內、git 工作樹內都拒讀', async () => {
    const base = { realHome: HOME, realDir: DIR, projectDirs: [PROJECT], gitHits: [] }
    expect(dirRefusal(base)).toBe(null)
    expect(dirRefusal({ ...base, realDir: '/etc/missions' })).toMatch(/不在家目錄/)
    expect(dirRefusal({ ...base, realDir: HOME })).toMatch(/不在家目錄/)
    expect(dirRefusal({ ...base, realDir: `${PROJECT}/missions` })).toMatch(/專案目錄/)
    expect(dirRefusal({ ...base, realDir: `${HOME}/code/other/m`, gitHits: [`${HOME}/code/other/.git`] })).toMatch(/git/)
    expect(gitProbePaths(`${HOME}/a/b`, HOME)).toEqual([`${HOME}/a/b/.git`, `${HOME}/a/.git`])
  })

  test('configRefusal：自訂目錄只認使用者層級設定', async () => {
    expect(configRefusal('~/.claude/missions', {})).toBe(null)
    expect(configRefusal('~/m', {})).not.toBe(null)
    expect(configRefusal('~/m', { pluginConfigs: { 'dispatch-board@mkt': { options: { missions_dir: '~/m' } } } })).toBe(null)
    expect(configRefusal('~/m', { pluginConfigs: { 'dispatch-board': { options: { missions_dir: '~/other' } } } })).not.toBe(null)
  })

  test('classifyExit：0 完成、126／127 無法判定、其他未完成', async () => {
    expect(classifyExit(0, '')).toEqual({ kind: 'done' })
    expect(classifyExit(1, '')).toEqual({ kind: 'open', exitCode: 1 })
    expect(classifyExit(127, 'sh: foo: not found').kind).toBe('unknown')
    expect(classifyExit(126, '').kind).toBe('unknown')
    expect(rejectionReason(new Error('still running'), 5_000)).toBe('逾時 5s')
    expect(rejectionReason(new Error('HooksError: dispatch-board: ENOENT /bin/sh'), 3)).toBe('跑不起來：ENOENT /bin/sh')
  })

  test('parseRoster 與 sessionView：名冊不可用不畫成已結束', async () => {
    expect(parseRoster(1, '', 'boom').available).toBe(false)
    expect(parseRoster(0, 'not json', '').available).toBe(false)
    const roster = parseRoster(0, JSON.stringify([{ name: 'W1', state: 'blocked' }, { name: 'w2', status: 'busy', state: 'working', startedAt: 5 }]), '')
    expect(sessionView('w1', roster, {})).toEqual({ kind: 'live', state: 'blocked', startedAt: null })
    expect(sessionView('w2', roster, {})).toEqual({ kind: 'live', state: 'working', startedAt: 5 })
    expect(sessionView('w3', roster, {})).toEqual({ kind: 'absent' })
    expect(sessionView('w3', roster, { w3: 1 })).toEqual({ kind: 'gone' })
    expect(sessionView('w3', { available: false, note: 'x' }, { w3: 1 })).toEqual({ kind: 'unavailable' })
    expect(sessionView('', roster, {})).toEqual({ kind: 'none' })
  })

  test('分組、needYou、band 與 toast', async () => {
    const n = (id: string, ev: BoardNode['eval'], live: BoardNode['live'], session = 's'): BoardNode => ({
      id, title: '', session, done: 'x', depends_on: [], eval: ev, live,
    })
    const m = (nodes: BoardNode[]): BoardMission => ({ mission_id: 'm', title: '', file: `${DIR}/m.json`, nodes })
    const snap = (ms: BoardMission[]): BoardSnapshot => ({ dir: '~/.claude/missions', roster: { available: true, note: '' }, missions: ms, bad: [] })
    const running = m([n('a', { kind: 'open', exitCode: 1 }, { kind: 'live', state: 'working', startedAt: 0 })])
    const unknown = m([n('a', { kind: 'unknown', reason: '逾時 5s' }, { kind: 'live', state: 'working', startedAt: 0 })])
    const finished = m([n('a', { kind: 'done' }, { kind: 'live', state: 'idle', startedAt: 0 })])
    expect(groupOf(running)).toBe('running')
    expect(groupOf(unknown)).toBe('need')
    expect(groupOf(finished)).toBe('converge')
    expect(needYou(snap([unknown]))).toBe(1)
    expect(bandText(snap([running]), null, 0, 3000)).toBe('⧉ m 0/1 · 0 需要你 · 3s 前')
    expect(bandText(snap([]), null, 0, 0)).toBe(null)
    expect(diffToasts(null, snap([finished]))).toEqual([])
    expect(diffToasts(snap([running]), snap([finished]))).toEqual(['m/a 完成', 'm 全部完成，待收斂'])
    expect(diffToasts(snap([running]), snap([unknown]))).toEqual(['m/a 完成條件無法判定：逾時 5s'])
  })
})

// ── 整合 ────────────────────────────────────────────────────────────────────

const TWO_NODES = mission('ship', [
  { id: 'api', title: '後端', session: 'w-api', done: 'check api' },
  { id: 'web', title: '前端', session: 'w-web', done: 'check web', depends_on: ['api'] },
])

describe('dispatch-board', () => {
  test('讀 mission、求值、對名冊：band 與面板分組', async ($, on) => {
    const w = world(on, {
      fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }),
      sh: new Map([['check api', 0]]),
      roster: [{ name: 'w-web', state: 'blocked', status: 'idle' }, { name: 'w-api', state: 'done', status: 'idle' }],
    })
    await start($, on, w)
    expect(await dispatch($, w)).toMatch(/面板已開啟/)
    expect([...new Set(w.shCalls)].sort()).toEqual(['check api', 'check web'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await texts($, BAND, surface)
      expect(has(band, /⧉ ship 1\/2 · 1 需要你/)).toBe(true)
      // band 疊加在下層之上，不吃掉其他 band
      expect(has(band, /ENGINE_DEFAULT/)).toBe(true)
      const pane = await texts($, PANE, surface)
      expect(has(pane, /^需要你（1）/)).toBe(true)
      expect(has(pane, /✓ api 後端 · 閒置 w-api/)).toBe(true)
      expect(has(pane, /⏸ web 前端 · .*blocked w-web/)).toBe(true)
    }
  })

  test('狀態轉換才跳 toast；第一份快照只作基準', async ($, on) => {
    const w = world(on, {
      fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }),
      roster: [{ name: 'w-api', state: 'working', status: 'busy' }],
    })
    await start($, on, w)
    await w.clock.settle()
    expect(w.toasts).toEqual([])
    w.sh.set('check api', 0)
    await w.clock.advance(30_000)
    expect(w.toasts).toEqual(['ship/api 完成'])
    w.sh.set('check web', 0)
    await w.clock.advance(30_000)
    expect(w.toasts).toContain('ship 全部完成，待收斂')
  })

  test('完成條件逾時＝無法判定，歸「需要你」而不是「跑著」', async ($, on) => {
    const w = world(on, {
      fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }),
      sh: new Map<string, ShReply>([['check api', 'throw'], ['check web', 127]]),
      roster: [{ name: 'w-api', state: 'working', status: 'busy' }],
    })
    await start($, on, w)
    await w.clock.advance(5_000)
    await dispatch($, w)
    await w.clock.advance(5_000)
    const pane = await texts($, PANE)
    expect(has(pane, /^需要你（1）/)).toBe(true)
    expect(has(pane, /^跑著/)).toBe(false)
    expect(has(pane, /✗ api/)).toBe(true)
    expect(has(pane, /條件 check api → 逾時 5s/)).toBe(true)
    expect(has(pane, /條件 check web → 指令跑不起來（exit 127/)).toBe(true)
  })

  test('名冊不可用：顯示「名冊不可用」，不顯示「已結束」', async ($, on) => {
    const w = world(on, { fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }), roster: 'fail' })
    await start($, on, w)
    await dispatch($, w)
    const pane = await texts($, PANE)
    expect(has(pane, /session 名冊不可用/)).toBe(true)
    expect(has(pane, /名冊不可用 w-api/)).toBe(true)
    expect(has(pane, /已結束/)).toBe(false)
  })

  test('看過的 session 從名冊消失＝已結束；條件沒達成就跳 toast', async ($, on) => {
    const w = world(on, {
      fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }),
      roster: [{ name: 'w-api', state: 'working', status: 'busy' }],
    })
    await start($, on, w)
    await w.clock.settle()
    w.roster = []
    await w.clock.advance(30_000)
    expect(w.toasts).toContain('ship/api 的 session 已結束，但完成條件沒達成')
    await dispatch($, w)
    const pane = await texts($, PANE)
    expect(has(pane, /○ api 後端 · 已結束但沒完成 · 已結束 w-api/)).toBe(true)
    expect(has(pane, /○ web 前端 · 等依賴 api · 不在名冊 w-web/)).toBe(true)
  })

  test('沒有 mission 檔：band 不佔行，不叫名冊、不執行任何指令', async ($, on) => {
    const w = world(on, { fs: makeFs({}, [DIR]) })
    await start($, on, w)
    await dispatch($, w)
    const band = await texts($, BAND)
    expect(band).toEqual(['ENGINE_DEFAULT'])
    expect(w.rosterCalls).toBe(0)
    expect(w.shCalls).toEqual([])
    expect(has(await texts($, PANE), /沒有 mission/)).toBe(true)
  })

  test('安全：mission 目錄在 git 工作樹內就拒讀，一條指令都不跑', { options: { missions_dir: '~/code/cloned/missions' } }, async ($, on) => {
    const dir = `${HOME}/code/cloned/missions`
    const fs = makeFs({ [`${dir}/evil.json`]: mission('evil', [{ id: 'x', done: 'touch pwned' }]) }, [`${HOME}/code/cloned/.git`])
    const w = world(on, {
      fs,
      userSettings: { pluginConfigs: { 'dispatch-board': { options: { missions_dir: '~/code/cloned/missions' } } } },
    })
    await start($, on, w)
    await dispatch($, w)
    expect(w.shCalls).toEqual([])
    expect(has(await texts($, BAND), /git 工作樹內.*拒讀/)).toBe(true)
  })

  test('安全：自訂目錄若不是使用者層級設定給的，就拒讀', { options: { missions_dir: '~/elsewhere' } }, async ($, on) => {
    const dir = `${HOME}/elsewhere`
    const w = world(on, { fs: makeFs({ [`${dir}/a.json`]: mission('a', [{ id: 'x', done: 'touch pwned' }]) }) })
    await start($, on, w)
    await dispatch($, w)
    expect(w.shCalls).toEqual([])
    expect(has(await texts($, PANE), /只接受使用者層級設定/)).toBe(true)
  })

  test('安全：mission 目錄在專案目錄內就拒讀', { options: { missions_dir: `${PROJECT}/missions` } }, async ($, on) => {
    const dir = `${PROJECT}/missions`
    const w = world(on, {
      fs: makeFs({ [`${dir}/a.json`]: mission('a', [{ id: 'x', done: 'touch pwned' }]) }),
      userSettings: { pluginConfigs: { 'dispatch-board': { options: { missions_dir: dir } } } },
    })
    await start($, on, w)
    await dispatch($, w)
    expect(w.shCalls).toEqual([])
    expect(has(await texts($, PANE), /專案目錄內，拒讀/)).toBe(true)
  })

  test('安全：經符號連結指到目錄外的 mission 檔拒讀並列出原因', async ($, on) => {
    const fs = makeFs({ [`${PROJECT}/m.json`]: mission('m', [{ id: 'x', done: 'touch pwned' }]) }, [DIR])
    fs.links.set(`${DIR}/m.json`, `${PROJECT}/m.json`)
    const w = world(on, { fs })
    await start($, on, w)
    await dispatch($, w)
    expect(w.shCalls).toEqual([])
    const pane = await texts($, PANE)
    expect(has(pane, /讀不了的 mission 檔（1）/)).toBe(true)
    expect(has(pane, /m\.json · 經符號連結指到 mission 目錄外/)).toBe(true)
  })

  test('安全：讀不到家目錄就整個停用', async ($, on) => {
    const w = world(on, { fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }) }, {})
    await start($, on, w)
    await dispatch($, w)
    expect(w.shCalls).toEqual([])
    expect(has(await texts($, BAND), /讀不到家目錄/)).toBe(true)
  })

  test('格式錯的 mission 檔列出原因，其他檔照常', async ($, on) => {
    const w = world(on, {
      fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES, [`${DIR}/broken.json`]: '{"nodes": [{"id": "a"}]}' }),
      sh: new Map([['check api', 0]]),
    })
    await start($, on, w)
    await dispatch($, w)
    const pane = await texts($, PANE)
    expect(has(pane, /broken\.json · a\.done 缺少/)).toBe(true)
    expect(has(pane, /ship  ▓░ 1\/2/)).toBe(true)
  })

  test('收斂提示附複製搬移指令的按鈕', async ($, on) => {
    const w = world(on, { fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }), sh: new Map([['check api', 0], ['check web', 0]]) })
    await start($, on, w)
    await dispatch($, w)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /^做完待收斂（1）/ })).toBeDefined()
    expect(await ui.find({ key: 'copy-archive:ship' })).toBeDefined()
    await ui.unmount()
  })

  test('/dispatch off 停止輪詢並收起 band', async ($, on) => {
    const w = world(on, { fs: makeFs({ [`${DIR}/ship.json`]: TWO_NODES }) })
    await start($, on, w)
    await w.clock.settle()
    const before = w.shCalls.length
    expect(await dispatch($, w, 'off')).toMatch(/已停止/)
    await w.clock.advance(120_000)
    expect(w.shCalls.length).toBe(before)
    expect(await texts($, BAND)).toEqual(['ENGINE_DEFAULT'])
  })

  test('demo 模式：假資料，不讀目錄、不執行指令', async ($, on) => {
    const w = world(on, { fs: makeFs({}) })
    await start($, on, w)
    expect(await dispatch($, w, 'demo')).toMatch(/demo 模式/)
    expect(w.opened).toEqual(['dispatch-board'])
    const pane = await texts($, PANE)
    expect(has(pane, /demo 模式/)).toBe(true)
    expect(has(pane, /shop-redesign/)).toBe(true)
    expect(w.shCalls).toEqual([])
    expect(w.rosterCalls).toBe(0)
  })
})
