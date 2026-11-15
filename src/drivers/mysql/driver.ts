// MySQL/MariaDB driver: mysql2's callback API, which hands rows over as they arrive (the promise
// API buffers whole results). Cancel runs KILL QUERY from a second connection; a timeout is the
// server's own limit, so the server ends the query itself.
import type { ConnectionOptions, FieldPacket } from 'mysql2'
import type { ConnectionConfig, MysqlConfig } from '../common/config'
import type { ColumnMeta, Driver, QueryCursor, QueryOptions, Row, Session } from '../common/driver'
import { type ColumnRow, type ColumnTree, groupColumns, type SchemaTree } from '../common/schema'
import { formatSize } from '../common/utils'

type MysqlModule = typeof import('../../../vendor/mysql2.js')
type MysqlConnection = ReturnType<MysqlModule['mysql']['createConnection']>

/** Rows held back from the socket before it is paused, so a large result never piles up in memory. */
const QUEUE_LIMIT = 1000
/** ER_QUERY_INTERRUPTED: what the killed statement fails with. */
const ER_QUERY_INTERRUPTED = 1317
const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']

function callbackQuery<T>(connection: MysqlConnection, sql: string): Promise<T> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error: Error | null, result: unknown) => {
      if (error) reject(error)
      else resolve(result as T)
    })
  })
}

function connectTo(
  mysql: MysqlModule['mysql'],
  options: ConnectionOptions,
): Promise<MysqlConnection> {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection(options)
    // A connection the server dropped must not crash the worker; `closed` then says so.
    connection.on('error', () => undefined)
    connection.connect((error: Error | null) => {
      if (error) reject(error)
      else resolve(connection)
    })
  })
}

function endQuietly(connection: MysqlConnection): Promise<void> {
  return new Promise((resolve) => connection.end(() => resolve()))
}

/** mysql2 marks an error fatal when the connection is gone, and closes it for good. */
function isFatal(error: unknown): boolean {
  return (error as { fatal?: boolean } | null)?.fatal === true
}

function failureOf(error: Error & { errno?: number }): Error {
  return error.errno === ER_QUERY_INTERRUPTED
    ? new Error('Query cancelled', { cause: error })
    : error
}

interface ResultHeader {
  affectedRows?: number
}

/** What a statement is doing on the server: the rows that arrived, or why it ended. */
interface Statement {
  columns: ColumnMeta[]
  affectedRows: number | undefined
  queue: Row[]
  settled: boolean
  failure: Error | undefined
  /** Set once the caller no longer wants rows; they are dropped as they arrive. */
  discarding: boolean
  /** Called when something above changes. */
  changed: (() => void) | undefined
}

/** Starts the statement and resolves once the server has described its result (or failed). */
function startStatement(
  mysql: MysqlModule['mysql'],
  connection: MysqlConnection,
  sql: string,
  onSettled: (error?: Error) => void,
): Promise<Statement> {
  const state: Statement = {
    columns: [],
    affectedRows: undefined,
    queue: [],
    settled: false,
    failure: undefined,
    discarding: false,
    changed: undefined,
  }
  const typeNames = new Map(Object.entries(mysql.Types).map(([name, code]) => [code, name]))
  const timestamps: boolean[] = []
  const notify = () => state.changed?.()

  function convert(values: unknown[]): Row {
    return values.map((value, i) => {
      if (Buffer.isBuffer(value)) return `<blob ${formatSize(value.length)}>`
      // The other engines write a date and a time as one ISO string.
      if (timestamps[i] && typeof value === 'string') return value.replace(' ', 'T')
      return value
    })
  }

  return new Promise((resolve, reject) => {
    const query = connection.query({ sql, rowsAsArray: true })
    query.on('fields', (fields: FieldPacket[] | undefined) => {
      state.columns = (fields ?? []).map((field) => ({
        name: field.name,
        type: (typeNames.get(field.columnType) ?? String(field.columnType)).toLowerCase(),
      }))
      for (const [i, field] of (fields ?? []).entries()) {
        timestamps[i] =
          field.columnType === mysql.Types.DATETIME || field.columnType === mysql.Types.TIMESTAMP
      }
      resolve(state)
    })
    query.on('result', (row: unknown[] | ResultHeader) => {
      if (state.discarding) return
      if (Array.isArray(row)) {
        state.queue.push(convert(row))
        if (state.queue.length >= QUEUE_LIMIT) connection.pause()
      } else {
        state.affectedRows = row.affectedRows ?? 0
      }
      notify()
    })
    query.on('error', (error: Error) => {
      state.failure = failureOf(error)
      state.settled = true
      onSettled(error)
      reject(state.failure)
      notify()
    })
    query.on('end', () => {
      state.settled = true
      onSettled()
      notify()
    })
  })
}

