import type { Database, Statement } from 'bun:sqlite'

export type SqliteSlowStatement = {
  sql: string
  durationMs: number
  callerTag: string
}

export type SqliteStatementTelemetryOptions = {
  slowStatementThresholdMs: number
  onSlowStatement(statement: SqliteSlowStatement): void
}

const STATEMENT_EXECUTION_METHODS = new Set<PropertyKey>(['all', 'get', 'run', 'values', 'raw'])

function callerTagFromStack(): string {
  const frames = new Error().stack?.split('\n').slice(1) ?? []
  const frame = frames.find(
    (entry) =>
      !/\/statement-telemetry\.(?:ts|js):/.test(entry) &&
      !entry.includes('/repositories/shared.') &&
      !entry.includes('/migrations/types.') &&
      !entry.includes('bun:sqlite')
  )
  return frame?.trim().replace(/^at\s+/, '') ?? 'unknown'
}

function observeExecution<T>(
  sql: string,
  callerTag: string,
  options: SqliteStatementTelemetryOptions,
  execute: () => T
): T {
  const started = process.hrtime.bigint()
  try {
    return execute()
  } finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
    if (durationMs >= options.slowStatementThresholdMs) {
      try {
        options.onSlowStatement({ sql, durationMs, callerTag })
      } catch {
        // Telemetry is observational and must never alter SQLite behavior.
      }
    }
  }
}

function instrumentIterator<T>(
  iterator: IterableIterator<T>,
  sql: string,
  callerTag: string,
  options: SqliteStatementTelemetryOptions
): IterableIterator<T> {
  const started = process.hrtime.bigint()
  let observed = false

  const observeOnce = (): void => {
    if (observed) return
    observed = true
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
    if (durationMs < options.slowStatementThresholdMs) return
    try {
      options.onSlowStatement({ sql, durationMs, callerTag })
    } catch {
      // Telemetry is observational and must never alter SQLite behavior.
    }
  }

  return {
    next(...args: [] | [undefined]) {
      try {
        const result = iterator.next(...args)
        if (result.done) observeOnce()
        return result
      } catch (error) {
        observeOnce()
        throw error
      }
    },
    return(value?: T) {
      try {
        return iterator.return?.(value) ?? { done: true, value }
      } finally {
        observeOnce()
      }
    },
    throw(error?: unknown) {
      try {
        if (iterator.throw) return iterator.throw(error)
        throw error
      } finally {
        observeOnce()
      }
    },
    [Symbol.iterator]() {
      return this
    },
  }
}

function instrumentStatement<
  ReturnType,
  ParamsType extends import('bun:sqlite').SQLQueryBindings[],
>(
  statement: Statement<ReturnType, ParamsType>,
  sql: string,
  callerTag: string,
  options: SqliteStatementTelemetryOptions
): Statement<ReturnType, ParamsType> {
  const proxy: Statement<ReturnType, ParamsType> = new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (property === 'as' && typeof value === 'function') {
        return (...args: unknown[]) => {
          Reflect.apply(value, target, args)
          return proxy
        }
      }
      if (property === 'iterate' && typeof value === 'function') {
        return (...args: unknown[]) =>
          instrumentIterator(
            Reflect.apply(value, target, args) as IterableIterator<ReturnType>,
            sql,
            callerTag,
            options
          )
      }
      if (property === Symbol.iterator && typeof value === 'function') {
        return () =>
          instrumentIterator(
            Reflect.apply(value, target, []) as IterableIterator<ReturnType>,
            sql,
            callerTag,
            options
          )
      }
      if (STATEMENT_EXECUTION_METHODS.has(property) && typeof value === 'function') {
        return (...args: unknown[]) =>
          observeExecution(sql, callerTag, options, () => Reflect.apply(value, target, args))
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return proxy
}

export function instrumentSqliteStatements(
  database: Database,
  options: SqliteStatementTelemetryOptions
): Database {
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if ((property === 'query' || property === 'prepare') && typeof value === 'function') {
        return (sql: string, ...args: unknown[]) => {
          const callerTag = callerTagFromStack()
          const statement = Reflect.apply(value, target, [sql, ...args]) as Statement
          return instrumentStatement(statement, sql, callerTag, options)
        }
      }
      if ((property === 'run' || property === 'exec') && typeof value === 'function') {
        return (sql: string, ...args: unknown[]) => {
          const callerTag = callerTagFromStack()
          return observeExecution(sql, callerTag, options, () =>
            Reflect.apply(value, target, [sql, ...args])
          )
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
