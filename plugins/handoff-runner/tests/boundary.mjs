// 邊界靜態檢查：`node plugins/handoff-runner/tests/boundary.mjs`
//
// plugin test 驗證「沒按就不執行」的行為；這裡驗證「程式碼裡沒有別的入口」：
// - register.tsx 不送 prompt、不派 subagent、不呼叫 model、不 spawn。
// - register.tsx 的 `$.process.run` 只有四種：host 的 `['git', ...args]`（唯讀，由 git.ts 的 roGit 把關）、
//   `['mkdir', path]`、`['rmdir', path]`，以及 runTicket 裡執行步驟的 `argv`。
// - runTicket 只從按鈕的 onPress 呼叫。
// - git.ts 只在 roGit 裡呼叫 host.git，白名單不含任何寫入型子命令；logic.ts 不碰 `$`。
//
// 每條規則附 known-positive：把違規片段注入原始碼，偵測器必須抓到。

import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(`../hooks/${name}`, import.meta.url), 'utf8')
const SOURCES = { register: read('register.tsx'), git: read('git.ts'), logic: read('logic.ts') }

const stripComments = s => s.replace(/^\s*\/\/.*$/gm, '')

function body(source, name) {
  const m = new RegExp(`async function ${name}\\(`).exec(source)
  if (!m) return ''
  const start = source.indexOf('{', source.indexOf(')', m.index))
  let depth = 0
  for (let j = start; j < source.length; j++) {
    depth += source[j] === '{' ? 1 : source[j] === '}' ? -1 : 0
    if (depth === 0) return source.slice(start, j + 1)
  }
  return source.slice(start)
}

const FORBIDDEN = {
  '\\$\\.prompt\\.submit': '以使用者名義送 prompt',
  '\\$\\.agent\\b': '派 subagent',
  '\\$\\.model\\b': '呼叫 model',
  '\\$\\.process\\.spawn': '使用 $.process.spawn',
  '\\$\\.session\\.(send|message)|SendMessage': '傳訊給 session',
}

const WRITE_SUBCOMMANDS = ['merge', 'update-ref', 'push', 'fetch', 'branch', 'checkout', 'switch', 'reset', 'commit', 'tag', 'config', 'rebase', 'pull', 'gc', 'prune', 'clean', 'stash', 'am', 'apply']

export function violations({ register, git, logic }) {
  const out = []
  const reg = stripComments(register)
  for (const [pat, why] of Object.entries(FORBIDDEN)) if (new RegExp(pat).test(reg)) out.push(`register.tsx：${why}`)

  const run = body(reg, 'runTicket')
  if (!run) out.push('找不到 runTicket')
  const calls = [...reg.matchAll(/\$\.process\.run\(\s*(\[[^\]]*\]|[^,)]+)/g)]
  for (const m of calls) {
    const arg = m[1].trim()
    if (arg === "['git', ...args]" || arg === "['mkdir', path]" || arg === "['rmdir', path]") continue
    if (arg === 'argv' && run.includes(m[0])) continue
    out.push(`register.tsx：未預期的 $.process.run(${arg})`)
  }
  if (!run.includes('$.process.run(argv')) out.push('runTicket 內找不到唯一的執行點')
  if (reg.split('$.process.run(argv').length !== 2) out.push('$.process.run(argv 出現不只一次')

  const outside = run ? reg.replace(run, '') : reg
  const uses = [...outside.matchAll(/(?<!function )\brunTicket\(/g)]
  if (uses.length === 0) out.push('runTicket 沒有任何按鈕呼叫點')
  for (const m of uses) {
    const line = outside.slice(outside.lastIndexOf('\n', m.index) + 1, outside.indexOf('\n', m.index))
    if (!line.includes('onPress')) out.push(`runTicket 在 onPress 以外被呼叫：${line.trim()}`)
  }

  const g = stripComments(git)
  const ro = body(g, 'roGit')
  if (!ro.includes('host.git(')) out.push('roGit 不經 host.git')
  if (g.split('host.git(').length !== 2) out.push('git.ts 在 roGit 以外呼叫 host.git')
  const list = /READONLY_GIT[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(g)?.[1] ?? ''
  for (const sub of WRITE_SUBCOMMANDS) if (new RegExp(`'${sub}'`).test(list)) out.push(`唯讀白名單含寫入型子命令：${sub}`)
  if (/\$\.|process\.run|child_process/.test(g)) out.push('git.ts 直接碰 $ 或 process')

  if (/\$\.|process\.run|child_process|host\./.test(stripComments(logic))) out.push('logic.ts 不該碰 $、process 或 host')
  return out
}

const KNOWN_POSITIVES = {
  送prompt: s => ({ ...s, register: s.register + "\nfunction x($) { $.prompt.submit({ text: 'go' }) }\n" }),
  計時器觸發執行: s => ({ ...s, register: s.register.replace('$.clock.every(TICK_MS, () => refresh($))', '$.clock.every(TICK_MS, () => { refresh($); void runTicket($, "x") })') }),
  工具觸發執行: s => ({ ...s, register: s.register.replace("const r = await issueText($, e.branch, e.target, 'tool')", "const r = await issueText($, e.branch, e.target, 'tool'); await runTicket($, 'x')") }),
  runTicket外執行argv: s => ({ ...s, register: s.register + '\nasync function y($, argv) { await $.process.run(argv) }\n' }),
  任意程式: s => ({ ...s, register: s.register + "\nasync function z($) { await $.process.run(['sh', '-c', 'x']) }\n" }),
  白名單加push: s => ({ ...s, git: s.git.replace("'rev-parse',", "'rev-parse',\n  'push',") }),
  roGit外呼叫git: s => ({ ...s, git: s.git + "\nexport async function w(host) { return host.git(['push'], '/') }\n" }),
}

let failed = 0
const base = violations(SOURCES)
if (base.length) {
  failed++
  console.log(`(fail) 原始碼有邊界違規：\n       ${base.join('\n       ')}`)
} else {
  console.log('(pass) 原始碼沒有邊界違規')
}
for (const [label, mutate] of Object.entries(KNOWN_POSITIVES)) {
  const mutated = mutate(SOURCES)
  const changed = Object.keys(SOURCES).some(k => mutated[k] !== SOURCES[k])
  const caught = changed && violations(mutated).length > 0
  if (!caught) failed++
  console.log(`(${caught ? 'pass' : 'fail'}) known-positive：${label}${changed ? '' : '（注入沒有套用）'}`)
}
console.log(`\n ${1 + Object.keys(KNOWN_POSITIVES).length - failed} pass\n ${failed} fail`)
process.exit(failed ? 1 : 0)
