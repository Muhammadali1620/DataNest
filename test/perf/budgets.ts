// The performance budget (V9.1, ARCHITECTURE.md §7): what a measurement may reach before
// the perf run fails. Each limit is a few times what a developer machine measures, so a
// slow CI runner passes, while a regression like the 85-second sort of V8 does not.

/** Sizes of built bundles, in kilobytes (`npm run build:prod`). */
export const BUNDLE_KB = {
  /** Everything loaded at activation; drivers and big libraries are separate bundles. */
  extension: 1024,
  /** The largest driver bundle (SQL Server and MySQL are about 1.1 MB). */
  driver: 1536,
  /** The largest webview app script; each panel loads only its own. */
  webviewApp: 256,
} as const;

/**
 * The first activation in a real VS Code (test/e2e/extension.test.ts), in milliseconds:
 * loading the bundle, reading the project's connections and registering everything.
 */
export const ACTIVATION_MS = 1000;

/** Time to load and evaluate dist/extension.js, without `activate`, in milliseconds. */
export const EXTENSION_LOAD_MS = 200;

/** A million result rows in the extension host. */
export const MILLION_ROWS = {
  /** Heap the rows of six columns take, per row, in bytes. */
  heapBytesPerRow: 700,
  /** A window of the grid from the middle of the result. */
  windowMs: 50,
  /** Sorting by a column of numbers. */
  sortNumbersMs: 3000,
  /** Sorting by a column of dates, with many repeats. */
  sortDatesMs: 5000,
  /** Sorting by a column of distinct text, the slowest kind (the collator is dear). */
  sortDistinctTextMs: 25_000,
  /** The longest the host stays busy at once while a sort or search runs. */
  longestBlockMs: 1000,
  /** Searching every cell for text. */
  searchMs: 2500,
} as const;

/** A million rows read through the SQLite driver. */
export const SQLITE_MILLION = {
  readMs: 15_000,
  heapBytesPerRow: 700,
} as const;
