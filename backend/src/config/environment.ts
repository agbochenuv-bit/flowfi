import { Keypair, StrKey } from '@stellar/stellar-sdk';

const PLACEHOLDER_VALUES = new Set([
  'change-me',
  'changeme',
  'your-secret',
  'your-secret-key',
  'replace-me',
  'placeholder',
  'password',
  'user',
]);

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDER_VALUES.has(normalized) ||
    normalized.includes('your_') ||
    normalized.includes('example') ||
    normalized.includes('...');
}

function parseUrl(value: string, key: string, errors: string[]): URL | undefined {
  try {
    return new URL(value);
  } catch {
    errors.push(`${key} must be a valid URL`);
    return undefined;
  }
}

export function validateEnvironment(env: Record<string, string | undefined>): void {
  const errors: string[] = [];
  const production = env.NODE_ENV === 'production';
  if (env.NODE_ENV && !['development', 'test', 'production'].includes(env.NODE_ENV)) {
    errors.push('NODE_ENV must be development, test, or production');
  }
  const databaseUrl = env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    if (env.NODE_ENV !== 'test') errors.push('DATABASE_URL is required before backend services start');
  } else {
    const parsed = parseUrl(databaseUrl, 'DATABASE_URL', errors);
    if (parsed) {
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        errors.push('DATABASE_URL must use the postgres or postgresql scheme');
      }
      if (!parsed.hostname || !parsed.username || !parsed.password) {
        errors.push('DATABASE_URL must include a host, username, and password');
      }
      if ([parsed.username, parsed.password].some(isPlaceholder)) {
        errors.push('DATABASE_URL must not contain placeholder credentials');
      }
      if (isPlaceholder(parsed.hostname)) {
        errors.push('DATABASE_URL must not use a placeholder host');
      }
      if (production && /localhost|127\.|\.local$/i.test(parsed.hostname)) {
        errors.push('DATABASE_URL must not use a local database host in production');
      }
    }
  }

  const sandboxDatabaseUrl = env.SANDBOX_DATABASE_URL?.trim();
  if (sandboxDatabaseUrl) {
    const parsed = parseUrl(sandboxDatabaseUrl, 'SANDBOX_DATABASE_URL', errors);
    if (parsed) {
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        errors.push('SANDBOX_DATABASE_URL must use the postgres or postgresql scheme');
      }
      if (!parsed.hostname || !parsed.username || !parsed.password) {
        errors.push('SANDBOX_DATABASE_URL must include a host, username, and password');
      }
      if ([parsed.username, parsed.password].some(isPlaceholder)) {
        errors.push('SANDBOX_DATABASE_URL must not contain placeholder credentials');
      }
      if (production && /localhost|127\.|\.local$/i.test(parsed.hostname)) {
        errors.push('SANDBOX_DATABASE_URL must not use a local database host in production');
      }
    }
  }

  const jwtSecret = env.JWT_SECRET?.trim();
  if (production && !jwtSecret) errors.push('JWT_SECRET is required in production');
  if (jwtSecret) {
    if (Buffer.byteLength(jwtSecret) < 32) {
      errors.push('JWT_SECRET must be at least 32 bytes long');
    }
    if (isPlaceholder(jwtSecret)) errors.push('JWT_SECRET must not be a placeholder');
  }

  const keeperSecret = env.KEEPER_SECRET_KEY?.trim();
  if (production && !keeperSecret) errors.push('KEEPER_SECRET_KEY is required in production');
  if (keeperSecret) {
    if (isPlaceholder(keeperSecret)) errors.push('KEEPER_SECRET_KEY must not be a placeholder');
    else {
      try {
        Keypair.fromSecret(keeperSecret);
      } catch {
        errors.push('KEEPER_SECRET_KEY must be a valid Stellar secret seed');
      }
    }
  }

  const adminPublicKey = env.ADMIN_PUBLIC_KEY?.trim();
  if (production && !adminPublicKey) errors.push('ADMIN_PUBLIC_KEY is required in production');
  if (adminPublicKey && !StrKey.isValidEd25519PublicKey(adminPublicKey)) {
    errors.push('ADMIN_PUBLIC_KEY must be a valid Stellar public key');
  }

  const network = env.STELLAR_NETWORK?.trim().toLowerCase();
  if (production && network !== 'mainnet' && network !== 'testnet') {
    errors.push('STELLAR_NETWORK must be explicitly set to mainnet or testnet in production');
  }
  if (network && !['mainnet', 'testnet'].includes(network)) {
    errors.push('STELLAR_NETWORK must be mainnet or testnet');
  }

  const rpcValue = env.SOROBAN_RPC_URLS?.trim() || env.SOROBAN_RPC_URL?.trim();
  if (production && !env.SOROBAN_RPC_URL?.trim()) {
    errors.push('SOROBAN_RPC_URL is required in production because the indexer and contract service use it');
  }
  if (rpcValue) {
    const endpoints = rpcValue.split(',').map((endpoint) => endpoint.trim()).filter(Boolean);
    if (endpoints.length === 0) errors.push('At least one Soroban RPC endpoint is required');
    for (const endpoint of endpoints) {
      const parsed = parseUrl(endpoint, 'Soroban RPC endpoint', errors);
      if (!parsed) continue;
      if (parsed.protocol !== 'https:' && (production || parsed.protocol !== 'http:')) {
        errors.push('Soroban RPC endpoints must use HTTPS in production');
      }
      if (parsed.username || parsed.password) errors.push('Soroban RPC endpoints must not contain URL credentials');
      if (isPlaceholder(endpoint)) errors.push('Soroban RPC endpoints must not be placeholders');
      if (production && network === 'mainnet' && /testnet/i.test(parsed.hostname)) {
        errors.push('Mainnet deployments must not use a testnet Soroban RPC endpoint');
      }
      if (production && network === 'testnet' && /soroban-rpc\.stellar\.org$/i.test(parsed.hostname)) {
        errors.push('Testnet deployments must not use the mainnet Soroban RPC endpoint');
      }
    }
  }

  const port = env.PORT?.trim();
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  if (production) {
    if (!env.CORS_ALLOWED_ORIGINS?.trim()) {
      errors.push('CORS_ALLOWED_ORIGINS is required in production');
    } else {
      for (const origin of env.CORS_ALLOWED_ORIGINS.split(',')) {
        const value = origin.trim();
        const parsed = parseUrl(value, 'CORS_ALLOWED_ORIGINS entry', errors);
        if (value === '*' || !parsed || parsed.protocol !== 'https:' ||
          parsed.origin !== value || /localhost|127\./i.test(value)) {
          errors.push('CORS_ALLOWED_ORIGINS must contain only explicit HTTPS origins in production');
          break;
        }
      }
    }
    if (!env.API_BASE_URL?.trim()) errors.push('API_BASE_URL is required in production');
    else {
      const apiUrl = parseUrl(env.API_BASE_URL.trim(), 'API_BASE_URL', errors);
      if (apiUrl && (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password ||
        /localhost|127\.|\.local$/i.test(apiUrl.hostname))) {
        errors.push('API_BASE_URL must use a public HTTPS URL without credentials in production');
      }
      if (isPlaceholder(env.API_BASE_URL)) errors.push('API_BASE_URL must not be a placeholder');
    }
    if (env.CORS_ALLOWED_ORIGINS?.split(',').some(isPlaceholder)) {
      errors.push('CORS_ALLOWED_ORIGINS must not contain placeholder origins');
    }
    if (!env.STREAM_CONTRACT_ID?.trim() || !StrKey.isValidContract(env.STREAM_CONTRACT_ID.trim())) {
      errors.push('STREAM_CONTRACT_ID must be a valid contract ID in production');
    }
    if (env.SANDBOX_MODE_ENABLED?.trim().toLowerCase() === 'true') {
      errors.push('SANDBOX_MODE_ENABLED must not be true in production');
    }
  }

  const alertWebhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (alertWebhookUrl) {
    const parsed = parseUrl(alertWebhookUrl, 'ALERT_WEBHOOK_URL', errors);
    if (parsed && parsed.protocol !== 'https:') errors.push('ALERT_WEBHOOK_URL must use HTTPS');
    if (isPlaceholder(alertWebhookUrl)) errors.push('ALERT_WEBHOOK_URL must not be a placeholder');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
}