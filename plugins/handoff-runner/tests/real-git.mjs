// 在真實 git repo 上跑 hooks/git.ts 與 hooks/logic.ts：`node plugins/handoff-runner/tests/real-git.mjs`
//
// `claude plugin test` 的環境沒有檔案系統與 process，所以 git 行為在這裡用 Node 驗：
// 每個情境建一個暫存 repo＋worktree，照 register.tsx 的 runTicket 順序（認領 → 重新推導 →
// 與畫面比對 → 執行 → 紀錄 → 釋放）實際落地，再用 git 本身確認結果。需要 Node 23.6 以上（直接載入 .ts）。

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

register('./node/ts-resolve.mjs', import.meta.url)
const git = await import('../hooks/git.ts')
const logic = await import('../hooks/logic.ts')

// 與使用者的 git 設定隔離（簽章、hooks、預設分支名）。
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_TERMINAL_PROMPT: '0',
})

let now = Date.parse('2026-10-04T12:00:00Z')

const host = {
  git: async (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    return { exitCode: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
  read: async p => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  write: async (p, t) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, t)
  },
  list: async d => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)
    } catch {
      return []
    }
  },
  mkdirExclusive: async p => {
    try {
      mkdirSync(p)
      return true
    } catch {
      return false
    }
  },
  rmdir: async p => {
    try {
      rmdirSync(p)
    } catch {}
  },
  now: () => now,
}

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr}`)
  return r.stdout.trim()
}

function commit(cwd, file, text) {
  writeFileSync(join(cwd, file), text)
  sh(cwd, 'add', file)
  sh(cwd, 'commit', '-q', '-m', `edit ${file}`)
  return sh(cwd, 'rev-parse', 'HEAD')
}

/** repo（main checkout 在 main）＋ worktree（feature/x 比 main 多一個 commit）。 */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-runner-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  const c0 = commit(repo, 'README.md', 'hi\n')
  const wt = join(base, 'wt')
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature/x', wt)
  const c1 = commit(wt, 'a.txt', 'a\n')
  const common = sh(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return { base, repo, wt, common, c0, c1 }
}

const LOCAL = { push: false, remote: 'origin' }

async function press(common, id, shown, cfg = LOCAL) {
  const c = await git.claim(host, common, id)
  if (!c.ok) return { claim: c }
  try {
    const log = { aborted: null, forced_stale_lock: c.forced, steps: [] }
    const fresh = await git.render(host, common, id, cfg)
    log.aborted = logic.preflight(shown, fresh)
    if (log.aborted === null) {
      log.steps = await logic.runSteps(fresh.steps, async argv => {
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
        return { exitCode: r.status, stderr: r.stderr ?? '' }
      })
    }
    return await git.record(host, common, id, log, cfg)
  } finally {
    await git.release(host, common, id)
  }
}

let failed = 0
const cases = []
const it = (name, fn) => cases.push([name, fn])
function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── 情境 ────────────────────────────────────────────────────────────────────

it('持有者版：在 main checkout 裡 ff-merge，工作樹跟著前進', async () => {
  const r = setup()
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  ok(issued.ok, `issue: ${issued.error}`)
  const t = JSON.parse(readFileSync(join(r.common, 'handoffs', `${issued.ticket.id}.json`), 'utf8'))
  ok(JSON.stringify(Object.keys(t.params).sort()) === '["branch","sha","target"]', '交接單只帶三個參數')
  const shown = await git.render(host, r.common, issued.ticket.id, LOCAL)
  ok(shown.status === 'ready', `status ${shown.status}: ${shown.reason}`)
  ok(shown.steps[0].argv.join(' ') === `git -C ${r.repo} merge --ff-only ${r.c1}`, shown.steps[0].argv.join(' '))
  ok(sh(r.repo, 'rev-parse', 'main') === r.c0, '執行前 main 不動')
  const res = await press(r.common, issued.ticket.id, shown)
  ok(res.outcome === 'passed', `outcome ${res.outcome}: ${res.summary}`)
  ok(sh(r.repo, 'rev-parse', 'main') === r.c1, 'main 已快轉')
  ok(readFileSync(join(r.repo, 'a.txt'), 'utf8') === 'a\n', '持有者工作樹已更新')
  ok(sh(r.repo, 'status', '--porcelain') === '', '持有者工作樹乾淨')
  ok(!readdirSync(join(r.common, 'handoffs')).some(n => n.endsWith('.lock')), '鎖已釋放')
  ok((await git.listTickets(host, r.common)).length === 0, '落地後不再待辦')
  const again = await press(r.common, issued.ticket.id, shown)
  ok(/無需再執行/.test(again.summary), '已落地的單再按不會重寫結果')
  return r
})

it('無持有者版：main 沒被 checkout 時用 update-ref（帶舊值）', async () => {
  const r = setup()
  sh(r.repo, 'switch', '-q', '--detach')
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const shown = await git.render(host, r.common, issued.ticket.id, LOCAL)
  ok(shown.status === 'ready', shown.reason)
  ok(shown.steps[0].argv.includes('update-ref') && shown.steps[0].argv.at(-1) === r.c0, shown.steps[0].argv.join(' '))
  const res = await press(r.common, issued.ticket.id, shown)
  ok(res.outcome === 'passed', res.summary)
  ok(sh(r.repo, 'rev-parse', 'main') === r.c1, 'main 已更新')
  return r
})

it('分支在簽發後又前進：stale，零寫入', async () => {
  const r = setup()
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  commit(r.wt, 'b.txt', 'b\n')
  const shown = await git.render(host, r.common, issued.ticket.id, LOCAL)
  ok(shown.status === 'stale', shown.status)
  const res = await press(r.common, issued.ticket.id, shown)
  ok(res.outcome === 'stale', res.outcome)
  ok(sh(r.repo, 'rev-parse', 'main') === r.c0, 'main 沒動')
  return r
})

it('main 在畫面之後被別人推進：mismatch，零寫入', async () => {
  const r = setup()
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const shown = await git.render(host, r.common, issued.ticket.id, LOCAL)
  sh(r.repo, 'switch', '-q', '--detach')
  const res = await press(r.common, issued.ticket.id, shown)
  ok(res.outcome === 'stale' && /畫面與重新檢查的內容不同/.test(res.summary), res.summary)
  ok(sh(r.repo, 'rev-parse', 'main') === r.c0, 'main 沒動')
  return r
})

it('持有者有重疊的未 commit 變更：blocked；無重疊則放行', async () => {
  const r = setup()
  writeFileSync(join(r.repo, 'a.txt'), 'local\n')
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const blocked = await git.render(host, r.common, issued.ticket.id, LOCAL)
  ok(blocked.status === 'blocked' && /a\.txt/.test(blocked.reason), blocked.reason)
  rmSync(join(r.repo, 'a.txt'))
  writeFileSync(join(r.repo, 'notes.txt'), 'x\n')
  const shown = await git.render(host, r.common, issued.ticket.id, LOCAL)
  ok(shown.status === 'ready', shown.reason)
  const res = await press(r.common, issued.ticket.id, shown)
  ok(res.outcome === 'passed', res.summary)
  ok(readFileSync(join(r.repo, 'notes.txt'), 'utf8') === 'x\n', '無關的未 commit 檔保留')
  return r
})

it('push 開啟：落地後 push 到 bare remote 並驗證；remote 分歧時 blocked', async () => {
  const r = setup()
  const remote = join(r.base, 'remote.git')
  sh(r.base, 'init', '-q', '--bare', '-b', 'main', remote)
  sh(r.repo, 'remote', 'add', 'origin', remote)
  sh(r.repo, 'push', '-q', 'origin', 'main')
  const cfg = { push: true, remote: 'origin' }
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const shown = await git.render(host, r.common, issued.ticket.id, cfg)
  ok(shown.status === 'ready' && shown.steps.length === 2, shown.reason)
  const res = await press(r.common, issued.ticket.id, shown, cfg)
  ok(res.outcome === 'passed', res.summary)
  ok(sh(remote, 'rev-parse', 'main') === r.c1, 'remote main 已前進')

  // 另一張單：remote 先被別人推進到本機沒有的 commit
  const c2 = commit(r.wt, 'b.txt', 'b\n')
  const other = join(r.base, 'other')
  sh(r.base, 'clone', '-q', remote, other)
  commit(other, 'z.txt', 'z\n')
  sh(other, 'push', '-q', 'origin', 'main')
  const t2 = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const shown2 = await git.render(host, r.common, t2.ticket.id, cfg)
  ok(shown2.status === 'blocked' && shown2.prechecks.some(c => c.name === 'P4' && !c.ok), JSON.stringify(shown2.prechecks))
  ok(sh(r.repo, 'rev-parse', 'main') === r.c1 && c2 !== r.c1, 'main 沒動')
  return r
})

it('簽發拒絕：無法快轉、已落地、不合法名稱', async () => {
  const r = setup()
  commit(r.repo, 'm.txt', 'm\n')
  const diverged = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  ok(!diverged.ok && /rebase/.test(diverged.error), diverged.error)
  for (const branch of ['-x', 'a:b', '--upload-pack=touch /tmp/pwned', 'refs/heads/main', 'nope']) {
    const res = await git.issue(host, r.wt, { branch, target: 'main', via: 'test' })
    ok(!res.ok, `應拒絕 ${branch}`)
  }
  const landed = await git.issue(host, r.wt, { branch: 'main', target: 'feature/x', via: 'test' })
  ok(!landed.ok, '已含的分支不簽發')
  return r
})

it('手寫交接單：夾帶的欄位被忽略，不合法參數判 invalid', async () => {
  const r = setup()
  const dir = join(r.common, 'handoffs')
  mkdirSync(dir, { recursive: true })
  const id = 'forged-1'
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ schema: 1, id, kind: 'ref-land', params: { branch: 'feature/x', target: 'main', sha: r.c1, argv: ['sh'] }, steps: [{ argv: ['touch', '/tmp/pwned'] }] }))
  const shown = await git.render(host, r.common, id, LOCAL)
  ok(shown.status === 'ready' && shown.steps.every(s => logic.argvAllowed(s.argv)), JSON.stringify(shown.steps))
  const bad = 'forged-2'
  writeFileSync(join(dir, `${bad}.json`), JSON.stringify({ schema: 1, id: bad, kind: 'ref-land', params: { branch: 'feature/x', target: '--upload-pack=x', sha: r.c1 } }))
  ok((await git.render(host, r.common, bad, LOCAL)).status === 'invalid', 'invalid')
  const traversal = await git.render(host, r.common, '../../etc/passwd', LOCAL)
  ok(traversal.status === 'invalid', 'id 不能跳出 handoffs/')
  return r
})

it('認領鎖：第二個認領失敗；逾時的鎖可強制接手', async () => {
  const r = setup()
  const issued = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const id = issued.ticket.id
  const a = await git.claim(host, r.common, id)
  const b = await git.claim(host, r.common, id)
  ok(a.ok && !b.ok, '同時只有一個認領')
  now += logic.LOCK_STALE_MS + 1
  const c = await git.claim(host, r.common, id)
  ok(c.ok && c.forced, '逾時鎖強制接手')
  await git.release(host, r.common, id)
  const d = await git.dismiss(host, r.common, id)
  ok(d.ok && (await git.render(host, r.common, id, LOCAL)).status === 'done', '撤單後為 done')
  return r
})

it('同分支再簽：同 commit 沿用、前進後取代舊單', async () => {
  const r = setup()
  const a = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  const b = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  ok(b.ok && b.reused && b.ticket.id === a.ticket.id, '沿用')
  commit(r.wt, 'b.txt', 'b\n')
  now += 1000
  const c = await git.issue(host, r.wt, { branch: 'feature/x', target: 'main', via: 'test' })
  ok(c.ok && c.superseded.includes(a.ticket.id), '取代')
  const open = await git.listTickets(host, r.common)
  ok(open.length === 1 && open[0].id === c.ticket.id, JSON.stringify(open))
  const cands = await git.candidates(host, r.common, 'main')
  ok(cands.length === 0, '已有待辦單的分支不再列為候選')
  return r
})

for (const [name, fn] of cases) {
  let r
  try {
    r = await fn()
    console.log(`(pass) ${name}`)
  } catch (err) {
    failed++
    console.log(`(fail) ${name}\n       ${err.message}`)
  } finally {
    if (r?.base) rmSync(r.base, { recursive: true, force: true })
  }
}
console.log(`\n ${cases.length - failed} pass\n ${failed} fail`)
process.exit(failed ? 1 : 0)
