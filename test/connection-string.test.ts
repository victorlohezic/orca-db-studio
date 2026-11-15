// Parsing a connection string: the forms each engine's tools hand out, and how each maps to an ssl mode. C2
import { describe, expect, test } from 'vitest'
import { parseConnectionString } from '../src/connection-string'

describe('parseConnectionString', () => {
  test('reads the parts of a postgres URL', () => {
    const parsed = parseConnectionString('postgres://app:s3cret@db.local:5433/shop')
    expect(parsed).toMatchObject({
      engine: 'postgres',
      host: 'db.local',
      port: 5433,
      database: 'shop',
      user: 'app',
      password: 's3cret',
    })
  })

  test('leaves ssl undefined when the URL says nothing about it', () => {
    expect(parseConnectionString('postgres://u:p@h:5432/db')?.ssl).toBeUndefined()
  })

  test.each(['require', 'prefer'])(
    'sslmode=%s encrypts without checking the certificate',
    (mode) => {
      expect(parseConnectionString(`postgres://u:p@h:5432/db?sslmode=${mode}`)?.ssl).toBe('require')
    },
  )

  test.each(['verify-ca', 'verify-full'])('sslmode=%s checks the certificate', (mode) => {
    expect(parseConnectionString(`postgres://u:p@h:5432/db?sslmode=${mode}`)?.ssl).toBe(
      'verify-full',
    )
  })

  test('sslmode=disable stays plain', () => {
    expect(parseConnectionString('postgres://u:p@h:5432/db?sslmode=disable')?.ssl).toBe('disable')
  })

  test('is undefined for a string this plugin does not understand', () => {
    expect(parseConnectionString('not a url')).toBeUndefined()
    expect(parseConnectionString('redis://h:6379')).toBeUndefined()
  })
})

describe('parseConnectionString for SQL Server URLs', () => {
  test('reads sqlserver:// and mssql:// like the other URLs', () => {
    expect(parseConnectionString('sqlserver://app:p%40ss@db.internal:1433/shop')).toEqual({
      engine: 'mssql',
      host: 'db.internal',
      port: 1433,
      database: 'shop',
      user: 'app',
      password: 'p@ss',
    })
    expect(parseConnectionString('mssql://sa@localhost/shop')).toMatchObject({
      engine: 'mssql',
      port: 1433,
      database: 'shop',
    })
  })

  test('reads the database from the query, as go-mssqldb writes it', () => {
    expect(parseConnectionString('sqlserver://sa@localhost?database=shop')?.database).toBe('shop')
  })

  test.each([
    ['?encrypt=true', 'verify-full'],
    ['?Encrypt=strict', 'verify-full'],
    ['?encrypt=true&TrustServerCertificate=true', 'require'],
    ['?trustServerCertificate=true', 'require'],
    ['?encrypt=false', 'disable'],
    ['?encrypt=optional', 'disable'],
    ['', undefined],
  ])('maps %s to ssl %s', (query, ssl) => {
    expect(parseConnectionString(`sqlserver://sa@localhost/shop${query}`)?.ssl).toBe(ssl)
  })
})

describe('parseConnectionString for SQL Server JDBC strings', () => {
  test('reads a JDBC string with its properties, keys in any case', () => {
    expect(
      parseConnectionString(
        'jdbc:sqlserver://billing.database.windows.net:1433;database=billing;user=reader;password=s3cret;encrypt=strict;hostNameInCertificate=*.database.windows.net;loginTimeout=30;',
      ),
    ).toEqual({
      engine: 'mssql',
      host: 'billing.database.windows.net',
      port: 1433,
      database: 'billing',
      user: 'reader',
      password: 's3cret',
      ssl: 'verify-full',
    })
    expect(
      parseConnectionString(
        'jdbc:sqlserver://localhost:14330;DatabaseName=app;UserName=sa;Password=pw;Encrypt=false',
      ),
    ).toEqual({
      engine: 'mssql',
      host: 'localhost',
      port: 14330,
      database: 'app',
      user: 'sa',
      password: 'pw',
      ssl: 'disable',
    })
  })

  test.each([
    [';encrypt=true', 'verify-full'],
    [';encrypt=true;trustServerCertificate=true', 'require'],
    [';TRUSTSERVERCERTIFICATE=TRUE', 'require'],
    [';encrypt=false;trustServerCertificate=true', 'disable'],
    ['', undefined],
  ])('maps %s to ssl %s', (props, ssl) => {
    expect(parseConnectionString(`jdbc:sqlserver://db:1433;database=app${props}`)?.ssl).toBe(ssl)
  })

  test('takes the default port, and the host or port from properties', () => {
    expect(parseConnectionString('jdbc:sqlserver://db;database=app')?.port).toBe(1433)
    expect(
      parseConnectionString('jdbc:sqlserver://;serverName=db2;portNumber=1500;database=app'),
    ).toMatchObject({ host: 'db2', port: 1500 })
    expect(parseConnectionString('jdbc:sqlserver://[::1]:1433;database=app')?.host).toBe('::1')
  })

  test('reads a password in braces, which may hold semicolons and braces', () => {
    expect(
      parseConnectionString('jdbc:sqlserver://db;user=sa;password={p;w}}d};database=app')?.password,
    ).toBe('p;w}d')
  })

  test("reads Prisma's sqlserver:// form, with properties after semicolons", () => {
    expect(
      parseConnectionString('sqlserver://db:1433;database=app;user=sa;password=pw;encrypt=true'),
    ).toMatchObject({ host: 'db', port: 1433, database: 'app', user: 'sa', ssl: 'verify-full' })
  })

  test('refuses what is not a SQL Server string', () => {
    expect(parseConnectionString('jdbc:postgresql://db:5432/app')).toBeUndefined()
    expect(parseConnectionString('jdbc:sqlserver://;database=app')).toBeUndefined()
  })
})
