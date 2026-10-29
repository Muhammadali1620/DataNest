// ClickHouse type names, which both the driver and the transfer read.

/** `Nullable(…)` and `LowCardinality(…)` only say how a value is kept, not what it is. */
export function clickhouseBareType(dataType: string): string {
  let type = dataType.trim();
  for (;;) {
    const wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/isu.exec(type);
    if (wrapped === null) {
      return type;
    }
    type = (wrapped[1] ?? '').trim();
  }
}

/** True when the outermost wrapper (under LowCardinality) is Nullable. */
export function isClickhouseNullable(dataType: string): boolean {
  return /^(?:LowCardinality\()?Nullable\(/iu.test(dataType.trim());
}
