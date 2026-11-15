import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { MssqlConfig, Session, SslMode } from '../../src/drivers'
import { loadDriver } from '../../src/drivers'
import { driverContract } from './contract'

const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest'
/** Seconds of waiting that a cancel or a timeout interrupts with an error. */
const SLOW = "WAITFOR DELAY '00:00:20'"

async function fetchAll(session: Session, sql: string, queryId = crypto.randomUUID()) {
  const cursor = await session.query(sql, { queryId })
  try {
    return { columns: cursor.columns, rows: await cursor.fetch(1000) }
  } finally {
    await cursor.close()
  }
}

describe(IMAGE, () => {
  let container: StartedMSSQLServerContainer
  let admin: Session
  let database = ''

  function config(overrides: Partial<MssqlConfig> = {}): MssqlConfig {
    return {
      engine: 'mssql',
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      ...overrides,
    }
  }

  async function connect(overrides: Partial<MssqlConfig> = {}): Promise<Session> {
    const driver = await loadDriver('mssql')
    return driver.connect(config(overrides), container.getPassword())
  }

  beforeAll(async () => {
    container = await new MSSQLServerContainer(IMAGE).acceptLicense().start()
    admin = await connect()
  }, 300_000)

  afterAll(async () => {
    await admin?.close()
    await container?.stop()
  })

  /** A session on a database of its own, so every test starts empty. */
  async function open(): Promise<Session> {
    database = `db_${crypto.randomUUID().replaceAll('-', '')}`
    await fetchAll(admin, `CREATE DATABASE ${database}`)
    return connect({ database })
  }

  /** Requests running on the server whose text contains `text`, other than the lookup itself. */
  async function activeQueries(text: string): Promise<number> {
    const { rows } = await fetchAll(
      admin,
      `SELECT COUNT(*) FROM sys.dm_exec_requests r
        CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE r.session_id <> @@SPID AND t.text LIKE '%${text}%'`,
    )
    return Number(rows[0]?.[0])
  }

  driverContract(IMAGE, {
    open,
    schema: 'dbo',
    slowQuery: SLOW,
    dropConnection: {
      idQuery: 'SELECT @@SPID',
      async kill(id) {
        await fetchAll(admin, `KILL ${Number(id)}`)
      },
    },
  })

  describe(`${IMAGE} driver`, () => {
    let session: Session

    beforeAll(async () => {
      session = await open()
    }, 60_000)

    afterAll(async () => {
      await session.close()
    })

    test('names its SQL dialect for the editor', () => {
      expect(session.dialect).toBe('mssql')
    })

    test('previews a table with SELECT TOP', () => {
      expect(session.tableQuery('dbo', 'orders', 100)).toBe('SELECT TOP 100 * FROM [dbo].[orders]')
    })

    test('returns values the way the other engines do', async () => {
      const { columns, rows } = await fetchAll(
        session,
        `SELECT CAST(9007199254740993 AS BIGINT) AS big, CAST(12.50 AS DECIMAL(10, 2)) AS num,
                CAST(12.5 AS MONEY) AS cash, CAST('2024-03-05' AS DATE) AS d,
                CAST('2024-03-05 06:07:08.1234567' AS DATETIME2) AS dt2,
                CAST('2024-03-05 06:07:08.997' AS DATETIME) AS dt,
                CAST('2024-03-05 06:07:00' AS SMALLDATETIME) AS sdt,
                CAST('2024-03-05 06:07:08 +02:00' AS DATETIMEOFFSET(0)) AS dto,
                CAST('06:07:08.5' AS TIME) AS t, 0xDEADBEEF AS bin,
                CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS UNIQUEIDENTIFIER) AS id,
                CAST(1 AS BIT) AS flag, N'héllo ✓' AS txt, CAST(NULL AS INT) AS nothing`,
      )
      expect(columns).toEqual([
        { name: 'big', type: 'bigint' },
        { name: 'num', type: 'decimal' },
        { name: 'cash', type: 'money' },
        { name: 'd', type: 'date' },
        { name: 'dt2', type: 'datetime2' },
        { name: 'dt', type: 'datetime' },
        { name: 'sdt', type: 'smalldatetime' },
        { name: 'dto', type: 'datetimeoffset' },
        { name: 't', type: 'time' },
        { name: 'bin', type: 'varbinary' },
        { name: 'id', type: 'uniqueidentifier' },
        { name: 'flag', type: 'bit' },
        { name: 'txt', type: 'nvarchar' },
        { name: 'nothing', type: 'int' },
      ])
      expect(rows[0]).toEqual([
        '9007199254740993',
        '12.50',
        '12.5000',
        '2024-03-05',
        '2024-03-05T06:07:08.1234567',
        '2024-03-05T06:07:08.997',
        '2024-03-05T06:07:00',
        '2024-03-05T04:07:08.000Z',
        '06:07:08.5',
        '<blob 4 B>',
        '6F9619FF-8B86-D011-B42D-00C04FC964FF',
        true,
        'héllo ✓',
        null,
      ])
    })

    test('a failing statement rejects with the database error', async () => {
      await expect(
        session.query('SELECT * FROM missing_table', { queryId: 'bad' }),
      ).rejects.toThrow(/missing_table/)
      expect((await fetchAll(session, 'SELECT 1')).rows).toHaveLength(1)
    })

    test('keeps the first result of a batch that returns several', async () => {
      const { columns, rows } = await fetchAll(session, 'SELECT 1 AS a SELECT 2 AS b, 3 AS c')
      expect(columns.map((c) => c.name)).toEqual(['a'])
      expect(rows).toEqual([[1]])
      expect((await fetchAll(session, 'SELECT 4 AS d')).rows).toEqual([[4]])
    })

    test('quotes identifiers holding a closing bracket', async () => {
      const table = session.quoteIdent('odd ]name[')
      await fetchAll(session, `CREATE TABLE ${table} (id INT)`)
      await fetchAll(session, `INSERT INTO ${table} (id) VALUES (7)`)
      expect((await fetchAll(session, `SELECT id FROM ${table}`)).rows).toEqual([[7]])
    })

    test('runs one request at a time: a catalog read waits for an open cursor', async () => {
      const cursor = await session.query(
        'SELECT TOP 5000 a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b',
        { queryId: 'busy' },
      )
      const listing = session.listObjects()
      expect(await cursor.fetch(10)).toHaveLength(10)
      await cursor.close()
      expect((await listing).schemas.some((s) => s.name === 'dbo')).toBe(true)
    })

    test('a large result is streamed, not buffered', async () => {
      const before = process.memoryUsage().rss
      await fetchAll(session, 'CREATE TABLE digits (n INT)')
      await fetchAll(session, 'INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)')
      // A billion rows if read to the end.
      const cursor = await session.query(
        "SELECT REPLICATE('x', 200) AS pad FROM digits a, digits b, digits c, digits d, digits e, digits f, digits g, digits h, digits i",
        { queryId: 'large' },
      )
      for (let i = 0; i < 3; i++) expect(await cursor.fetch(1000)).toHaveLength(1000)
      await cursor.close()
      expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024)
      await expect.poll(() => activeQueries('digits a, digits b')).toBe(0)
      expect((await fetchAll(session, 'SELECT 1')).rows).toHaveLength(1)
    }, 60_000)

    test('cancel stops the query on the server', async () => {
      const failure = session
        .query(`${SLOW} /* cancel_marker */`, { queryId: 'cancel-me' })
        .then((cursor) => cursor.fetch(1))
        .then(
          () => undefined,
          (error: Error) => error,
        )
      await expect.poll(() => activeQueries('cancel_marker')).toBe(1)
      await session.cancel('cancel-me')
      expect((await failure)?.message).toBe('Query cancelled')
      await expect.poll(() => activeQueries('cancel_marker')).toBe(0)
    }, 30_000)

    test('a timeout ends the query on the server', async () => {
      await expect(
        session
          .query(`${SLOW} /* timeout_marker */`, { queryId: 'timeout', timeoutMs: 500 })
          .then((cursor) => cursor.fetch(1)),
      ).rejects.toThrow('Query timed out after 0.5 seconds')
      await expect.poll(() => activeQueries('timeout_marker')).toBe(0)
      // The timeout belongs to that query only.
      const slow = await fetchAll(session, "WAITFOR DELAY '00:00:01'; SELECT 3")
      expect(slow.rows).toEqual([[3]])
    }, 30_000)
  })

  describe(`${IMAGE} encryption`, () => {
    test.each<SslMode>(['disable', 'require'])('connects with ssl %s', async (ssl) => {
      const session = await connect({ ssl })
      try {
        const { rows } = await fetchAll(
          session,
          'SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID',
        )
        expect(rows).toEqual([[ssl === 'require' ? 'TRUE' : 'FALSE']])
      } finally {
        await session.close()
      }
    })

    test('verify-full refuses the self-signed certificate', async () => {
      await expect(connect({ ssl: 'verify-full' })).rejects.toThrow(/certificate/i)
    })
  })
})
