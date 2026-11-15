// A saved SQL Server connection end to end: the worker's requests against a real server (needs Docker).

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver'
import { mockHost, mountWorker } from 'orca/testing'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { loadDriver } from '../../src/drivers'
import * as worker from '../../src/worker/index'

let container: StartedMSSQLServerContainer
let root: string

beforeAll(async () => {
  container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .acceptLicense()
    .start()
  root = await mkdtemp(join(tmpdir(), 'db-studio-mssql-'))
  await mkdir(join(root, 'api'))
}, 300_000)

afterAll(async () => {
  await container?.stop()
  await rm(root, { recursive: true, force: true })
})

test('tests, saves, browses, queries and opens a table on a SQL Server connection', async () => {
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'w1',
            kind: 'worktree',
            name: 'api',
            path: join(root, 'api'),
            branch: 'main',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
      'editor.open': { opened: true },
    },
  })
  const w = await mountWorker(worker, { host })
  const form = {
    name: 'Container',
    engine: 'mssql' as const,
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    // The container's certificate is self-signed.
    ssl: 'require' as const,
  }
  const password = container.getPassword()

  await w.request('connection.test', { form, password })
  const { ref } = await w.request('connection.save', { form, password })
  expect(await w.request('connection.get', { ref })).toEqual({ form, hasPassword: true })
  const tree = await w.request('explorer.listObjects', { ref })
  expect(tree.schemas.map((s) => s.name)).toContain('dbo')
  expect(await w.request('connection.info', { ref })).toEqual({ dialect: 'mssql' })

  // TOP is the statement's own limit: the row limit (100) does not cut it.
  const top = await w.request('query.run', {
    ref,
    sql: 'SELECT TOP 150 a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b',
    documentId: 'd1',
  })
  expect(top.rows).toHaveLength(150)
  expect(top.truncated).toBe(false)

  // The server drops the session's connection, as a restart or an idle timeout would.
  /** The session's id, which SQL Server reuses, and its connection's, which it never does. */
  async function connectionOf(): Promise<{ spid: number; id: string }> {
    const { rows } = await w.request('query.run', {
      ref,
      sql: 'SELECT session_id, connection_id FROM sys.dm_exec_connections WHERE session_id = @@SPID',
      documentId: 'd2',
    })
    return { spid: Number(rows[0]?.[0]), id: String(rows[0]?.[1]) }
  }
  const dropped = await connectionOf()
  const driver = await loadDriver('mssql')
  const admin = await driver.connect(form, password)
  const kill = await admin.query(`KILL ${dropped.spid}`, { queryId: 'kill' })
  await kill.close()
  await admin.close()
  // Once the client has seen the connection go, the next request opens a fresh session.
  await vi.waitFor(async () => expect((await connectionOf()).id).not.toBe(dropped.id), {
    timeout: 10_000,
  })

  const wrong = { form, password: 'not-the-password' }
  await expect(w.request('connection.test', wrong)).rejects.toThrow(/Login failed/)

  const opened = await w.request('table.open', {
    ref,
    schema: 'dbo',
    table: 'things',
    workspaceId: 'w1',
  })
  expect(opened.status).toBe('opened')
  if (opened.status === 'opened') {
    expect(await readFile(join(root, 'api', opened.path), 'utf8')).toBe(
      `-- db-studio: connection=${ref}\nSELECT TOP 100 * FROM [dbo].[things]\n`,
    )
  }
  await w.deactivate()
}, 120_000)
