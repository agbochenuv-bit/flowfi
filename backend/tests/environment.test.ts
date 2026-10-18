import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../src/config/environment.js';

describe('validateEnvironment', () => {
  it('allows local development without deployment-only values', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://flowfi:flowfi_dev_password@localhost:5433/flowfi',
    })).not.toThrow();
  });

  it('rejects missing production database, signing, RPC, and deployment values', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL is required.*JWT_SECRET is required.*SOROBAN_RPC_URL.*CORS_ALLOWED_ORIGINS.*API_BASE_URL.*STREAM_CONTRACT_ID/s,
    );
  });

  it('rejects placeholder database credentials and weak or placeholder JWT secrets', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:password@localhost:5432/flowfi',
      JWT_SECRET: 'replace-me',
    })).toThrow(/placeholder credentials.*at least 32 bytes.*placeholder/s);
  });

  it('rejects startup without a database outside test mode', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'development' })).toThrow(
      'DATABASE_URL is required before backend services start',
    );
  });

  it('rejects unsafe production RPC, CORS, and sandbox combinations', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://flowfi:secret@db.internal:5432/flowfi',
      JWT_SECRET: 'a'.repeat(40),
      STELLAR_NETWORK: 'mainnet',
      SOROBAN_RPC_URL: 'http://soroban-testnet.example.org',
      CORS_ALLOWED_ORIGINS: '*',
      API_BASE_URL: 'http://api.example.org',
      STREAM_CONTRACT_ID: 'invalid-contract-id',
      SANDBOX_MODE_ENABLED: 'true',
    })).toThrow(/HTTPS in production.*Mainnet deployments.*CORS_ALLOWED_ORIGINS.*API_BASE_URL.*valid contract ID.*SANDBOX_MODE_ENABLED/s);
  });
});