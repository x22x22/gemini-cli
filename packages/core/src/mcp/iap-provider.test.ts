/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IAPProvider } from './iap-provider.js';
import type { MCPServerConfig } from '../config/config.js';

const mockFetchIdToken = vi.fn();
const mockGetIdTokenClient = vi.fn(() => ({
  idTokenProvider: {
    fetchIdToken: mockFetchIdToken,
  },
}));

// Mock the google-auth-library to use a shared mock function
vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  return {
    ...actual,
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getIdTokenClient: mockGetIdTokenClient,
    })),
  };
});

describe('IAPProvider', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it('should throw an error if no URL is provided', () => {
    const config: MCPServerConfig = {};
    expect(() => new IAPProvider(config)).toThrow(
      'A url or httpUrl must be provided for the IAP provider'
    );
  });

  it('should correctly get tokens for a valid config', async () => {
    const validConfig: MCPServerConfig = {
      url: 'https://my-iap-service.run.app',
    };

    const mockToken = 'mock-id-token-123';
    mockFetchIdToken.mockResolvedValue(mockToken);

    const provider = new IAPProvider(validConfig);
    const tokens = await provider.tokens();

    expect(tokens).toBeDefined();
    expect(tokens?.access_token).toBe(mockToken);
    expect(tokens?.token_type).toBe('Bearer');
  });

  it('should return undefined if token acquisition fails', async () => {
    const validConfig: MCPServerConfig = {
      url: 'https://my-iap-service.run.app',
    };

    mockFetchIdToken.mockResolvedValue(null);

    const provider = new IAPProvider(validConfig);
    const tokens = await provider.tokens();

    expect(tokens).toBeUndefined();
  });

  it('should use only the base URL when requesting a token', async () => {
    const configWithFullPath: MCPServerConfig = {
      url: 'https://my-iap-service.run.app/sse/v1/endpoint',
    };

    const provider = new IAPProvider(configWithFullPath);
    await provider.tokens();

    // Assert that getIdTokenClient was called with just the base URL.
    expect(mockGetIdTokenClient).toHaveBeenCalledWith(
      'https://my-iap-service.run.app'
    );
  });

  it('should use httpUrl when available', async () => {
    const configWithHttpUrl: MCPServerConfig = {
      httpUrl: 'https://my-other-iap-service.run.app/api',
      url: 'https://should-be-ignored.com', // This should be ignored
    };

    const provider = new IAPProvider(configWithHttpUrl);
    await provider.tokens();

    // Assert that getIdTokenClient was called with the base URL from httpUrl.
    expect(mockGetIdTokenClient).toHaveBeenCalledWith(
      'https://my-other-iap-service.run.app'
    );
  });
});

