// dispatch-relay 的型別契約：身份判定的結果與轉送訊息的 part 值域。
// 本 mod 不使用 `$.state`（日誌走 `$.ui.log`、持久狀態走 `$.store`），故無 PluginState。

/** 轉送訊息首行 `parts=` 的值域。改動屬 BREAKING（指揮站端若要解析訊息，以此為接縫）。 */
export type Part = 'result-full' | 'result-append' | 'final-reply'

/** 已啟用 session 的節點身份。`station` 是 mission 檔寫的名稱；session id 每次送件前由名冊解析，不快取。 */
export type Identity = { missionId: string; nodeId: string; station: string; resultFile: string }

/**
 * 身份判定的結果。
 * - match：恰好一個節點的 `session` 是本 session 的名稱，且該 mission 有 `station`
 * - no-missions：mission 目錄不存在或沒有可讀的 mission 檔
 * - no-relay：沒有任何 mission 寫 station（不讀名冊就能確定不啟用）
 * - none：有選用 relay 的 mission，但沒有節點指派給本 session（`name` 是本 session 的名稱）
 * - ambiguous：多個節點都指派給本 session
 * - no-station：唯一匹配，但 mission 沒有 `station`（沒有選用 relay）
 * - self-station：唯一匹配，但 `station` 就是本 session
 * - unavailable：mission 目錄被拒讀、名冊不可用、取不到 session id 等
 */
export type Resolution =
  | { kind: 'match'; identity: Identity }
  | { kind: 'no-missions' }
  | { kind: 'no-relay' }
  | { kind: 'none'; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'no-station'; missionId: string; nodeId: string }
  | { kind: 'self-station'; missionId: string; nodeId: string }
  | { kind: 'unavailable'; reason: string }
