// configOf maps a cleaned form to a driver config, including the SSL mode a pasted sslmode set. C6
import { describe, expect, test } from 'vitest'
import type { ServerForm } from '../../src/protocol'
import { configOf } from '../../src/worker/saved-connections'

const base: ServerForm = {
  name: 'db',
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'shop',
  user: 'app',
}

describe('configOf SSL threading', () => {
  test('carries ssl=require through for a Postgres connection', () => {
    expect(configOf({ ...base, ssl: 'require' })).toMatchObject({
      engine: 'postgres',
      ssl: 'require',
    })
  })

  test('carries ssl=disable through so an explicit disable is not re-enabled by the host default', () => {
    expect(configOf({ ...base, ssl: 'disable' })).toMatchObject({
      engine: 'postgres',
      ssl: 'disable',
    })
  })

  test('leaves ssl absent when the form carries no sslmode', () => {
    expect(configOf(base)).not.toHaveProperty('ssl')
  })

  test('drops a stray ssl on MySQL', () => {
    const mysql = { ...base, engine: 'mysql' as const, port: 3306, ssl: 'require' as const }
    expect(configOf(mysql)).not.toHaveProperty('ssl')
  })
})
