// Stands in for @azure/identity, @azure/core-auth and @azure/keyvault-keys in the tedious bundle
// (ADR 0006). tedious requires them up front, but DB Studio only signs in with a SQL login, and the
// real SDK would push vendor/tedious.js past the 1 MiB a plugin file may weigh.
'use strict'

function unsupported() {
  throw new Error('Azure authentication is not supported: connect with a SQL login')
}

class Unsupported {
  constructor() {
    unsupported()
  }
}

module.exports = {
  // @azure/core-auth: no credential object is ever an Azure token credential here.
  isTokenCredential: () => false,
  // @azure/identity
  ClientSecretCredential: Unsupported,
  DefaultAzureCredential: Unsupported,
  ManagedIdentityCredential: Unsupported,
  UsernamePasswordCredential: Unsupported,
  // @azure/keyvault-keys, for Always Encrypted keys kept in Key Vault
  CryptographyClient: Unsupported,
  KeyClient: Unsupported,
}
