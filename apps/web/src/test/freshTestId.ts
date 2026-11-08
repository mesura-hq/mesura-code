let nextId = 0;

/** Keeps module-owned test state separate without random fixture data. */
export function freshTestId(prefix: string): string {
  return `${prefix}-${++nextId}`;
}
