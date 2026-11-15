// Unit tests for the own-limit scan (LIMIT, TOP, FETCH): the cases the request tests cannot reach cheaply.
import { describe, expect, test } from 'vitest'
import { hasOwnLimit } from '../../src/worker/own-limit'

describe('hasOwnLimit', () => {
  test.each([
    ['SELECT * FROM t LIMIT 5', true],
    ['select * from t limit 5 offset 2', true],
    ['WITH x AS (SELECT 1 LIMIT 1) SELECT * FROM x LIMIT 3', true],
    ['SELECT * FROM t', false],
    ['SELECT * FROM (SELECT * FROM t LIMIT 5)', false],
    ["SELECT 'a LIMIT 5'", false],
    ['SELECT "limit" FROM t', false],
    ['SELECT `limit` FROM t', false],
    ['SELECT t.limit FROM t', false],
    ['SELECT 1 -- LIMIT 5', false],
    ['SELECT 1 /* LIMIT 5 */', false],
    ['SELECT 1 /* LIMIT 5 */ LIMIT 2', true],
    ["SELECT 'it''s' FROM t LIMIT 2", true],
    ["SELECT 'unterminated LIMIT 5", false],
    ['SELECT 1 /* unterminated LIMIT 5', false],
    ['SELECT 1) FROM t LIMIT 5', true],
    ['SELECT limited FROM t', false],
    ['SELECT TOP 5000 * FROM t', true],
    ['select top (10) id from t', true],
    ['SELECT DISTINCT TOP 3 name FROM t', true],
    ['SELECT ALL TOP 3 name FROM t', true],
    ['WITH x AS (SELECT TOP 1 id FROM t) SELECT * FROM x', false],
    ['SELECT top FROM t', false],
    ['SELECT top, id FROM t', false],
    ['SELECT [top] FROM t', false],
    ['SELECT [LIMIT 5] FROM t', false],
    ['SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', true],
    ['SELECT id FROM t FETCH FIRST 3 ROWS ONLY', true],
    ['SELECT * FROM (SELECT id FROM t FETCH FIRST 3 ROWS ONLY) s', false],
    ['SELECT fetch, next FROM t', false],
  ])('%s', (sql, expected) => {
    expect(hasOwnLimit(sql)).toBe(expected)
  })
})
