/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  Mock,
  MockInstance,
} from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  isAtCommand,
  isSlashCommand,
  copyToClipboard,
  getUrlOpenCommand,
} from './commandUtils.js';

// Mock child_process
vi.mock('child_process');

interface MockChildProcess extends EventEmitter {
  stdin: EventEmitter & {
    write: Mock;
    end: Mock;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: Mock;
}

describe('commandUtils', () => {
  let mockSpawn: Mock;
  let mockChild: MockChildProcess;
  let platformSpy: MockInstance;

  beforeEach(async () => {
    vi.restoreAllMocks();
    platformSpy = vi.spyOn(process, 'platform', 'get');

    // Dynamically import and set up spawn mock
    const { spawn } = await import('child_process');
    mockSpawn = spawn as Mock;

    // Create mock child process with stdout/stderr emitters
    mockChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
      }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      unref: vi.fn(),
    }) as MockChildProcess;

    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
  });

  describe('isAtCommand', () => {
    it('should return true when query starts with @', () => {
      expect(isAtCommand('@file')).toBe(true);
      expect(isAtCommand('@path/to/file')).toBe(true);
      expect(isAtCommand('@')).toBe(true);
    });

    it('should return true when query contains @ preceded by whitespace', () => {
      expect(isAtCommand('hello @file')).toBe(true);
      expect(isAtCommand('some text @path/to/file')).toBe(true);
      expect(isAtCommand('   @file')).toBe(true);
    });

    it('should return false when query does not start with @ and has no spaced @', () => {
      expect(isAtCommand('file')).toBe(false);
      expect(isAtCommand('hello')).toBe(false);
      expect(isAtCommand('')).toBe(false);
      expect(isAtCommand('email@domain.com')).toBe(false);
      expect(isAtCommand('user@host')).toBe(false);
    });

    it('should return false when @ is not preceded by whitespace', () => {
      expect(isAtCommand('hello@file')).toBe(false);
      expect(isAtCommand('text@path')).toBe(false);
    });
  });

  describe('isSlashCommand', () => {
    it('should return true when query starts with /', () => {
      expect(isSlashCommand('/help')).toBe(true);
      expect(isSlashCommand('/memory show')).toBe(true);
      expect(isSlashCommand('/clear')).toBe(true);
      expect(isSlashCommand('/')).toBe(true);
    });

    it('should return false when query does not start with /', () => {
      expect(isSlashCommand('help')).toBe(false);
      expect(isSlashCommand('memory show')).toBe(false);
      expect(isSlashCommand('')).toBe(false);
      expect(isSlashCommand('path/to/file')).toBe(false);
      expect(isSlashCommand(' /help')).toBe(false);
    });
  });

  describe('copyToClipboard', () => {
    describe('on macOS (darwin)', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('darwin');
      });

      it('should successfully copy text to clipboard using pbcopy', async () => {
        const testText = 'Hello, world!';

        // Simulate successful execution
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('pbcopy', []);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should handle pbcopy command failure', async () => {
        const testText = 'Hello, world!';

        // Simulate command failure
        setTimeout(() => {
          mockChild.stderr.emit('data', 'Command not found');
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1: Command not found",
        );
      });

      it('should handle spawn error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('error', new Error('spawn error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('spawn error');
      });

      it('should handle stdin write error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.stdin.emit('error', new Error('stdin error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('stdin error');
      });
    });

    describe('on Windows (win32)', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('win32');
      });

      it('should successfully copy text to clipboard using clip', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('clip', []);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });
    });

    describe('on Linux', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('linux');
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should succeed by timing out and detaching the process', async () => {
        const testText = 'Hello, world!';
        const promise = copyToClipboard(testText);

        // The process does NOT emit 'close'. We advance the clock past the timeout.
        await vi.advanceTimersByTimeAsync(1000);

        // The promise should resolve successfully.
        await expect(promise).resolves.toBeUndefined();
        expect(mockSpawn).toHaveBeenCalledWith('xclip', [
          '-selection',
          'clipboard',
        ]);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should fail if the process closes with an error before the timeout', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;
        mockSpawn.mockImplementation(() => {
          callCount++;
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            unref: vi.fn(),
          });
          setTimeout(() => {
            child.stderr.emit(
              'data',
              callCount === 1 ? 'xclip failed' : 'xsel failed',
            );
            child.emit('close', 1);
          }, 0);
          return child;
        });

        const promise = copyToClipboard(testText);
        promise.catch((rej) => {
          expect(rej.message).toContain('All copy commands failed');
        });

        await vi.runAllTimersAsync();
      });

      it('should fall back to xsel when xclip fails before the timeout', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            unref: vi.fn(),
          }) as MockChildProcess;

          if (callCount === 0) {
            // First call (xclip) fails asynchronously.
            callCount++;
            setTimeout(() => {
              child.stderr.emit('data', 'xclip not found');
              child.emit('close', 1);
            }, 0);
          } else {
            // Second call (xsel) succeeds by timeout.
            // We don't emit 'close' here.
          }
          return child as unknown as ReturnType<typeof spawn>;
        });

        const promise = copyToClipboard(testText);

        // Run all timers. This will cause xclip to fail, and xsel to be
        // called and then time out successfully.
        await vi.runAllTimersAsync();

        await expect(promise).resolves.toBeUndefined();
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(1, 'xclip', [
          '-selection',
          'clipboard',
        ]);
        expect(mockSpawn).toHaveBeenNthCalledWith(2, 'xsel', [
          '--clipboard',
          '--input',
        ]);
      });

      it('should throw error when both xclip and xsel fail before the timeout', async () => {
        const testText = 'Hello, world!';

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            unref: vi.fn(),
          });
          // Both processes fail asynchronously.
          setTimeout(() => {
            child.stderr.emit('data', 'Command failed');
            child.emit('close', 1);
          }, 0);
          return child as unknown as ReturnType<typeof spawn>;
        });

        const promise = copyToClipboard(testText);
        promise.catch((rej) => {
          expect(rej.message).toContain('All copy commands failed');
        });

        // Run all timers to trigger the failures.
        await vi.runAllTimersAsync();

        expect(mockSpawn).toHaveBeenCalledTimes(2);
      });
    });

    describe('on unsupported platform', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('unsupported');
      });

      it('should throw error for unsupported platform', async () => {
        await expect(copyToClipboard('test')).rejects.toThrow(
          'Unsupported platform: unsupported',
        );
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('darwin');
      });

      it('should handle command exit without stderr', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1",
        );
      });

      it('should handle empty text', async () => {
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard('');

        expect(mockChild.stdin.write).toHaveBeenCalledWith('');
      });

      it('should handle multiline text', async () => {
        const multilineText = 'Line 1\nLine 2\nLine 3';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(multilineText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(multilineText);
      });

      it('should handle special characters', async () => {
        const specialText = 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(specialText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(specialText);
      });
    });
  });

  describe('getUrlOpenCommand', () => {
    describe('on macOS (darwin)', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('darwin');
      });
      it('should return open', () => {
        expect(getUrlOpenCommand()).toBe('open');
      });
    });

    describe('on Windows (win32)', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('win32');
      });
      it('should return start', () => {
        expect(getUrlOpenCommand()).toBe('start');
      });
    });

    describe('on Linux (linux)', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('linux');
      });
      it('should return xdg-open', () => {
        expect(getUrlOpenCommand()).toBe('xdg-open');
      });
    });

    describe('on unmatched OS', () => {
      beforeEach(() => {
        platformSpy.mockReturnValue('unmatched');
      });
      it('should return xdg-open', () => {
        expect(getUrlOpenCommand()).toBe('xdg-open');
      });
    });
  });
});
