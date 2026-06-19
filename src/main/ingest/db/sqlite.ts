import * as Str from "effect/String"
import { SqliteClient } from "@effect/sql-sqlite-node"

/**
 * Build the SqliteClient layer for our own store database.
 *
 * `transformQueryNames`/`transformResultNames` bridge camelCase row types
 * (what extractors produce) and the snake_case columns in the schema, so
 * `sql.insert({ nativeSessionId })` targets `native_session_id` and result rows
 * come back camelCased.
 *
 * The parent directory must already exist — better-sqlite3 will not create it.
 */
export const sqliteLayer = (filename: string) =>
  SqliteClient.layer({
    filename,
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel,
  })
