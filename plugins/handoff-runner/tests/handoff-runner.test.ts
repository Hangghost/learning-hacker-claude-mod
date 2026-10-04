// handoff-runner 行為測試：`claude plugin test plugins/handoff-runner`
//
// 測試的 `on` 位於 plugin 之下、扮演引擎：`process.run` 由一個記憶體裡的假 git 回答，
// `fs.*` 由記憶體裡的檔案表回答。會改 ref 的 git（merge／update-ref／push）另外記在 `w.writes`，
// 用來確認「沒按按鈕就沒有任何寫入」。真實 git 上的行為由 tests/real-git.mjs 驗證。

import { describe, expect, mock, test } from 'claude-code/testing'

import { bandText, preflight } from '../hooks/logic'
import type { Rendered, TicketRow } from '../types'

const ROOT = '/repo'
const GIT = `${ROOT}/.git`
const WT = `${ROOT}/.claude/worktrees/x`
const TOOL = 'mcp__handoff-runner__handoff_issue'

const sha = (n: number) => n.toString(16).padStart(40, '0')
const C0 = sha(1)
const C1 = sha(2)
const C2 = sha(3)

type World = {
  commits: Record<string, { parent: string | null; files: string[] }>
  branches: Record<string, string>
  trees: { path: string; branch: string | null }[]
  dirty: Record<string, string[]>
  remote: Record<string, string> | null
  files: Map<string, string>
  dirs: Set<string>
  writes: string[][]
  toasts: string[]
  prompts: string[]
}

function newWorld(): World {
  return {
    commits: { [C0]: { parent: null, files: ['README.md'] }, [C1]: { parent: C0, files: ['a.txt'] }, [C2]: { parent: C1, files: ['b.txt'] } },
    branches: { main: C0, 'feature/x': C1 },
    trees: [
      { path: ROOT, branch: 'main' },
      { path: WT, branch: 'feature/x' },
    ],
    dirty: {},
    remote: null,
    files: new Map(),
    dirs: new Set(),
    writes: [],
    toasts: [],
    prompts: [],
  }
}

function ancestor(w: World, a: string, b: string): number {
  if (!w.commits[a] || !w.commits[b]) return 128
  for (let c: string | null = b; c; c = w.commits[c]?.parent ?? null) if (c === a) return 0
  return 1
}

function revParse(w: World, cwd: string, spec: string): string | null {
  const ref = spec.replace(/\^\{commit\}$/, '')
  if (ref === 'HEAD') {
    const b = w.trees.find(t => t.path === cwd)?.branch
    return b ? (w.branches[b] ?? null) : null
  }
  if (ref.startsWith('refs/heads/')) return w.branches[ref.slice('refs/heads/'.length)] ?? null
  return w.commits[ref] ? ref : null
}

