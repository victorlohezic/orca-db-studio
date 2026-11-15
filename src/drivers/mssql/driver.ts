// SQL Server driver: tedious, one connection per session (ADR 0006). Rows are handed over as they
// arrive and the request is paused once enough are waiting, so a large result never piles up in
// memory. A connection runs one request at a time, so requests wait for their turn. Cancel and
// timeout send an attention on the same connection: SQL Server has no statement timeout of its own.
import type { ConnectionConfiguration } from 'tedious'
import type { ConnectionConfig, MssqlConfig } from '../common/config'
import type { ColumnMeta, Driver, QueryCursor, QueryOptions, Row, Session } from '../common/driver'
import { type ColumnRow, type ColumnTree, groupColumns, type SchemaTree } from '../common/schema'
import { formatSeconds, formatSize } from '../common/utils'

type TediousModule = typeof import('../../../vendor/tedious.js')
type TediousConnection = InstanceType<TediousModule['Connection']>
type TediousRequest = InstanceType<TediousModule['Request']>

/** Rows held back from the socket before the request is paused. */
const QUEUE_LIMIT = 1000
/** Fixed database role schemas (db_owner, db_datareader, ...): never hold tables in practice. */
const ROLE_SCHEMAS = 'BETWEEN 16384 AND 16399'
/** Sorts names by code point, as the other engines do, whatever the database's collation. */
const BINARY = 'COLLATE Latin1_General_BIN2'

/** What tedious says about a result column; only the parts read here. */
interface ColumnInfo {
  colName: string
  type: { name: string }
  dataLength?: number
  scale?: number
}

interface ColumnValue {
  value: unknown
}

/** time, datetime2 and datetimeoffset carry their digits past the millisecond on the Date. */
type TediousDate = Date & { nanosecondsDelta?: number }

