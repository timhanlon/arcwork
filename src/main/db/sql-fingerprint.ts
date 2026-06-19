/**
 * Cheap, value-free description of a compiled SQL statement for span attributes
 * and threshold logs. The SQL handed to a {@link file://./../../node_modules/effect/src/unstable/sql/SqlConnection.ts}
 * `Connection` is already compiled: parameters are `?` placeholders, never
 * literal values. So fingerprinting the statement text cannot leak row data —
 * we only normalise whitespace and read the leading keyword / first table.
 */
export interface SqlShape {
  /** `SELECT` | `INSERT` | `UPDATE` | `DELETE` | `BEGIN` | … (upper-cased leading keyword). */
  readonly operation: string
  /** Primary table when cheaply parseable from the leading clause, else undefined. */
  readonly table: string | undefined
  /** Whitespace-collapsed statement text (placeholders only — safe to log). */
  readonly fingerprint: string
}

const TABLE_BY_OP: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)/i, (m) => m[1]!],
  [/^\s*DELETE\s+FROM\s+["'`]?(\w+)/i, (m) => m[1]!],
  [/^\s*UPDATE\s+["'`]?(\w+)/i, (m) => m[1]!],
  [/^\s*SELECT\b[\s\S]*?\bFROM\s+["'`]?(\w+)/i, (m) => m[1]!],
]

const MAX_FINGERPRINT = 200

/**
 * Parse a compiled SQL string into its operation, primary table, and a
 * truncated single-line fingerprint. Pure and allocation-light: this runs on
 * every statement, so it stays to a leading-keyword read plus one table regex.
 */
export const describeSql = (sql: string): SqlShape => {
  const collapsed = sql.replace(/\s+/g, " ").trim()
  const opMatch = collapsed.match(/^["'`]?(\w+)/)
  const operation = (opMatch?.[1] ?? "UNKNOWN").toUpperCase()

  let table: string | undefined
  for (const [re, pick] of TABLE_BY_OP) {
    const m = collapsed.match(re)
    if (m) {
      table = pick(m)
      break
    }
  }

  const fingerprint =
    collapsed.length > MAX_FINGERPRINT ? `${collapsed.slice(0, MAX_FINGERPRINT)}…` : collapsed
  return { operation, table, fingerprint }
}