function fakeGit(w: World, argv: string[], cwd: string): { exitCode: number; stdout?: string; stderr?: string } {
  let args = argv.slice(1)
  if (args[0] === '-C') {
    cwd = args[1]!
    args = args.slice(2)
  }
  const [sub, ...rest] = args
  switch (sub) {
    case 'rev-parse': {
      if (rest.includes('--git-common-dir')) return { exitCode: 0, stdout: `${GIT}\n` }
      const r = revParse(w, cwd, rest[rest.length - 1]!)
      return r ? { exitCode: 0, stdout: `${r}\n` } : { exitCode: 1 }
    }
    case 'merge-base':
      return { exitCode: ancestor(w, rest[1]!, rest[2]!) }
    case 'check-ref-format':
      return { exitCode: /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(rest[1]!) && !rest[1]!.includes('..') ? 0 : 128 }
    case 'worktree':
      return { exitCode: 0, stdout: w.trees.map(t => `worktree ${t.path}\nHEAD x\n${t.branch ? `branch refs/heads/${t.branch}` : 'detached'}\n`).join('\n') }
    case 'status':
      return { exitCode: 0, stdout: (w.dirty[cwd] ?? []).map(f => ` M ${f}\0`).join('') }
    case 'diff': {
      const [a, b] = rest.slice(-2) as [string, string]
      const files: string[] = []
      for (let c: string | null = b; c && c !== a; c = w.commits[c]?.parent ?? null) files.push(...(w.commits[c]?.files ?? []))
      return { exitCode: 0, stdout: files.map(f => `${f}\0`).join('') }
    }
    case 'ls-remote': {
      if (!w.remote) return { exitCode: 128, stderr: 'fatal: unable to access' }
      const ref = rest[1]!
      return { exitCode: 0, stdout: w.remote[ref] ? `${w.remote[ref]}\t${ref}\n` : '' }
    }
    case 'merge': {
      w.writes.push(argv)
      const b = w.trees.find(t => t.path === cwd)?.branch
      const to = rest[1]!
      if (!b || ancestor(w, w.branches[b]!, to) !== 0) return { exitCode: 128, stderr: 'fatal: Not possible to fast-forward' }
      w.branches[b] = to
      return { exitCode: 0 }
    }
    case 'update-ref': {
      w.writes.push(argv)
      const [, , ref, next, old] = rest
      const b = ref!.slice('refs/heads/'.length)
      if (w.branches[b] !== old) return { exitCode: 128, stderr: 'fatal: cannot lock ref' }
      w.branches[b] = next!
      return { exitCode: 0 }
    }
    case 'push': {
      w.writes.push(argv)
      if (!w.remote) return { exitCode: 128, stderr: 'fatal: unable to access' }
      const [src, dst] = rest[1]!.split(':') as [string, string]
      const cur = w.remote[dst]
      if (cur && ancestor(w, cur, src) !== 0) return { exitCode: 1, stderr: ' ! [rejected] (non-fast-forward)' }
      w.remote[dst] = src
      return { exitCode: 0 }
    }
  }
  return { exitCode: 129, stderr: `fake git: ${sub}` }
}

function engine(on: any, w: World): void {
  const value = (v: unknown) => ({ value: v })
  const proc = (r: { exitCode: number; stdout?: string; stderr?: string }) =>
    value({ exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return (globalThis as any).h(Text, {}, 'ENGINE_DEFAULT')
  })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    const cwd = e.init?.cwd ?? WT
    if (argv[0] === 'git') return proc(fakeGit(w, argv, cwd))
    if (argv[0] === 'mkdir') {
      if (w.dirs.has(argv[1]!)) return proc({ exitCode: 1, stderr: 'File exists' })
      w.dirs.add(argv[1]!)
      return proc({ exitCode: 0 })
    }
    if (argv[0] === 'rmdir') {
      w.dirs.delete(argv[1]!)
      return proc({ exitCode: 0 })
    }
    return proc({ exitCode: 127, stderr: 'not found' })
  })
  on('fs.read', (_$: any, e: any) => (w.files.has(e.path) ? value(w.files.get(e.path)) : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_$: any, e: any) => {
    w.files.set(e.path, e.text)
    return value(undefined)
  })
  on('fs.list', (_$: any, e: any) => {
    const prefix = `${e.path}/`
    const names = [...w.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    return value(names.map(p => ({ name: p.slice(prefix.length), kind: 'file', size: 0, mtimeMs: 0, isLink: false })))
  })
  on('session.cwd', () => value(WT))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('tool.register', (_$: any, e: any) => value({ tool: `mcp__handoff-runner__${e.name}` }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.open', () => value({ isPlaced: true }))
  on('ui.close', () => value(undefined))
  on('prompt.submit', (_$: any, e: any) => {
    w.prompts.push(String(e.text))
    return value(undefined)
  })
}

async function start($: any, on: any): Promise<void> {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: WT, surface: null, isInteractive: false })
}

async function issue($: any, args: Record<string, unknown> = { branch: 'feature/x' }): Promise<any> {
  return $.tool.call({ tool: TOOL, ...args } as any)
}

async function command($: any, args = ''): Promise<string> {
  const r: any = await $.command.run({ command: 'handoff', args, origin: { kind: 'composer' } } as any)
  return String(r?.text ?? '')
}