/** tedious's variable-length types, named for their size as SQL Server names them. */
const SIZED_TYPES: Record<string, Record<number, string>> = {
  IntN: { 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' },
  FloatN: { 4: 'real', 8: 'float' },
  MoneyN: { 4: 'smallmoney', 8: 'money' },
  DateTimeN: { 4: 'smalldatetime', 8: 'datetime' },
}
const NULLABLE_TYPES: Record<string, string> = {
  BitN: 'bit',
  DecimalN: 'decimal',
  NumericN: 'numeric',
}

function typeName(column: ColumnInfo): string {
  const { name } = column.type
  const sized = SIZED_TYPES[name]
  if (sized) return sized[column.dataLength ?? 0] ?? name.slice(0, -1).toLowerCase()
  return NULLABLE_TYPES[name] ?? name.toLowerCase()
}

/** How a column's values are written out, decided once per result. */
interface Converter {
  type: string
  /** Digits after the decimal point for exact numbers, or after the second for times. */
  scale: number
}

function converterOf(column: ColumnInfo): Converter {
  const type = typeName(column)
  switch (type) {
    case 'money':
    case 'smallmoney':
      return { type, scale: 4 }
    case 'datetime':
      return { type, scale: 3 }
    case 'smalldatetime':
      return { type, scale: 0 }
    default:
      return { type, scale: column.scale ?? 0 }
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** The fraction of a second, to the column's scale, without trailing zeros. */
function fraction(date: TediousDate, converter: Converter): string {
  let ms = date.getUTCMilliseconds()
  // datetime counts 1/300 s; tedious truncates it to the millisecond (.997 reads as 996).
  if (converter.type === 'datetime') ms = Math.min(999, Math.round(Math.round(ms * 0.3) / 0.3))
  const ticks = ms * 10_000 + Math.round((date.nanosecondsDelta ?? 0) * 1e7)
  const digits = pad(ticks, 7).slice(0, converter.scale).replace(/0+$/, '')
  return digits ? `.${digits}` : ''
}

function timeText(date: TediousDate, converter: Converter): string {
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  return `${time}${fraction(date, converter)}`
}

/**
 * Dates as the other engines give them: ISO text without a zone for local times, UTC for
 * datetimeoffset. tedious reads them in UTC (`useUTC`), so the UTC fields are the stored ones.
 */
function dateText(date: TediousDate, converter: Converter): string {
  if (converter.type === 'datetimeoffset') return date.toISOString()
  if (converter.type === 'time') return timeText(date, converter)
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return converter.type === 'date' ? day : `${day}T${timeText(date, converter)}`
}

/**
 * Exact numbers as text, never a rounded JS number: bigint already is text; decimal, numeric and
 * money reach here as numbers, which tedious has already rounded past 15 significant digits.
 */
function exactText(value: number, converter: Converter): string {
  return Math.abs(value) < 1e21 ? value.toFixed(converter.scale) : String(value)
}

function convert(value: unknown, converter: Converter): unknown {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return `<blob ${formatSize(value.length)}>`
  if (value instanceof Date) return dateText(value, converter)
  if (typeof value === 'number') {
    switch (converter.type) {
      case 'decimal':
      case 'numeric':
      case 'money':
      case 'smallmoney':
        return exactText(value, converter)
    }
  }
  return value
}

function connectTo(
  tedious: TediousModule,
  config: ConnectionConfiguration,
): Promise<TediousConnection> {
  return new Promise((resolve, reject) => {
    const connection = new tedious.Connection(config)
    // A connection the server dropped must not crash the worker; `closed` then says so.
    connection.on('error', () => undefined)
    connection.connect((error?: Error) => {
      if (!error) return resolve(connection)
      connection.close()
      reject(error)
    })
  })
}

/** What a statement is doing on the server: the rows that arrived, or why it ended. */
interface Statement {
  request: TediousRequest
  columns: ColumnMeta[]
  /** Rows changed, read once the statement has ended. */
  rowCount: number
  queue: Row[]
  settled: boolean
  failure: Error | undefined
  /** Why the statement is being stopped, which its failure then reports. */
  stopReason: Error | undefined
  /** Set once the caller no longer wants rows; they are dropped as they arrive. */
  discarding: boolean
  /** Called when something above changes. */
  changed: (() => void) | undefined
}

function failureOf(error: Error & { code?: string }): Error {
  switch (error.code) {
    case 'ECANCEL':
      return new Error('Query cancelled', { cause: error })
    // tedious only runs requests on a logged-in connection; a dropped one is in its final state.
    case 'EINVALIDSTATE':
      return new Error('The connection to SQL Server was lost', { cause: error })
    default:
      return error
  }
}

/**
 * Starts the statement and resolves once the server has described its first result, or once it
 * has ended when it returns none. A batch may return several results: the first one is kept, as
 * the other engines run one statement per call.
 *
 * `onSettled` may run before this returns: tedious fails a request at once, inside `execSql`, when
 * the connection is not logged in. It gets the statement for that reason.
 */
function startStatement(
  tedious: TediousModule,
  connection: TediousConnection,
  sql: string,
  onSettled: (statement: Statement) => void,
): { statement: Statement; described: Promise<void> } {
  let converters: Converter[] | undefined
  let laterResult = false
  const notify = () => statement.changed?.()

  let describe: () => void = () => undefined
  let refuse: (error: Error) => void = () => undefined
  const described = new Promise<void>((resolve, reject) => {
    describe = resolve
    refuse = reject
  })

  const request = new tedious.Request(sql, (error, rowCount) => {
    statement.rowCount = rowCount ?? 0
    if (error) statement.failure = statement.stopReason ?? failureOf(error)
    statement.settled = true
    onSettled(statement)
    if (statement.failure) refuse(statement.failure)
    else describe()
    notify()
  })
  const statement: Statement = {
    request,
    columns: [],
    rowCount: 0,
    queue: [],
    settled: false,
    failure: undefined,
    stopReason: undefined,
    discarding: false,
    changed: undefined,
  }

  request.on('columnMetadata', (columns) => {
    if (converters) {
      laterResult = true
      return
    }
    const infos = (Array.isArray(columns) ? columns : Object.values(columns)) as ColumnInfo[]
    converters = infos.map(converterOf)
    statement.columns = infos.map((info, i) => ({
      name: info.colName,
      type: converters?.[i]?.type ?? info.type.name,
    }))
    describe()
  })
  request.on('row', (values: ColumnValue[]) => {
    if (statement.discarding || laterResult || !converters) return
    const using = converters
    statement.queue.push(values.map((column, i) => convert(column.value, using[i] as Converter)))
    if (statement.queue.length >= QUEUE_LIMIT) request.pause()
    notify()
  })
  connection.execSql(request)
  return { statement, described }
}

/** Lets the request deliver more, then waits until the statement has news. */
function waitForChange(statement: Statement): Promise<void> {
  statement.request.resume()
  return new Promise((resolve) => {
    statement.changed = resolve
  })
}

/** Stops a statement that is still running; its failure then says why. */
function stopStatement(connection: TediousConnection, statement: Statement, reason: Error): void {
  if (statement.settled) return
  statement.stopReason ??= reason
  connection.cancel()
}

class MssqlSession implements Session {
  readonly dialect = 'mssql'

  #connection: TediousConnection
  /** Settles once the request before the next one has ended. */
  #idle: Promise<void> = Promise.resolve()
  /** The query whose statement is on the server, which cancel may stop. */
  #running: { queryId: string; statement: Statement } | undefined

  constructor(
    private readonly tedious: TediousModule,
    connection: TediousConnection,
  ) {
    this.#connection = connection
  }

  get closed(): boolean {
    return this.#connection.closed
  }

  /** Waits for the request ahead to end; the returned function lets the next one go. */
  async #turn(): Promise<() => void> {
    const ahead = this.#idle
    let release: () => void = () => undefined
    this.#idle = new Promise((resolve) => {
      release = resolve
    })
    await ahead
    return release
  }

  /** Every row of a small catalog query, as arrays of values. */
  async #all(sql: string): Promise<unknown[][]> {
    const release = await this.#turn()
    try {
      const { statement, described } = startStatement(this.tedious, this.#connection, sql, () => {})
      await described
      while (!statement.settled) await waitForChange(statement)
      if (statement.failure) throw statement.failure
      return statement.queue
    } finally {
      release()
    }
  }

  async listObjects(): Promise<SchemaTree> {
    const rows = await this.#all(
      `SELECT s.name, o.name, RTRIM(o.type)
         FROM sys.schemas s
         LEFT JOIN sys.objects o
           ON o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
          AND s.schema_id NOT ${ROLE_SCHEMAS}
          AND (s.name <> 'guest' OR o.object_id IS NOT NULL)
        ORDER BY s.name ${BINARY}, o.name ${BINARY}`,
    )
    const schemas = new Map<string, SchemaTree['schemas'][number]>()
    for (const [schema, name, kind] of rows as [string, string | null, string | null][]) {
      let node = schemas.get(schema)
      if (!node) {
        node = { name: schema, objects: [] }
        schemas.set(schema, node)
      }
      if (name) node.objects.push({ name, kind: kind === 'V' ? 'view' : 'table' })
    }
    return { schemas: [...schemas.values()] }
  }

  async listColumns(): Promise<ColumnTree> {
    const rows = await this.#all(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA ${BINARY}, TABLE_NAME ${BINARY}, ORDINAL_POSITION`,
    )
    const columns: ColumnRow[] = (rows as [string, string, string][]).map(
      ([schema, name, column]) => ({ schema, name, column }),
    )
    // The login's default schema, usually dbo; null when the database has no user for it.
    const [current] = await this.#all('SELECT SCHEMA_NAME()')
    return { defaultSchema: (current?.[0] as string | null) ?? '', tables: groupColumns(columns) }
  }

  async query(sql: string, opts: QueryOptions): Promise<QueryCursor> {
    const release = await this.#turn()
    const connection = this.#connection
    let clearTimer: () => void = () => undefined
    const { statement, described } = startStatement(this.tedious, connection, sql, (settled) => {
      clearTimer()
      if (this.#running?.statement === settled) this.#running = undefined
      release()
    })
    // A statement that failed at once is over: nothing to cancel or time out.
    if (!statement.settled) this.#running = { queryId: opts.queryId, statement }
    // The statement's whole life counts: running it, and every fetch until it ends.
    const timeoutMs = opts.timeoutMs ?? 0
    if (!statement.settled && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timer = setTimeout(() => {
        const reason = new Error(`Query timed out after ${formatSeconds(timeoutMs)}`)
        stopStatement(connection, statement, reason)
      }, timeoutMs)
      timer.unref()
      clearTimer = () => clearTimeout(timer)
    }
    await described

    return {
      columns: statement.columns,
      affectedRows: statement.columns.length === 0 ? statement.rowCount : undefined,
      async fetch(count: number): Promise<Row[]> {
        while (!statement.failure && statement.queue.length < count && !statement.settled) {
          await waitForChange(statement)
        }
        if (statement.failure) throw statement.failure
        const rows = statement.queue.splice(0, count)
        if (statement.queue.length < QUEUE_LIMIT) statement.request.resume()
        return rows
      },
      async close() {
        statement.discarding = true
        statement.queue.length = 0
        // The connection is busy until the server has sent the rest, so stop the statement first.
        stopStatement(connection, statement, new Error('Query closed'))
        while (!statement.settled) await waitForChange(statement)
      },
    }
  }

  async cancel(queryId: string): Promise<void> {
    const running = this.#running
    if (running?.queryId !== queryId) return
    stopStatement(this.#connection, running.statement, new Error('Query cancelled'))
  }

  quoteIdent(name: string): string {
    return `[${name.replaceAll(']', ']]')}]`
  }

  tableQuery(schema: string, table: string, limit: number): string {
    return `SELECT TOP ${limit} * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)}`
  }

  async close(): Promise<void> {
    const connection = this.#connection
    // A connection the server dropped is already closed and never ends again.
    if (connection.closed) return
    await new Promise<void>((resolve) => {
      connection.once('end', () => resolve())
      connection.close()
    })
  }
}

/**
 * tedious takes `encrypt` and `trustServerCertificate` rather than Node's TLS options (ADR 0006).
 * `disable` still trusts the certificate: SQL Server encrypts the login packet even then, often
 * with a self-signed certificate.
 */
function encryption(config: MssqlConfig): { encrypt: boolean; trustServerCertificate: boolean } {
  switch (config.ssl) {
    case 'verify-full':
      return { encrypt: true, trustServerCertificate: false }
    case 'require':
      return { encrypt: true, trustServerCertificate: true }
    default:
      return { encrypt: false, trustServerCertificate: true }
  }
}

function connectionConfig(
  config: MssqlConfig,
  secret: string | undefined,
): ConnectionConfiguration {
  return {
    server: config.host,
    authentication: { type: 'default', options: { userName: config.user, password: secret } },
    options: {
      port: config.port,
      database: config.database || undefined,
      ...encryption(config),
      // Timeouts are the session's own, per query.
      requestTimeout: 0,
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
      useUTC: true,
    },
  }
}

export const mssqlDriver: Driver = {
  async connect(config: ConnectionConfig, secret: string | undefined): Promise<Session> {
    if (config.engine !== 'mssql') throw new Error(`Not a SQL Server connection: ${config.engine}`)
    const tedious = await import('../../../vendor/tedious.js')
    const connection = await connectTo(tedious, connectionConfig(config, secret))
    return new MssqlSession(tedious, connection)
  },
}
