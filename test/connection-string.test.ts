// Parsing a connection string, including how sslmode maps to the ssl mode. C2
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
