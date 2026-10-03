export type Region = 'frontal' | 'motor' | 'parietal' | 'occipital' | 'temporal' | 'cerebellum'

export type LogEntry = { region: Region; tool: string; detail: string }

export type Brain = {
  /** 動畫影格計數 */
  tick: number
  /** 各腦區活化程度 0–1，順序同 REGIONS */
  act: number[]
  /** context 用量 0–1 */
  fill: number
  tokens: number
  window: number
  /** compact 動畫開始的影格；null 表示沒在睡 */
  sleepAt: number | null
  log: LogEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    'working-memory': { brain: Brain }
  }
}
