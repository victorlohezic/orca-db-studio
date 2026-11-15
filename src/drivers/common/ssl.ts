// TLS options for a server connection, derived from the sslmode the person chose.
import type { SslMode } from './config'

/** The modes the connection form offers, in the order it lists them. */
export const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-full']

export function isSslMode(value: unknown): value is SslMode {
  return value === 'disable' || value === 'require' || value === 'verify-full'
}
