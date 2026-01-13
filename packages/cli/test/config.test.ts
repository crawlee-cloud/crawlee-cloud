import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';

// Mock fs-extra module
vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    ensureDir: vi.fn(),
    remove: vi.fn(),
  },
}));

describe('CLI Config', () => {
  const originalEnv = process.env;
  let mockFs: typeof import('fs-extra');

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear mock env vars
    delete process.env.CRAWLEE_CLOUD_API_URL;
    delete process.env.CRAWLEE_CLOUD_TOKEN;
    delete process.env.CRAWLEE_CLOUD_REGISTRY_URL;
    delete process.env.APIFY_API_BASE_URL;
    delete process.env.APIFY_TOKEN;

    mockFs = (await import('fs-extra')).default;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('getConfig', () => {
    it('should return default values when no config file or env vars exist', async () => {
      vi.mocked(mockFs.pathExists).mockResolvedValue(false);

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('http://localhost:3000');
      expect(config.token).toBe('');
      expect(config.registryUrl).toBeUndefined();
    });

    it('should use CRAWLEE_CLOUD environment variables', async () => {
      process.env.CRAWLEE_CLOUD_API_URL = 'http://custom-api.example.com';
      process.env.CRAWLEE_CLOUD_TOKEN = 'custom-token';
      process.env.CRAWLEE_CLOUD_REGISTRY_URL = 'http://registry.example.com';

      vi.mocked(mockFs.pathExists).mockResolvedValue(false);

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('http://custom-api.example.com');
      expect(config.token).toBe('custom-token');
      expect(config.registryUrl).toBe('http://registry.example.com');
    });

    it('should use APIFY environment variables as fallback', async () => {
      process.env.APIFY_API_BASE_URL = 'https://api.apify.com/v2';
      process.env.APIFY_TOKEN = 'apify-token';

      vi.mocked(mockFs.pathExists).mockResolvedValue(false);

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('https://api.apify.com');
      expect(config.token).toBe('apify-token');
    });

    it('should prefer CRAWLEE_CLOUD env vars over APIFY', async () => {
      process.env.CRAWLEE_CLOUD_API_URL = 'http://crawlee.example.com';
      process.env.CRAWLEE_CLOUD_TOKEN = 'crawlee-token';
      process.env.APIFY_API_BASE_URL = 'https://api.apify.com/v2';
      process.env.APIFY_TOKEN = 'apify-token';

      vi.mocked(mockFs.pathExists).mockResolvedValue(false);

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('http://crawlee.example.com');
      expect(config.token).toBe('crawlee-token');
    });

    it('should merge config file values over env vars', async () => {
      process.env.CRAWLEE_CLOUD_API_URL = 'http://env-api.example.com';
      process.env.CRAWLEE_CLOUD_TOKEN = 'env-token';

      vi.mocked(mockFs.pathExists).mockResolvedValue(true);
      vi.mocked(mockFs.readJson).mockResolvedValue({
        apiBaseUrl: 'http://file-api.example.com',
        token: 'file-token',
      });

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('http://file-api.example.com');
      expect(config.token).toBe('file-token');
    });

    it('should partially merge config file values', async () => {
      process.env.CRAWLEE_CLOUD_API_URL = 'http://env-api.example.com';
      process.env.CRAWLEE_CLOUD_TOKEN = 'env-token';

      vi.mocked(mockFs.pathExists).mockResolvedValue(true);
      vi.mocked(mockFs.readJson).mockResolvedValue({
        token: 'file-token', // Only override token
      });

      const { getConfig } = await import('../src/utils/config.js');
      const config = await getConfig();

      expect(config.apiBaseUrl).toBe('http://env-api.example.com');
      expect(config.token).toBe('file-token');
    });
  });

  describe('saveConfig', () => {
    it('should save config to file', async () => {
      vi.mocked(mockFs.pathExists).mockResolvedValue(false);
      vi.mocked(mockFs.ensureDir).mockResolvedValue(undefined);
      vi.mocked(mockFs.writeJson).mockResolvedValue(undefined);

      const { saveConfig } = await import('../src/utils/config.js');
      await saveConfig({
        apiBaseUrl: 'http://new-api.example.com',
        token: 'new-token',
      });

      expect(mockFs.ensureDir).toHaveBeenCalled();
      expect(mockFs.writeJson).toHaveBeenCalledWith(
        expect.stringContaining('config.json'),
        expect.objectContaining({
          apiBaseUrl: 'http://new-api.example.com',
          token: 'new-token',
        }),
        expect.objectContaining({ spaces: 2, mode: 0o600 })
      );
    });

    it('should merge with existing config', async () => {
      vi.mocked(mockFs.pathExists).mockResolvedValue(true);
      vi.mocked(mockFs.readJson).mockResolvedValue({
        apiBaseUrl: 'http://existing-api.example.com',
        token: 'existing-token',
      });
      vi.mocked(mockFs.ensureDir).mockResolvedValue(undefined);
      vi.mocked(mockFs.writeJson).mockResolvedValue(undefined);

      const { saveConfig } = await import('../src/utils/config.js');
      await saveConfig({
        token: 'updated-token', // Only update token
      });

      expect(mockFs.writeJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          apiBaseUrl: 'http://existing-api.example.com',
          token: 'updated-token',
        }),
        expect.any(Object)
      );
    });
  });

  describe('clearConfig', () => {
    it('should remove config file if it exists', async () => {
      vi.mocked(mockFs.pathExists).mockResolvedValue(true);
      vi.mocked(mockFs.remove).mockResolvedValue(undefined);

      const { clearConfig } = await import('../src/utils/config.js');
      await clearConfig();

      expect(mockFs.remove).toHaveBeenCalledWith(
        expect.stringContaining('config.json')
      );
    });

    it('should not throw if config file does not exist', async () => {
      vi.mocked(mockFs.pathExists).mockResolvedValue(false);

      const { clearConfig } = await import('../src/utils/config.js');
      await expect(clearConfig()).resolves.not.toThrow();

      expect(mockFs.remove).not.toHaveBeenCalled();
    });
  });
});
