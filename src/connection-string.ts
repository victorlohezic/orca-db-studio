// Parses postgres://, postgresql://, mysql://, sqlserver:// and mssql:// URLs into the fields of
// the connection form. C2
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

/** Undefined when the text is not a connection string this plugin understands. */
export function parseConnectionString(text: string): ParsedConnectionString | undefined {
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
