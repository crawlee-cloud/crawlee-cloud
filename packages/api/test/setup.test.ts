import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSetupAdminUser, mockWithAdvisoryLock } = vi.hoisted(() => ({
  mockSetupAdminUser: vi.fn(),
  mockWithAdvisoryLock: vi.fn(),
}));

vi.mock('../src/setup.js', () => ({
  setupAdminUser: mockSetupAdminUser,
}));

vi.mock('../src/db/index.js', () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LOCK_IDS: { setup: 0xc0de0001 },
}));

import { setupAdminUserGated } from '../src/setup-gated.js';

describe('setupAdminUserGated', () => {
  beforeEach(() => {
    mockSetupAdminUser.mockReset();
    mockWithAdvisoryLock.mockReset();
  });

  it('leader path: setupAdminUser is invoked exactly once', async () => {
    mockWithAdvisoryLock.mockImplementation(async (_id, work) => ({
      acquired: true,
      result: await work({} as never),
    }));
    mockSetupAdminUser.mockResolvedValue(undefined);

    await setupAdminUserGated();

    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(0xc0de0001, expect.any(Function));
    expect(mockSetupAdminUser).toHaveBeenCalledOnce();
  });

  it('follower path: setupAdminUser is NOT invoked; single info log', async () => {
    mockWithAdvisoryLock.mockResolvedValue({ acquired: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await setupAdminUserGated();

    expect(mockSetupAdminUser).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Another replica is bootstrapping')
    );
    logSpy.mockRestore();
  });
});
