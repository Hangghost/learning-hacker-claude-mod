import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Brain, LogEntry, Region } from '../types'

// ── 腦區與工具的對應（比喻，不是神經科學主張）────────────────────────
const REGIONS: Region[] = ['frontal', 'motor', 'parietal', 'occipital', 'temporal', 'cerebellum']

const INFO: Record<Region, { name: string; role: string; color: string }> = {
  frontal: { name: '額葉', role: '規劃', color: 'magenta' },
  motor: { name: '運動皮質', role: '動手改', color: 'yellow' },
  parietal: { name: '頂葉', role: '操作環境', color: 'green' },
  occipital: { name: '枕葉', role: '閱讀', color: 'cyan' },
  temporal: { name: '顳葉', role: '聽外界', color: 'blue' },
  cerebellum: { name: '小腦', role: '分身協作', color: 'white' },
}

const regionOfTool = (tool: string): Region => {
  if (/^(Read|Grep|Glob|NotebookRead|LS)$/.test(tool)) return 'occipital'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'motor'
  if (/^(WebFetch|WebSearch)$/.test(tool) || tool.startsWith('mcp__')) return 'temporal'
  if (/^(Agent|Task|SendMessage)$/.test(tool)) return 'cerebellum'
  if (/^(TaskCreate|TaskUpdate|TodoWrite|Skill|EnterPlanMode|ExitPlanMode)$/.test(tool)) return 'frontal'
  return 'parietal'
}

// ── 腦的形狀：側面圖，左邊是前額 ─────────────────────────────────────
const W = 46
const H = 15
const TICK_MS = 100
const DECAY = 0.86
const SLEEP_TICKS = 28

type Cell = { region: Region | 'stem'; u: number; seed: number }

const hash = (n: number) => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

const MAP: (Cell | null)[][] = Array.from({ length: H }, (_, y) =>
  Array.from({ length: W }, (_, x) => {
    const u = (x + 0.5) / W
    const v = (y + 0.5) / H
    const seed = y * W + x
    // 大腦：外緣加一點起伏，像腦回
    const dx = (u - 0.47) / 0.46
    const dy = (v - 0.4) / 0.38
    const wobble = 1 + 0.05 * Math.sin(Math.atan2(dy, dx) * 9)
    const inCerebrum = dx * dx + dy * dy <= wobble * wobble
    // 小腦與腦幹
    const cx = (u - 0.77) / 0.15
    const cy = (v - 0.8) / 0.17
    const inCerebellum = cx * cx + cy * cy <= 1
    const inStem = u > 0.57 && u < 0.65 && v > 0.7
    if (inCerebrum) {
      // 外側溝與中央溝留白，讓腦區分得出來
      const sylvian = Math.abs(v - (0.62 - (u - 0.2) * 0.25)) < 0.035 && u > 0.2 && u < 0.62
      const central = Math.abs(u - (0.42 + (v - 0.1) * 0.12)) < 0.012 && v < 0.55
      if (sylvian || central) return null
      let region: Region
      if (v > 0.6 - (u - 0.2) * 0.25 && u > 0.2 && u < 0.74) region = 'temporal'
      else if (u < 0.42 + (v - 0.1) * 0.12 - 0.09) region = 'frontal'
      else if (u < 0.42 + (v - 0.1) * 0.12) region = 'motor'
      else if (u > 0.76) region = 'occipital'
      else region = 'parietal'
      return { region, u, seed }
    }
    if (inCerebellum) return { region: 'cerebellum', u, seed }
    if (inStem) return { region: 'stem', u, seed }
    return null
  }),
)

// ── 狀態 ─────────────────────────────────────────────────────────────
const EMPTY: Brain = { tick: 0, act: REGIONS.map(() => 0), fill: 0, tokens: 0, window: 0, sleepAt: null, log: [] }
const brain = atom({ plugin: 'working-memory', key: 'brain' } as const, EMPTY)

const PANE = 'working-memory'

async function fire($: EngineInterface, region: Region, entry: LogEntry | null) {
  await update($, brain, b => ({
    ...b,
    act: b.act.map((a, i) => (REGIONS[i] === region ? 1 : a)),
    log: entry ? [...b.log, entry].slice(-6) : b.log,
  }))
}

async function measure($: EngineInterface, c: SessionContextUsage) {
  if (c.percent === undefined || c.tokens === undefined) return
  const { percent, tokens, window } = c
  await update($, brain, b => ({ ...b, fill: percent / 100, tokens, window }))
}

let ticking = false

// 每一格：活化衰減、推進睡眠動畫；沒有東西在動就不重畫
async function step($: EngineInterface) {
  if (ticking) return
  ticking = true
  try {
    const b = await read($, brain)
    const isMoving = b.act.some(a => a > 0.02) || b.sleepAt !== null || b.fill >= 0.85
    if (!isMoving) return
    await update($, brain, cur => {
      const tick = cur.tick + 1
      const isAwake = cur.sleepAt !== null && tick - cur.sleepAt > SLEEP_TICKS
      return {
        ...cur,
        tick,
        act: cur.act.map(a => (a * DECAY < 0.02 ? 0 : a * DECAY)),
        sleepAt: isAwake ? null : cur.sleepAt,
      }
    })
  } finally {
    ticking = false
  }
}

// ── 畫面 ─────────────────────────────────────────────────────────────
type Run = { text: string; color?: string; bold?: boolean; dim?: boolean }

