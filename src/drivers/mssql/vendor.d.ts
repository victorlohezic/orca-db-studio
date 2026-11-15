// The worker bundle of vendor/ carries no types of its own.
declare module '*/vendor/tedious.js' {
  export { Connection, Request, TYPES } from 'tedious'
}
