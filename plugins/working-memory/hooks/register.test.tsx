import { describe, expect, test } from 'claude-code/testing'

// 代替引擎
const engine = (on: any) => {
  on('session.measure', (_$: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

const PANE = { plugin: 'working-memory', component: 'Pane', requestId: 'working-memory', props: {} } as const

describe('working-memory', () => {
  test('讀檔點亮枕葉，並寫進活動紀錄', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Read', file_path: '/repo/rules/SOUL.md' } as any)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect(await ui.find({ type: 'Text', text: /枕葉/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /SOUL\.md/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /● 枕葉·閱讀/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('改檔點亮運動皮質、Bash 點亮頂葉', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Edit', file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } as any)
    await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /● 運動皮質·動手改/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● 頂葉·操作環境/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /git status/ })).toBeDefined()
    await ui.unmount()
  })

  test('用量 90% 顯示過載', async ($, on) => {
    engine(on)
    await $.session.measure({ context: { tokens: 900_000, window: 1_000_000, percent: 90 }, rateLimits: [], changed: ['context'] } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: / 90%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /過載/ })).toBeDefined()
    await ui.unmount()
  })
})