const paintCell = (cell: Cell | null, b: Brain): Run => {
  if (cell === null) return { text: ' ' }
  if (cell.region === 'stem') return { text: '▒', dim: true }

  // 睡眠：一道波從後腦掃到前額，掃過的地方清空
  if (b.sleepAt !== null) {
    const wave = 1 - (b.tick - b.sleepAt) / (SLEEP_TICKS * 0.8)
    const d = cell.u - wave
    if (Math.abs(d) < 0.04) return { text: '✦', color: 'white', bold: true }
    if (d > 0) return { text: '·', color: 'blue', dim: true }
  }

  const color = INFO[cell.region].color
  const act = b.act[REGIONS.indexOf(cell.region)] ?? 0
  // 神經元放電：活化越強，同時閃的格子越多，每一格隨影格隨機
  if (act > 0.02 && hash(cell.seed * 31 + b.tick) < act * 0.85) {
    return { text: act > 0.55 ? '█' : '▓', color, bold: true }
  }
  // 記憶佔用：用量多少，就有多少比例的格子被填滿
  if (hash(cell.seed) < b.fill) {
    const isOverload = b.fill >= 0.85 && b.tick % 8 < 4
    return { text: '░', color: isOverload ? 'red' : color }
  }
  return { text: '·', dim: true }
}

const runsOf = (cells: Run[]): Run[] =>
  cells.reduce<Run[]>((acc, c) => {
    const last = acc[acc.length - 1]
    if (last && last.color === c.color && last.bold === c.bold && last.dim === c.dim) {
      last.text += c.text
    } else acc.push({ ...c })
    return acc
  }, [])

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const mood = (b: Brain) =>
  b.sleepAt !== null
    ? '睡眠中：整理記憶…'
    : b.fill >= 0.85
      ? '過載！快要需要睡一覺（compact）'
      : b.fill >= 0.6
        ? '有點擁擠'
        : '清醒、專注'

const detailOf = (e: Record<string, unknown>): string => {
  const raw = e.file_path ?? e.command ?? e.pattern ?? e.url ?? e.query ?? e.description ?? e.skill ?? ''
  const s = String(raw).replace(/\s+/g, ' ')
  const short = s.includes('/') && !s.includes(' ') ? (s.split('/').pop() ?? s) : s
  return short.length > 36 ? short.slice(0, 35) + '…' : short
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'brain', description: '打開工作記憶腦圖' })
    const { context } = await $.session.usage()
    await measure($, context)
    $.clock.every(TICK_MS, () => void step($))
    return next(e)
  })

  on('command.run', { command: 'brain' }, async $ => {
    await $.ui.open({ id: PANE, title: '工作記憶 · Working Memory' })
    return { text: '工作記憶腦圖已打開。' }
  })

  on('prompt.submit', async ($, e, next) => {
    await fire($, 'frontal', { region: 'frontal', tool: '思考', detail: '收到新任務' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const region = regionOfTool(e.tool)
    await fire($, region, { region, tool: e.tool.replace(/^mcp__[^_]+__/, ''), detail: detailOf(e as Record<string, unknown>) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await measure($, e.context)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger !== 'precompute') {
      await update($, brain, b => ({ ...b, sleepAt: b.tick }))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, brain)
    const pct = Math.round(b.fill * 100)
    const barCells = 20
    const filled = Math.round(b.fill * barCells)
    const barColor = b.fill >= 0.85 ? 'red' : b.fill >= 0.6 ? 'yellow' : 'green'

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>工作記憶 </Text>
          <Text color={barColor}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barCells - filled)}</Text>
          <Text bold color={barColor}> {pct}%</Text>
          <Text dimColor> {b.window > 0 ? `${fmt(b.tokens)}/${fmt(b.window)}` : ''}</Text>
        </Box>
        <Text dimColor>狀態：{mood(b)}</Text>
        <Text> </Text>
        {MAP.map((row, y) => (
          <Box key={`row${y}`}>
            {runsOf(row.map(cell => paintCell(cell, b))).map((r, i) => (
              <Text key={`r${y}-${i}`} color={r.color} bold={r.bold} dimColor={r.dim}>
                {r.text}
              </Text>
            ))}
          </Box>
        ))}
        <Text> </Text>
        <Box flexDirection="column">
          {[REGIONS.slice(0, 3), REGIONS.slice(3)].map((group, gi) => (
            <Box key={`legend${gi}`}>
              {group.map(r => {
                const isLit = (b.act[REGIONS.indexOf(r)] ?? 0) > 0.3
                return (
                  <Text key={`lg-${r}`} color={INFO[r].color} bold={isLit} dimColor={!isLit}>
                    {isLit ? '● ' : '○ '}
                    {INFO[r].name}·{INFO[r].role}
                    {'   '}
                  </Text>
                )
              })}
            </Box>
          ))}
        </Box>
        <Text> </Text>
        <Text dimColor>最近的神經活動</Text>
        {b.log.length === 0 && <Text dimColor>（還沒有活動）</Text>}
        {b.log.map((l, i) => (
          <Box key={`log${i}`}>
            <Text color={INFO[l.region].color} bold={i === b.log.length - 1}>
              {i === b.log.length - 1 ? '▸ ' : '  '}
              {INFO[l.region].name.padEnd(4, '　')}
            </Text>
            <Text> {l.tool}</Text>
            <Text dimColor> {l.detail}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