const mountPane = ($: any, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'handoff-runner', surface, component: 'Pane', requestId: 'handoff-runner', props: {} } as any)

async function band($: any, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string | null> {
  const ui = await $.ui.mount({ plugin: 'handoff-runner', surface, component: 'AbovePrompt', props: {} } as any)
  const t: any = await ui.find({ type: 'Text', text: /⇄/ })
  await ui.unmount()
  return t ? String(t.text ?? t.props?.children ?? 'found') : null
}

function ticketIds(w: World): string[] {
  return [...w.files.keys()].filter(p => /\/handoffs\/[^/]+\.json$/.test(p) && !/\.(result|lock)\.json$/.test(p)).map(p => p.split('/').pop()!.slice(0, -5))
}

function result(w: World, id: string): any {
  const text = w.files.get(`${GIT}/handoffs/${id}.result.json`)
  return text ? JSON.parse(text) : null
}

// ── 純函式 ──────────────────────────────────────────────────────────────────

describe('logic', () => {
  const ROW: TicketRow = { id: 'x-1', title: 'feature/x → main', outcome: null, summary: null }
  const r = (over: Partial<Rendered> = {}): Rendered => ({
    id: 'x-1',
    status: 'ready',
    title: ROW.title,
    prechecks: [],
    steps: [{ name: 'S1', label: '', argv: ['git', '-C', ROOT, 'merge', '--ff-only', C1], done_already: false, detail: '' }],
    fingerprint: 'fp',
    reason: '',
    last_result: null,
    ...over,
  })

  test('bandText：無單不佔行、有單顯示張數、失敗不偽裝成空', async () => {
    expect(bandText([], null)).toBe(null)
    expect(bandText([ROW], null)).toBe('⇄ 1 張交接單等你：feature/x → main · /handoff')
    expect(bandText([ROW, { ...ROW, id: 'b' }], null)).toBe('⇄ 2 張交接單等你：feature/x → main 等 · /handoff')
    expect(bandText([{ ...ROW, outcome: 'passed' }], null)).toBe(null)
    expect(bandText([], 'boom')).toBe('⇄ handoff-runner 無法讀取交接單（boom）')
  })

  test('preflight：非 ready、畫面不同、argv 不在允許形狀內都不執行', async () => {
    expect(preflight(r(), r())).toBe(null)
    expect(preflight(r(), r({ status: 'stale' }))).toBe('stale')
    expect(preflight(r(), r({ status: 'blocked' }))).toBe('blocked')
    expect(preflight(r(), r({ fingerprint: 'other' }))).toBe('mismatch')
    expect(preflight(undefined, r())).toBe('mismatch')
    for (const argv of [
      ['sh', '-c', 'rm -rf ~'],
      ['git', '-C', ROOT, 'push', 'origin', `+${C1}:refs/heads/main`],
      ['git', '-C', ROOT, 'push', '--force', 'origin', `${C1}:refs/heads/main`],
      ['git', '-C', ROOT, 'reset', '--hard', C1],
      ['git', 'merge', '--ff-only', C1],
    ]) {
      const evil = r({ steps: [{ name: 'S1', label: '', argv, done_already: false, detail: '' }] })
      expect(preflight(evil, evil)).toBe('mismatch')
    }
  })
})

// ── 簽發 ────────────────────────────────────────────────────────────────────

describe('簽發', () => {
  test('工具只寫一張只帶參數的交接單，不做任何 git 寫入', async ($, on) => {
    const w = newWorld()
    engine(on, w)
    await start($, on)
    const r = await issue($)
    expect(String(r.result)).toMatch(/已簽發交接單/)
    const ids = ticketIds(w)
    expect(ids).toHaveLength(1)
    const t = JSON.parse(w.files.get(`${GIT}/handoffs/${ids[0]}.json`)!)
    expect(Object.keys(t.params).sort()).toEqual(['branch', 'sha', 'target'])
    expect(t.params).toEqual({ branch: 'feature/x', target: 'main', sha: C1 })
    expect(w.writes).toEqual([])
    expect(w.prompts).toEqual([])
  })

  test('同分支同 commit 再簽一次沿用舊單；分支前進後再簽會取代舊單', async ($, on) => {
    const w = newWorld()
    engine(on, w)
    await start($, on)
    await issue($)
    expect(String((await issue($)).result)).toMatch(/已有相同的交接單/)
    expect(ticketIds(w)).toHaveLength(1)
    const old = ticketIds(w)[0]!
    w.branches['feature/x'] = C2
    expect(String((await issue($)).result)).toMatch(/取代了舊單/)
    expect(result(w, old).outcome).toBe('dismissed')
  })

  test('不合法或無法快轉的分支：拒絕簽發，不寫檔', async ($, on) => {
    const w = newWorld()
    w.commits[sha(9)] = { parent: C0, files: ['z'] }
    w.branches['side'] = sha(9)
    w.branches['main'] = C1
    engine(on, w)
    await start($, on)
    for (const branch of ['--upload-pack=x', 'a:b', 'nope', 'main', 'side']) {
      const r = await issue($, { branch })
      expect(r.deny).toBeDefined()
    }
    expect(ticketIds(w)).toEqual([])
  })

  test('/handoff issue 指令與面板的簽發按鈕', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    engine(on, w)
    await start($, on)
    await command($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'issue:feature/x' })
    await ui.unmount()
    expect(ticketIds(w)).toHaveLength(1)
    expect(await command($, 'issue feature/x main')).toMatch(/已有相同的交接單/)
    expect(await command($, 'run x')).toMatch(/用法/)
    expect(w.writes).toEqual([])
  })
})

