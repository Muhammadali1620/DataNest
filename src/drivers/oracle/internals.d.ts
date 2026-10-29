// The one module of node-oracledb's thin driver that exact-dates.ts reaches into; the
// package ships no types for its internals.

declare module 'oracledb/lib/impl/datahandlers/buffer' {
  export const BaseBuffer: { prototype: Record<string, unknown> };
}
