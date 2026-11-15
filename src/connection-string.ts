// Parses postgres://, postgresql://, mysql://, sqlserver:// and mssql:// URLs, and SQL Server's
// JDBC strings, into the fields of the connection form. C2
import type { SslMode } from './drivers'
import type { ServerEngine } from './protocol'

export const DEFAULT_PORTS: Record<ServerEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
}

export interface ParsedConnectionString {
  engine: ServerEngine
  host: string
  port: number
  database: string
  user: string
  password: string
  /** Where the string asked to encrypt, when it did. */
  ssl?: SslMode
}

const SCHEMES: Record<string, ServerEngine> = {
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
  'mysql:': 'mysql',
  'sqlserver:': 'mssql',
  'mssql:': 'mssql',
}

const TRUE_VALUES = new Set(['true', 'yes', '1', 'strict', 'mandatory'])

/**
 * SQL Server's `encrypt` and `trustServerCertificate`, as the three modes the form offers.
 * `strict` (TDS 8) and `mandatory` encrypt; `optional` does not. Without `encrypt`, today's
 * drivers encrypt, so a trusted certificate alone still means `require`.
 */
function mssqlSsl(encrypt: string | undefined, trust: string | undefined): SslMode | undefined {
  const trusted = TRUE_VALUES.has(trust?.trim().toLowerCase() ?? '')
  if (encrypt === undefined) return trusted ? 'require' : undefined
  if (!TRUE_VALUES.has(encrypt.trim().toLowerCase())) return 'disable'
  return trusted ? 'require' : 'verify-full'
}

/**
 * libpq's sslmode, as the three modes: `disable` stays plain, `verify-ca` and `verify-full` check
 * the certificate, and every other value (allow, prefer, require) encrypts without checking it.
 */
function postgresSsl(sslmode: string | undefined): SslMode | undefined {
  if (sslmode === undefined) return undefined
  if (sslmode === 'disable') return 'disable'
  return sslmode.startsWith('verify-') ? 'verify-full' : 'require'
}

/** How each engine's URL says it wants encryption; an engine missing here has no way yet. */
const SSL_PARAMS: Partial<
  Record<ServerEngine, (params: Map<string, string>) => SslMode | undefined>
> = {
  postgres: (params) => postgresSsl(params.get('sslmode')),
  mssql: (params) => mssqlSsl(params.get('encrypt'), params.get('trustservercertificate')),
}

/** The URL's query, keys lowercased: SQL Server's own keys are case-insensitive. */
function lowerParams(url: URL): Map<string, string> {
  return new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]))
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * `key=value` pairs split at semicolons, keys lowercased. A value in braces may hold semicolons,
 * and `}}` in it is one brace, as the JDBC driver reads them.
 */
function properties(text: string): Map<string, string> {
  const found = new Map<string, string>()
  let i = 0
  while (i < text.length) {
    const equals = text.indexOf('=', i)
    const semicolon = text.indexOf(';', i)
    if (equals === -1 || (semicolon !== -1 && semicolon < equals)) {
      i = semicolon === -1 ? text.length : semicolon + 1
      continue
    }
    const key = text.slice(i, equals).trim().toLowerCase()
    let value = ''
    i = equals + 1
    if (text.slice(i).trimStart().startsWith('{')) {
      i = text.indexOf('{', i) + 1
      while (i < text.length) {
        if (text[i] === '}' && text[i + 1] === '}') {
          value += '}'
          i += 2
        } else if (text[i] === '}') {
          i++
          break
        } else {
          value += text[i++]
        }
      }
      const end = text.indexOf(';', i)
      i = end === -1 ? text.length : end + 1
    } else {
      const end = text.indexOf(';', i)
      value = text.slice(i, end === -1 ? text.length : end).trim()
      i = end === -1 ? text.length : end + 1
    }
    if (key) found.set(key, value)
  }
  return found
}

/** `jdbc:sqlserver://host[:port];key=value;...`, and Prisma's form without the `jdbc:`. */
const SEMICOLON_FORM = /^(?:jdbc:sqlserver|sqlserver|mssql):\/\/([^;]*)(;.*)?$/is
/** The address before the first semicolon: a host, maybe in brackets, and a port. */
const ADDRESS = /^(\[[^\]]*\]|[^:@/?]*)(?::(\d+))?$/

/** A SQL Server string with its properties after semicolons. */
function parseSemicolonForm(text: string): ParsedConnectionString | undefined {
  const match = SEMICOLON_FORM.exec(text)
  const jdbc = /^jdbc:/i.test(text)
  // Without `jdbc:` and a semicolon, it is a URL: sqlserver://user:password@host/database.
  if (!match || (!jdbc && match[2] === undefined)) return undefined
  const address = ADDRESS.exec(match[1] ?? '')
  if (!address) return undefined
  const props = properties(match[2] ?? '')
  const host = (props.get('servername') ?? address[1] ?? '').replace(/^\[(.*)\]$/, '$1')
  if (!host) return undefined
  const port = Number(props.get('portnumber') ?? props.get('port') ?? address[2])
  const ssl = mssqlSsl(props.get('encrypt'), props.get('trustservercertificate'))
  return {
    engine: 'mssql',
    host,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORTS.mssql,
    database: props.get('databasename') ?? props.get('database') ?? '',
    user: props.get('user') ?? props.get('username') ?? '',
    password: props.get('password') ?? '',
    ...(ssl ? { ssl } : {}),
  }
}

/** Undefined when the text is not a connection string this plugin understands. */
export function parseConnectionString(text: string): ParsedConnectionString | undefined {
  const semicolonForm = parseSemicolonForm(text.trim())
  if (semicolonForm) return semicolonForm
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return undefined
  }
  const engine = SCHEMES[url.protocol]
  if (!engine || !url.hostname) return undefined
  const params = lowerParams(url)
  // go-mssqldb's form names the database in the query: sqlserver://host?database=shop.
  const database = decode(url.pathname.replace(/^\//, '')) || (params.get('database') ?? '')
  const ssl = SSL_PARAMS[engine]?.(params)
  return {
    engine,
    host: decode(url.hostname.replace(/^\[(.*)\]$/, '$1')),
    port: url.port ? Number(url.port) : DEFAULT_PORTS[engine],
    database,
    user: decode(url.username),
    password: decode(url.password),
    ...(ssl ? { ssl } : {}),
  }
}
