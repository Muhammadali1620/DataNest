import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { guardCommand } from '../../../src/vscode/command-runner';
import { RecordingLogger } from '../../helpers/fakes';

function setup() {
  const logger = new RecordingLogger();
  const showError = vi.fn();
  return { logger, showError, deps: { logger, showError } };
}

describe('guardCommand', () => {
  it('passes arguments to the handler and resolves after it', async () => {
    const { deps, logger, showError } = setup();
    const handler = vi.fn(async (a: number, b: string) => {
      await Promise.resolve();
      return `${a}${b}`;
    });
    await guardCommand('datanest.test', handler, deps)(1, 'x');
    expect(handler).toHaveBeenCalledWith(1, 'x');
    expect(showError).not.toHaveBeenCalled();
    expect(logger.entries).toEqual([]);
  });

  it('returns the handler result, so executeCommand can pass it on', async () => {
    const { deps } = setup();
    await expect(guardCommand('id', () => ({ value: 1 }), deps)()).resolves.toEqual({ value: 1 });
    await expect(guardCommand('id', () => Promise.resolve('async'), deps)()).resolves.toBe('async');
  });

  it('returns undefined when the handler fails or is cancelled', async () => {
    const { deps } = setup();
    await expect(
      guardCommand(
        'id',
        (): number => {
          throw new Error('x');
        },
        deps,
      )(),
    ).resolves.toBeUndefined();
    await expect(
      guardCommand('id', () => Promise.reject(new DbError('cancelled', 'c')), deps)(),
    ).resolves.toBeUndefined();
  });

  it('supports synchronous handlers', async () => {
    const { deps } = setup();
    const handler = vi.fn(() => 5);
    await expect(guardCommand('id', handler, deps)()).resolves.toBe(5);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('logs a failure with details and shows a short message', async () => {
    const { deps, logger, showError } = setup();
    const error = new DbError('connection-failed', 'Connection refused');
    await guardCommand('datanest.connect', () => Promise.reject(error), deps)();
    expect(logger.entries).toEqual([
      { level: 'error', scope: [], message: 'Command datanest.connect failed', error },
    ]);
    expect(showError).toHaveBeenCalledWith('Connection refused');
  });

  it('handles synchronous throws the same way', async () => {
    const { deps, logger, showError } = setup();
    const handler = () => {
      throw new TypeError('bad');
    };
    await expect(guardCommand('id', handler, deps)()).resolves.toBeUndefined();
    expect(logger.messages('error')).toEqual(['Command id failed']);
    expect(showError).toHaveBeenCalledWith('bad');
  });

  it('shows a generic message for non-Error values', async () => {
    const { deps, showError } = setup();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejections happen in third-party code
    await guardCommand('id', () => Promise.reject({ weird: true }), deps)();
    expect(showError).toHaveBeenCalledWith('Unexpected error');
  });

  it('stays silent when the user cancelled', async () => {
    const { deps, logger, showError } = setup();
    await guardCommand('id', () => Promise.reject(new DbError('cancelled', 'Cancelled')), deps)();
    expect(showError).not.toHaveBeenCalled();
    expect(logger.entries).toEqual([
      { level: 'debug', scope: [], message: 'Command id cancelled' },
    ]);
  });

  it('logs a warning if showing the error fails too', async () => {
    const { logger } = setup();
    const notifyError = new Error('window closed');
    const showError = vi.fn(() => Promise.reject(notifyError));
    await expect(
      guardCommand('id', () => Promise.reject(new Error('first')), { logger, showError })(),
    ).resolves.toBeUndefined();
    expect(logger.entries.map((e) => [e.level, e.message])).toEqual([
      ['error', 'Command id failed'],
      ['warn', 'Could not show the error of id'],
    ]);
    expect(logger.entries[1]?.error).toBe(notifyError);
  });

  it('waits for the error message promise', async () => {
    const { logger } = setup();
    let shown = false;
    const showError = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          shown = true;
          resolve();
        }, 0);
      });
    await guardCommand('id', () => Promise.reject(new Error('x')), { logger, showError })();
    expect(shown).toBe(true);
  });
});