// ── band 與面板 ─────────────────────────────────────────────────────────────

describe('面板', () => {
  test('band：有待辦單時顯示，落地後不佔行', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    engine(on, w)
    await start($, on)
    expect(await band($)).toBe(null)
    await issue($)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) expect(await band($, surface)).toMatch(/1 張交接單等你：feature\/x → main/)
  })

  test('列出事前檢查與完整 argv，ready 時有執行按鈕；開面板、輪詢都不執行', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    engine(on, w)
    await start($, on)
    await issue($)
    await command($)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: /✓ P3 \/repo 持有 main，工作樹乾淨/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`git -C /repo merge --ff-only ${C1}`) })).toBeDefined()
      const keys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys.some((k: string) => k.startsWith('run:'))).toBe(true)
      await ui.unmount()
    }
    await clock.advance(5 * 60_000)
    expect(w.writes).toEqual([])
    expect(w.prompts).toEqual([])
  })

  test('目標分支沒被 checkout 時改為 update-ref，並帶預期舊值', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    w.trees[0]!.branch = null
    engine(on, w)
    await start($, on)
    await issue($)
    await command($)
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: new RegExp(`update-ref -m .* refs/heads/main ${C1} ${C0}`) })).toBeDefined()
    await ui.unmount()
  })

  test('持有者有重疊的未 commit 變更：blocked，沒有執行按鈕', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    w.dirty[ROOT] = ['a.txt']
    engine(on, w)
    await start($, on)
    await issue($)
    await command($)
    await clock.settle()
    const ui = await mountPane($)
    expect((await ui.findAll({ type: 'Button' })).some((b: any) => String(b.key).startsWith('run:'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /無法執行（blocked）：.*a\.txt/ })).toBeDefined()
    await ui.unmount()
  })
})

// ── 按鈕：唯一的執行路徑 ─────────────────────────────────────────────────────

