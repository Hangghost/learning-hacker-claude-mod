// dispatch-board 的資料型別與 $.state 契約。
// 一份 mission 檔 → BoardMission；每個節點附上「完成條件求值」與「session 名冊對照」的結果。

/** 完成條件求值：退出碼 0＝完成；指令跑不起來或逾時＝無法判定（不併入「還沒完成」） */
export type NodeEval =
  | { kind: 'done' }
  | { kind: 'open'; exitCode: number }
  | { kind: 'unknown'; reason: string }

/**
 * 節點負責的 session 在名冊上的樣子。
 * - live：在 `claude agents --json` 名冊上（工作中／閒置／blocked）
 * - gone：本 session 之前看過它活著，現在名冊上沒有＝已結束
 * - absent：名冊上沒有，也沒看過（還沒開，或在看板啟動前就結束了）
 * - unavailable：名冊讀不到；SHALL NOT 畫成已結束
 * - none：節點沒指定 session
 */
export type SessionView =
  | { kind: 'live'; state: 'working' | 'idle' | 'blocked'; startedAt: number | null }
  | { kind: 'gone' }
  | { kind: 'absent' }
  | { kind: 'unavailable' }
  | { kind: 'none' }

export type BoardNode = {
  id: string
  title: string
  /** session 名稱；空字串＝沒指定 */
  session: string
  /** 完成條件（shell 指令） */
  done: string
  depends_on: string[]
  eval: NodeEval
  live: SessionView
}

export type BoardMission = {
  mission_id: string
  title: string
  /** mission 檔的絕對路徑（已解析符號連結） */
  file: string
  nodes: BoardNode[]
}

/** 讀不了的 mission 檔：檔名＋原因 */
export type BadFile = { file: string; reason: string }

export type BoardSnapshot = {
  /** mission 目錄（顯示用，家目錄縮寫成 ~） */
  dir: string
  roster: { available: boolean; note: string }
  missions: BoardMission[]
  bad: BadFile[]
}

declare module 'claude-code' {
  interface PluginState {
    'dispatch-board': {
      isPaneOpen: boolean
      /** /dispatch off 之後為 true：本 session 不再輪詢 */
      isPaused: boolean
      /** demo 模式：用假資料畫面，不讀 mission 目錄、不執行任何指令 */
      isDemo: boolean
      snapshot: BoardSnapshot | null
      lastOkAt: number | null
      /** 目錄被拒或讀不了的原因；null＝正常 */
      failure: string | null
      /** 節點鍵 → 開始 blocked 的時間（名冊沒有這個時間，只能靠快照比對） */
      blockedSince: Record<string, number>
      /** session 名稱（正規化）→ 最近一次在名冊上看到它的時間 */
      seenSessions: Record<string, number>
      /** 每個計時器 tick 寫入一次，只為讓「N 秒前」重繪 */
      tickAt: number
    }
  }
}
