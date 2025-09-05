/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { MCPOAuthTokenStorage } from './oauth-token-storage.js';
import { HybridTokenStorage } from './token-storage/hybrid-token-storage.js';
import { FORCE_ENCRYPTED_FILE_ENV_VAR } from './token-storage/index.js';
import type { OAuthCredentials, OAuthToken } from './token-storage/types.js';

// Mock dependencies
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock('node:path', () => ({
  dirname: vi.fn(),
}));

vi.mock('../config/storage.js', () => ({
  Storage: {
    getMcpOAuthTokensPath: vi.fn(),
  },
}));

vi.mock('./token-storage/hybrid-token-storage.js');

const mockHybridTokenStorage = {
  listServers: vi.fn(),
  setCredentials: vi.fn(),
  getCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
  clearAll: vi.fn(),
  getAllCredentials: vi.fn(),
};

describe('MCPOAuthTokenStorage', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetAllMocks();
    (HybridTokenStorage as Mock).mockImplementation(
      () => mockHybridTokenStorage,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when useEncryptedFile is true', () => {
    beforeEach(() => {
      process.env[FORCE_ENCRYPTED_FILE_ENV_VAR] = 'true';
    });

    it('should use HybridTokenStorage to list servers', async () => {
      const storage = new MCPOAuthTokenStorage();
      mockHybridTokenStorage.listServers.mockResolvedValue(['server1']);
      const servers = await storage.listServers();
      expect(mockHybridTokenStorage.listServers).toHaveBeenCalled();
      expect(servers).toEqual(['server1']);
    });

    it('should use HybridTokenStorage to set credentials', async () => {
      const storage = new MCPOAuthTokenStorage();
      const credentials: OAuthCredentials = {
        serverName: 'server1',
        token: { accessToken: 'token', tokenType: 'bearer' },
        clientId: 'clientId',
        tokenUrl: 'tokenUrl',
        mcpServerUrl: 'mcpUrl',
        updatedAt: 123,
      };
      await storage.setCredentials(credentials);
      expect(mockHybridTokenStorage.setCredentials).toHaveBeenCalledWith(
        credentials,
      );
    });

    it('should use HybridTokenStorage to save a token', async () => {
      const storage = new MCPOAuthTokenStorage();
      const serverName = 'server1';
      const token: OAuthToken = { accessToken: 'token', tokenType: 'bearer' };
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await storage.saveToken(
        serverName,
        token,
        'clientId',
        'tokenUrl',
        'mcpUrl',
      );

      const expectedCredential: OAuthCredentials = {
        serverName,
        token,
        clientId: 'clientId',
        tokenUrl: 'tokenUrl',
        mcpServerUrl: 'mcpUrl',
        updatedAt: now,
      };

      expect(mockHybridTokenStorage.setCredentials).toHaveBeenCalledWith(
        expectedCredential,
      );
      expect(Storage.getMcpOAuthTokensPath).toHaveBeenCalled();
      expect(path.dirname).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalled();
    });

    it('should use HybridTokenStorage to get credentials', async () => {
      const storage = new MCPOAuthTokenStorage();
      const credentials: OAuthCredentials = {
        serverName: 'server1',
        token: { accessToken: 'token', tokenType: 'bearer' },
        clientId: 'clientId',
        tokenUrl: 'tokenUrl',
        mcpServerUrl: 'mcpUrl',
        updatedAt: 123,
      };
      mockHybridTokenStorage.getCredentials.mockResolvedValue(credentials);
      const result = await storage.getCredentials('server1');
      expect(mockHybridTokenStorage.getCredentials).toHaveBeenCalledWith(
        'server1',
      );
      expect(result).toBe(credentials);
    });

    it('should use HybridTokenStorage to delete credentials', async () => {
      const storage = new MCPOAuthTokenStorage();
      await storage.deleteCredentials('server1');
      expect(mockHybridTokenStorage.deleteCredentials).toHaveBeenCalledWith(
        'server1',
      );
    });

    it('should use HybridTokenStorage to clear all tokens', async () => {
      const storage = new MCPOAuthTokenStorage();
      await storage.clearAll();
      expect(mockHybridTokenStorage.clearAll).toHaveBeenCalled();
    });
  });

  describe('when useEncryptedFile is false', () => {
    const mockTokenPath = '/fake/path/tokens.json';
    const mockTokenDir = '/fake/path';

    beforeEach(() => {
      process.env[FORCE_ENCRYPTED_FILE_ENV_VAR] = 'false';
      (Storage.getMcpOAuthTokensPath as Mock).mockReturnValue(mockTokenPath);
      (path.dirname as Mock).mockReturnValue(mockTokenDir);
    });

    it('listServers should return servers from file', async () => {
      const storage = new MCPOAuthTokenStorage();
      const mockCreds: OAuthCredentials[] = [
        {
          serverName: 'server1',
          token: { accessToken: '1', tokenType: 'bearer' },
          clientId: 'c1',
          tokenUrl: 't1',
          mcpServerUrl: 'm1',
          updatedAt: 1,
        },
        {
          serverName: 'server2',
          token: { accessToken: '2', tokenType: 'bearer' },
          clientId: 'c2',
          tokenUrl: 't2',
          mcpServerUrl: 'm2',
          updatedAt: 2,
        },
      ];
      (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockCreds));

      const servers = await storage.listServers();
      expect(servers).toEqual(['server1', 'server2']);
      expect(fs.readFile).toHaveBeenCalledWith(mockTokenPath, 'utf-8');
    });

    it('setCredentials should write to file', async () => {
      const storage = new MCPOAuthTokenStorage();
      (fs.readFile as Mock).mockResolvedValue('[]');
      const newCreds: OAuthCredentials = {
        serverName: 'server3',
        token: { accessToken: '3', tokenType: 'bearer' },
        clientId: 'c3',
        tokenUrl: 't3',
        mcpServerUrl: 'm3',
        updatedAt: 3,
      };

      await storage.setCredentials(newCreds);

      expect(fs.writeFile).toHaveBeenCalledWith(
        mockTokenPath,
        JSON.stringify([newCreds], null, 2),
        { mode: 0o600 },
      );
    });

    it('saveToken should write to file', async () => {
      const storage = new MCPOAuthTokenStorage();
      (fs.readFile as Mock).mockResolvedValue('[]');
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await storage.saveToken(
        'server4',
        {
          accessToken: '4',
          tokenType: 'bearer',
        },
        'clientId4',
        'tokenUrl4',
        'mcpUrl4',
      );

      const expectedCreds: OAuthCredentials = {
        serverName: 'server4',
        token: { accessToken: '4', tokenType: 'bearer' },
        clientId: 'clientId4',
        tokenUrl: 'tokenUrl4',
        mcpServerUrl: 'mcpUrl4',
        updatedAt: now,
      };

      expect(fs.mkdir).toHaveBeenCalledWith(mockTokenDir, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockTokenPath,
        JSON.stringify([expectedCreds], null, 2),
        { mode: 0o600 },
      );
    });

    it('getCredentials should return credentials from file', async () => {
      const storage = new MCPOAuthTokenStorage();
      const mockCreds: OAuthCredentials[] = [
        {
          serverName: 'server1',
          token: { accessToken: '1', tokenType: 'bearer' },
          clientId: 'c1',
          tokenUrl: 't1',
          mcpServerUrl: 'm1',
          updatedAt: 1,
        },
      ];
      (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockCreds));

      const creds = await storage.getCredentials('server1');
      expect(creds).toEqual(mockCreds[0]);
    });

    it('getCredentials should return null if not found', async () => {
      const storage = new MCPOAuthTokenStorage();
      const mockCreds: OAuthCredentials[] = [
        {
          serverName: 'server1',
          token: { accessToken: '1', tokenType: 'bearer' },
          clientId: 'c1',
          tokenUrl: 't1',
          mcpServerUrl: 'm1',
          updatedAt: 1,
        },
      ];
      (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockCreds));

      const creds = await storage.getCredentials('non-existent');
      expect(creds).toBeNull();
    });

    it('deleteCredentials should remove from file', async () => {
      const storage = new MCPOAuthTokenStorage();
      const mockCreds: OAuthCredentials[] = [
        {
          serverName: 'server1',
          token: { accessToken: '1', tokenType: 'bearer' },
          clientId: 'c1',
          tokenUrl: 't1',
          mcpServerUrl: 'm1',
          updatedAt: 1,
        },
        {
          serverName: 'server2',
          token: { accessToken: '2', tokenType: 'bearer' },
          clientId: 'c2',
          tokenUrl: 't2',
          mcpServerUrl: 'm2',
          updatedAt: 2,
        },
      ];
      (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockCreds));

      await storage.deleteCredentials('server1');

      const expectedCreds = [mockCreds[1]];
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockTokenPath,
        JSON.stringify(expectedCreds, null, 2),
        { mode: 0o600 },
      );
    });

    it('deleteCredentials should delete file if last credential is removed', async () => {
      const storage = new MCPOAuthTokenStorage();
      const mockCreds: OAuthCredentials[] = [
        {
          serverName: 'server1',
          token: { accessToken: '1', tokenType: 'bearer' },
          clientId: 'c1',
          tokenUrl: 't1',
          mcpServerUrl: 'm1',
          updatedAt: 1,
        },
      ];
      (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockCreds));

      await storage.deleteCredentials('server1');

      expect(fs.unlink).toHaveBeenCalledWith(mockTokenPath);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('clearAll should delete the token file', async () => {
      const storage = new MCPOAuthTokenStorage();
      await storage.clearAll();
      expect(fs.unlink).toHaveBeenCalledWith(mockTokenPath);
    });

    it('isTokenExpired should return true for expired token', () => {
      const storage = new MCPOAuthTokenStorage();
      const expiredToken: OAuthToken = {
        accessToken: 'token',
        tokenType: 'bearer',
        expiresAt: Date.now() - 1000,
      };
      expect(storage.isTokenExpired(expiredToken)).toBe(true);
    });

    it('isTokenExpired should return false for non-expired token', () => {
      const storage = new MCPOAuthTokenStorage();
      const validToken: OAuthToken = {
        accessToken: 'token',
        tokenType: 'bearer',
        expiresAt: Date.now() + 10 * 60 * 1000,
      }; // expires in 10 mins
      expect(storage.isTokenExpired(validToken)).toBe(false);
    });

    it('isTokenExpired should return false for token without expiry', () => {
      const storage = new MCPOAuthTokenStorage();
      const noExpiryToken: OAuthToken = {
        accessToken: 'token',
        tokenType: 'bearer',
      };
      expect(storage.isTokenExpired(noExpiryToken)).toBe(false);
    });
  });
});
