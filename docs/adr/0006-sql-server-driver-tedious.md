# 0006. SQL Server through tedious, bundled without the Azure SDK

Status: accepted

## Context

DB Studio connects to Microsoft SQL Server (issue #57): a local Docker server with a SQL login and no encryption, and Azure SQL databases with a SQL login and encryption required.

- Drivers must be pure JavaScript and bundled into `vendor/`, each file 1 MiB or less (see the architecture doc).
- `tedious` (MIT) is the only maintained pure-JavaScript TDS client. `msnodesqlv8` is a native module, which the Orca directory rejects. `mssql` wraps tedious in a connection pool and a promise API that buffers results; the worker keeps one session per connection and streams rows, as it already does with `pg` + `pg-cursor` and the `mysql2` callback API.
- tedious `require`s `@azure/identity`, `@azure/core-auth` and `@azure/keyvault-keys` at load time, for Microsoft Entra ID sign-in and for Always Encrypted keys kept in Azure Key Vault. Measured on tedious 20.3.9, the bundle is 1349 KiB with them and 764 KiB without.
- tedious takes `encrypt` and `trustServerCertificate`, not Node's TLS options.

## Decision

- The SQL Server driver (`src/drivers/mssql/`) uses tedious directly: one `Connection` per session, one `Request` at a time, rows paused and resumed as the worker fetches them.
- `build/bundle-drivers.mjs` aliases the three `@azure/*` modules to `build/azure-stub.cjs` in the tedious bundle only. The stub says no credential is an Azure token credential and throws "Azure authentication is not supported" from every class tedious would construct.
- The engine id is `mssql` (the name Knex, TypeORM, Sequelize, Kysely and `@codemirror/lang-sql` use); the person sees "SQL Server". The id is stored with every saved connection, so it is never renamed.
- Encryption uses the `ssl` field (`disable`, `require`, `verify-full`) the other engines will share (PR #73). The driver maps it to tedious's options:

  | `ssl`              | `encrypt` | `trustServerCertificate` |
  | ------------------ | --------- | ------------------------ |
  | `disable` or unset | `false`   | `true`                   |
  | `require`          | `true`    | `true`                   |
  | `verify-full`      | `true`    | `false`                  |

  `disable` still trusts the certificate because SQL Server encrypts the login packet even then, usually with a self-signed certificate.

## Consequences

- Only SQL logins work. Microsoft Entra ID (password, service principal, managed identity, default credential), integrated Windows authentication and Always Encrypted with Key Vault keys fail with the stub's message. The PRD already excludes cloud integrations.
- A tedious upgrade that requires another Azure module, or calls another export of these three, fails at load or sign-in until the stub follows; `npm run test:drivers` catches the first case.
- Revisit if a person needs Entra ID sign-in and the bundle can carry the SDK within 1 MiB, or if Orca lifts the per-file limit.