/** Lets the socket deliver more, then waits until the statement has news. */
function waitForChange(connection: MysqlConnection, statement: Statement): Promise<void> {
  connection.resume()
  return new Promise((resolve) => {
    statement.changed = resolve
  })
}

class MysqlSession implements Session {
  readonly dialect: 'mysql' | 'mariadb'

  #connection: MysqlConnection
  #closed = false
  #timeoutMs = 0
  /** The query whose statement is on the server, which cancel may stop. */
  #running: string | undefined

  constructor(
    private readonly mysql: MysqlModule['mysql'],
    private readonly options: ConnectionOptions,
    connection: MysqlConnection,
    dialect: 'mysql' | 'mariadb',
  ) {
    this.#connection = connection
    this.dialect = dialect
    connection.on('end', () => {
      this.#closed = true
    })
    connection.on('error', (error: Error) => this.#noteFailure(error))
  }

  get closed(): boolean {
    return this.#closed
  }

  /** A fatal error, whether the connection or a command got it, means the connection is gone. */
  #noteFailure(error: unknown): void {
    if (isFatal(error)) this.#closed = true
  }

  /**
   * mysql2 reports a command sent on a closed connection to the connection, not to a query
   * without a callback, so a statement started now would wait forever.
   */
  #ensureOpen(): void {
    if (this.#closed) throw new Error('The connection to the server was lost')
  }

  async #call<T>(sql: string): Promise<T> {
    this.#ensureOpen()
    try {
      return await callbackQuery<T>(this.#connection, sql)
    } catch (error) {
      this.#noteFailure(error)
      throw error
    }
  }