describe('執行', () => {
  async function ready($: any, on: any, w: World): Promise<{ clock: any; id: string }> {
    const clock = mock.clock(on)
    engine(on, w)
    await start($, on)
    await issue($)
    await command($)
    await clock.settle()
    return { clock, id: ticketIds(w)[0]! }
  }

  test('按下執行：快轉、事後驗證、寫結果檔、toast 摘要、釋放鎖', async ($, on) => {
    const w = newWorld()
    const { clock, id } = await ready($, on, w)
    const ui = await mountPane($)
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes.map(a => a.slice(3).join(' '))).toEqual([`merge --ff-only ${C1}`])
    expect(w.branches['main']).toBe(C1)
    expect(result(w, id).outcome).toBe('passed')
    expect(w.toasts.some(t => t.includes('✓ 3/3 通過'))).toBe(true)
    expect(w.dirs.size).toBe(0)
    expect(await band($)).toBe(null)
  })

  test('push 開啟：快轉後 push 到 remote，並驗證遠端', { options: { push: true } }, async ($, on) => {
    const w = newWorld()
    w.remote = { 'refs/heads/main': C0 }
    const { clock, id } = await ready($, on, w)
    const ui = await mountPane($)
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes.map(a => a.slice(3).join(' '))).toEqual([`merge --ff-only ${C1}`, `push origin ${C1}:refs/heads/main`])
    expect(w.remote['refs/heads/main']).toBe(C1)
    expect(result(w, id).outcome).toBe('passed')
  })

  test('push 開啟但 remote 讀不到：blocked，不執行', { options: { push: true } }, async ($, on) => {
    const w = newWorld()
    const { id } = await ready($, on, w)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: `run:${id}` } as any)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /✗ P4 讀不到 origin/ })).toBeDefined()
    await ui.unmount()
  })

  test('畫面之後目標分支被移動：重新推導不同，零次寫入，結果為 stale', async ($, on) => {
    const w = newWorld()
    const { clock, id } = await ready($, on, w)
    w.trees[0]!.branch = null
    const ui = await mountPane($)
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes).toEqual([])
    expect(result(w, id).outcome).toBe('stale')
    expect(result(w, id).summary).toMatch(/畫面與重新檢查的內容不同/)
  })

  test('畫面之後分支又前進：事前檢查不再成立，零次寫入', async ($, on) => {
    const w = newWorld()
    const { clock, id } = await ready($, on, w)
    w.branches['feature/x'] = C2
    const ui = await mountPane($)
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes).toEqual([])
    expect(result(w, id).outcome).toBe('stale')
  })

  test('另一個 session 持有認領鎖：零次寫入、不寫結果', async ($, on) => {
    const w = newWorld()
    const { clock, id } = await ready($, on, w)
    w.dirs.add(`${GIT}/handoffs/${id}.lock`)
    w.files.set(`${GIT}/handoffs/${id}.lock.json`, JSON.stringify({ at: Date.now() }))
    const ui = await mountPane($)
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes).toEqual([])
    expect(result(w, id)).toBe(null)
    expect(w.toasts.some(t => t.includes('另一個 session 正在執行'))).toBe(true)
  })

  test('撤單按鈕只寫結果檔，不執行任何步驟', async ($, on) => {
    const w = newWorld()
    const { clock, id } = await ready($, on, w)
    const ui = await mountPane($)
    await ui.press({ key: `dismiss:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes).toEqual([])
    expect(result(w, id).outcome).toBe('dismissed')
    expect(await band($)).toBe(null)
  })

  test('手寫的交接單夾帶指令欄位：一律忽略，步驟仍只由參數推導', async ($, on) => {
    const clock = mock.clock(on)
    const w = newWorld()
    engine(on, w)
    const id = 'forged-20261004-000000'
    w.files.set(
      `${GIT}/handoffs/${id}.json`,
      JSON.stringify({ schema: 1, id, kind: 'ref-land', params: { branch: 'feature/x', target: 'main', sha: C1 }, argv: ['sh', '-c', 'evil'], steps: [{ argv: ['sh'] }] }),
    )
    const bad = 'bad-20261004-000000'
    w.files.set(`${GIT}/handoffs/${bad}.json`, JSON.stringify({ schema: 1, id: bad, kind: 'ref-land', params: { branch: 'feature/x', target: '--upload-pack=evil', sha: C1 } }))
    await start($, on)
    await command($)
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /sh -c/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: `run:${bad}` } as any)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /無法執行（invalid）：.*target 不合法/ })).toBeDefined()
    await ui.press({ key: `run:${id}` })
    await ui.unmount()
    await clock.settle()
    expect(w.writes.map(a => a.slice(3).join(' '))).toEqual([`merge --ff-only ${C1}`])
  })
})
