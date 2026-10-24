import { errorMessage, isDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';

export interface CommandRunnerDeps {
  readonly logger: Logger;
  /** Shows a short message to the user, e.g. `window.showErrorMessage`. */
  readonly showError: (message: string) => unknown;
}

/**
 * Wraps a command handler so a failure never becomes an unhandled rejection:
 * details go to the log, the user sees a short message, cancellation stays silent.
 * The handler's result is passed through (`executeCommand` returns it); on failure it is `undefined`.
 */
export function guardCommand<Args extends unknown[], Result>(
  id: string,
  handler: (...args: Args) => Result | Promise<Result>,
  deps: CommandRunnerDeps,
): (...args: Args) => Promise<Result | undefined> {
  return async (...args: Args): Promise<Result | undefined> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isDbError(error) && error.code === 'cancelled') {
        deps.logger.debug(`Command ${id} cancelled`);
        return undefined;
      }
      deps.logger.error(`Command ${id} failed`, error);
      try {
        await deps.showError(errorMessage(error));
      } catch (notifyError) {
        deps.logger.warn(`Could not show the error of ${id}`, notifyError);
      }
      return undefined;
    }
  };
}