  async listObjects(): Promise<SchemaTree> {
    const rows = await this.#call<{ db: string; name: string | null; kind: string | null }[]>(
      `SELECT s.schema_name AS db, t.table_name AS name, t.table_type AS kind
         FROM information_schema.schemata s
         LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
        WHERE s.schema_name NOT IN (${SYSTEM_SCHEMAS.map((name) => `'${name}'`).join(', ')})
        ORDER BY s.schema_name, BINARY t.table_name`,
    )
    const schemas = new Map<string, SchemaTree['schemas'][number]>()
    for (const row of rows) {
      let node = schemas.get(row.db)
      if (!node) {
        node = { name: row.db, objects: [] }
        schemas.set(row.db, node)
      }
      if (row.name)
        node.objects.push({ name: row.name, kind: row.kind === 'VIEW' ? 'view' : 'table' })
    }
    return { schemas: [...schemas.values()] }
  }

  async listColumns(): Promise<ColumnTree> {
    const rows = await this.#call<ColumnRow[]>(
      `SELECT c.table_schema AS \`schema\`, c.table_name AS name, c.column_name AS \`column\`
         FROM information_schema.columns c
        WHERE c.table_schema NOT IN (${SYSTEM_SCHEMAS.map((name) => `'${name}'`).join(', ')})
        ORDER BY c.table_schema, BINARY c.table_name, c.ordinal_position`,
    )
    // Null when the connection has no default database; nothing then completes unqualified.
    const [current] = await this.#call<{ schema: string | null }[]>('SELECT DATABASE() AS `schema`')
    return { defaultSchema: current?.schema ?? '', tables: groupColumns(rows) }
  }

  async #setTimeout(requested: number): Promise<void> {
    // Whole milliseconds; anything unusable means no timeout.
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 0
    if (timeoutMs === this.#timeoutMs) return
    // MySQL counts milliseconds and limits SELECT only; MariaDB counts seconds and limits any statement.
    const setting =
      this.dialect === 'mariadb'
        ? `max_statement_time = ${timeoutMs / 1000}`
        : `max_execution_time = ${timeoutMs}`
    await this.#call(`SET SESSION ${setting}`)
    this.#timeoutMs = timeoutMs
  }

  async query(sql: string, opts: QueryOptions): Promise<QueryCursor> {
    await this.#setTimeout(opts.timeoutMs ?? 0)
    this.#ensureOpen()
    const connection = this.#connection
    this.#running = opts.queryId
    const statement = await startStatement(this.mysql, connection, sql, (error) => {
      this.#noteFailure(error)
      if (this.#running === opts.queryId) this.#running = undefined
    })
    const kill = () => this.#killQuery()

    return {
      columns: statement.columns,
      affectedRows: statement.columns.length === 0 ? (statement.affectedRows ?? 0) : undefined,
      async fetch(count: number): Promise<Row[]> {
        while (!statement.failure && statement.queue.length < count && !statement.settled) {
          await waitForChange(connection, statement)
        }
        if (statement.failure) throw statement.failure
        const rows = statement.queue.splice(0, count)
        if (statement.queue.length < QUEUE_LIMIT) connection.resume()
        return rows
      },
      async close() {
        statement.discarding = true
        statement.queue.length = 0
        // The connection is busy until the server has sent the rest, so stop the statement first.
        if (!statement.settled) await kill().catch(() => undefined)
        while (!statement.settled) {
          await waitForChange(connection, statement)
        }
      },
    }
  }

  async #killQuery(): Promise<void> {
    const killer = await connectTo(this.mysql, this.options)
    try {
      await callbackQuery(killer, `KILL QUERY ${this.#connection.threadId}`)
    } finally {
      await endQuietly(killer)
    }
  }

  async cancel(queryId: string): Promise<void> {
    if (this.#running !== queryId) return
    await this.#killQuery()
  }

  quoteIdent(name: string): string {
    return `\`${name.replaceAll('`', '``')}\``
  }

  tableQuery(schema: string, table: string, limit: number): string {
    return `SELECT * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)} LIMIT ${limit}`
  }

  async close(): Promise<void> {
    // A connection that is gone never answers the goodbye.
    if (this.#closed) return
    this.#closed = true
    await endQuietly(this.#connection)
  }
}

/** Always utf8mb4: the server converts to it, so no other character set needs decoding in the bundle. */
function connectionOptions(config: MysqlConfig, secret: string | undefined): ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    database: config.database || undefined,
    user: config.user,
    password: secret,
    charset: 'UTF8MB4_UNICODE_CI',
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    jsonStrings: true,
  }
}

export const mysqlDriver: Driver = {
  async connect(config: ConnectionConfig, secret: string | undefined): Promise<Session> {
    if (config.engine !== 'mysql') throw new Error(`Not a MySQL connection: ${config.engine}`)
    const { mysql } = await import('../../../vendor/mysql2.js')
    const options = connectionOptions(config, secret)
    const connection = await connectTo(mysql, options)
    try {
      const rows = await callbackQuery<{ version: string }[]>(
        connection,
        'SELECT VERSION() AS version',
      )
      return new MysqlSession(
        mysql,
        options,
        connection,
        /mariadb/i.test(rows[0]?.version ?? '') ? 'mariadb' : 'mysql',
      )
    } catch (error) {
      await endQuietly(connection)
      throw error
    }
  },
}
