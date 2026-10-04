// handoff-runner 的型別契約：交接單、結果檔的 JSON 形狀，與 $.state 的值。

/** 交接單只帶這三個參數。沒有路徑、沒有指令：步驟由 mod 依參數推導。 */
export type Params = {
  /** 要落地的分支 */
  branch: string
  /** 目標分支（通常是 main） */
  target: string
  /** 簽發當下 branch 的 commit，落地只會把 target 快轉到這個 commit */
  sha: string
}

export type Ticket = {
  schema: 1
  id: string
  kind: 'ref-land'
  created_at: string
  issuer: { via: string }
  params: Params
}

export type Check = { name: string; ok: boolean; detail: string }

export type Step = {
  name: string
  label: string
  argv: string[]
  /** 已經是完成狀態，按下時略過 */
  done_already: boolean
  detail: string
}

export type Status = 'ready' | 'stale' | 'blocked' | 'invalid' | 'done'

export type Outcome = 'passed' | 'failed' | 'stale' | 'blocked' | 'dismissed'

export type StepRow = { name: string; ran: boolean; exit_code: number | null; stderr_tail: string }

export type Result = {
  schema: 1
  id: string
  outcome: Outcome
  summary: string
  finished_at: string
  forced_stale_lock: boolean
  steps: StepRow[]
  checks: Check[]
  history: string[]
}

export type Rendered = {
  id: string
  status: Status
  title: string
  prechecks: Check[]
  steps: Step[]
  /** 步驟名稱與 argv 的正規化字串；畫面與按下時重新推導的結果必須逐字相同 */
  fingerprint: string
  reason: string
  last_result: Result | null
}

export type Aborted = null | 'stale' | 'blocked' | 'mismatch'

export type StepLog = { name: string; ran: boolean; exit_code?: number | null; stderr?: string }

export type RunLog = { aborted: Aborted; forced_stale_lock: boolean; steps: StepLog[] }

export type TicketRow = {
  id: string
  title: string
  created_at?: string
  params?: Params
  outcome?: Outcome | null
  summary?: string | null
  error?: string
}

/** 面板手動簽發的候選：被 worktree 持有、可快轉進目標、還沒有待辦單的分支 */
export type Candidate = { branch: string; sha: string; target: string; worktree: string }

declare module 'claude-code' {
  interface PluginState {
    'handoff-runner': {
      tickets: TicketRow[] | null
      failure: string | null
      rendered: Record<string, Rendered>
      running: Record<string, boolean>
      candidates: Candidate[]
      isPaneOpen: boolean
    }
  }
}
