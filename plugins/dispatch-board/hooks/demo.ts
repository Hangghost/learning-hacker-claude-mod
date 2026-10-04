// demo 模式的假資料：錄影與還沒有 mission 時試看用。不讀目錄、不執行任何指令。
// 每次輪詢往下一格，停在最後一格；格與格之間的差異會跳出對應的 toast。

import type { BoardMission, BoardNode, BoardSnapshot, NodeEval, SessionView } from '../types'

const T0 = Date.UTC(2026, 9, 4, 1, 0, 0)

const done: NodeEval = { kind: 'done' }
const open: NodeEval = { kind: 'open', exitCode: 1 }
const working = (minutesAgo: number): SessionView => ({ kind: 'live', state: 'working', startedAt: T0 - minutesAgo * 60000 })
const idle: SessionView = { kind: 'live', state: 'idle', startedAt: T0 }
const blocked: SessionView = { kind: 'live', state: 'blocked', startedAt: T0 }

function node(id: string, title: string, session: string, ev: NodeEval, live: SessionView, depends_on: string[] = []): BoardNode {
  return { id, title, session, done: `git -C ~/code/shop log --oneline main | grep -q '\\[${id}-done\\]'`, depends_on, eval: ev, live }
}

function launch(nodes: BoardNode[]): BoardMission {
  return { mission_id: 'shop-redesign', title: '商店改版', file: '/home/demo/.claude/missions/shop-redesign.json', nodes }
}

const docsDone: BoardMission = {
  mission_id: 'docs-cleanup',
  title: '文件整理',
  file: '/home/demo/.claude/missions/docs-cleanup.json',
  nodes: [
    node('api-docs', 'API 文件', 'docs-api', done, idle),
    node('guide', '使用指南', 'docs-guide', done, { kind: 'gone' }),
  ],
}

const base = { dir: '~/.claude/missions', roster: { available: true, note: '' }, bad: [] }

export const DEMO_SNAPSHOTS: readonly BoardSnapshot[] = [
  {
    ...base,
    missions: [
      launch([
        node('api', '後端 API', 'shop-api', open, working(12)),
        node('web', '前端頁面', 'shop-web', open, blocked),
        node('e2e', '端對端測試', 'shop-e2e', open, { kind: 'absent' }, ['api', 'web']),
      ]),
      docsDone,
    ],
  },
  {
    ...base,
    missions: [
      launch([
        node('api', '後端 API', 'shop-api', done, idle),
        node('web', '前端頁面', 'shop-web', open, working(3)),
        node('e2e', '端對端測試', 'shop-e2e', open, { kind: 'absent' }, ['api', 'web']),
      ]),
      docsDone,
    ],
  },
  {
    ...base,
    missions: [
      launch([
        node('api', '後端 API', 'shop-api', done, idle),
        node('web', '前端頁面', 'shop-web', done, idle),
        node('e2e', '端對端測試', 'shop-e2e', { kind: 'unknown', reason: '逾時 5s' }, working(1), ['api', 'web']),
      ]),
      docsDone,
    ],
    bad: [{ file: '/home/demo/.claude/missions/draft.json', reason: 'e2e.done 缺少（完成條件指令）' }],
  },
  {
    ...base,
    missions: [
      launch([
        node('api', '後端 API', 'shop-api', done, idle),
        node('web', '前端頁面', 'shop-web', done, idle),
        node('e2e', '端對端測試', 'shop-e2e', done, idle, ['api', 'web']),
      ]),
      docsDone,
    ],
    bad: [{ file: '/home/demo/.claude/missions/draft.json', reason: 'e2e.done 缺少（完成條件指令）' }],
  },
]
