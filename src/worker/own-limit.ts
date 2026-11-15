// Whether a statement sets its own row count. G1
// A best-effort scan for the common quoting rules: a wrong answer either way stays bounded by the
// result ceiling, so engine-specific lexing (dollar quotes, backslash escapes) is not chased here.
/** Each opening quote and what closes it; SQL Server quotes names in brackets. */
const QUOTES: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' }

/** Whether `word`, seen at the top level after `before` (nearest first), sets the row count. */
function limits(word: string, before: string[], rest: string): boolean {
  if (word === 'LIMIT') return true
  // FETCH NEXT | FIRST n ROWS: the SQL standard's form, which PostgreSQL and SQL Server accept.
  if ((word === 'NEXT' || word === 'FIRST') && before[0] === 'FETCH') return true
  if (word !== 'TOP') return false
  // SELECT [DISTINCT | ALL] TOP n or TOP (n); a column that happens to be called top is not it.
  const afterSelect =
    before[0] === 'SELECT' ||
    ((before[0] === 'DISTINCT' || before[0] === 'ALL') && before[1] === 'SELECT')
  return afterSelect && /^\s*[0-9(]/.test(rest)
}

/**
 * Whether `LIMIT`, `TOP` or `FETCH NEXT | FIRST` appears outside strings, quoted names, comments
 * and parentheses. The keywords mean the same on every engine that has them.
 */
export function hasOwnLimit(sql: string): boolean {
  let depth = 0
  /** The words just read at the top level, nearest first; anything else in between clears them. */
  const before: string[] = []
  let i = 0
  while (i < sql.length) {
    const char = sql[i] as string
    const closer = QUOTES[char]
    if (closer) {
      // A doubled quote closes and reopens, which this loop does too.
      const end = sql.indexOf(closer, i + 1)
      i = end === -1 ? sql.length : end + 1
      before.length = 0
    } else if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (char === '(') {
      depth++
      i++
      before.length = 0
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      i++
      before.length = 0
    } else if (/[A-Za-z_]/.test(char)) {
      let end = i + 1
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end] as string)) end++
      // A name after a dot is a column, not the keyword.
      const qualified = sql[i - 1] === '.'
      if (depth === 0 && !qualified) {
        const word = sql.slice(i, end).toUpperCase()
        if (limits(word, before, sql.slice(end))) return true
        before.unshift(word)
        before.length = Math.min(before.length, 2)
      }
      i = end
    } else {
      // Only blanks and comments may sit between the words of one keyword phrase.
      if (!/\s/.test(char)) before.length = 0
      i++
    }
  }
  return false
}
