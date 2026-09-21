const DEFAULT_URL = 'redis://127.0.0.1:6379/0';

export function passwordEnvName(name) {
  return 'DSH_REDIS_PASSWORD_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

export function urlEnvName(name) {
  return 'DSH_REDIS_URL_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function decodeUrlPart(value) {
  if (value === '') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive integer.');
  }
  return Math.min(maximum, value);
}

function buildUrl(raw) {
  const protocol = raw.tls === true ? 'rediss' : 'redis';
  const host = typeof raw.host === 'string' && raw.host.trim() !== '' ? raw.host.trim() : '127.0.0.1';
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 6379;
  const db = typeof raw.db === 'number' && Number.isInteger(raw.db) && raw.db >= 0 ? raw.db : 0;
  const authority = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  return protocol + '://' + authority + ':' + port + '/' + db;
}

function parseConnection(raw, name, env) {
  const urlValue = typeof raw.url === 'string' && raw.url.trim() !== ''
    ? raw.url.trim()
    : (env[urlEnvName(name)]?.trim() || buildUrl(raw));

  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error('Redis connection ' + name + ' has an invalid URL.');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('Redis connection ' + name + ' URL must use redis:// or rediss://.');
  }

  const dbText = parsed.pathname.replace(/^\//, '');
  const db = dbText === '' ? 0 : Number(dbText);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error('Redis connection ' + name + ' database must be a non-negative integer.');
  }

  const port = parsed.port === '' ? 6379 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Redis connection ' + name + ' has an invalid port.');
  }

  const configuredPassword = typeof raw.password === 'string' ? raw.password : '';
  const password = configuredPassword !== ''
    ? configuredPassword
    : (decodeUrlPart(parsed.password) || env[passwordEnvName(name)]?.trim() || '');
  const username = typeof raw.username === 'string' && raw.username !== ''
    ? raw.username
    : decodeUrlPart(parsed.username);
  const tlsEnabled = parsed.protocol === 'rediss:' || raw.tls === true;

  return {
    name,
    host: parsed.hostname,
    port,
    db,
    username,
    password,
    tls: tlsEnabled,
    tlsServername: typeof raw.tlsServername === 'string' && raw.tlsServername !== '' ? raw.tlsServername : parsed.hostname,
    rejectUnauthorized: raw.rejectUnauthorized !== false,
  };
}

export function resolveConfig(config, env = process.env) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const rawConnections = Array.isArray(cfg.connections) && cfg.connections.length > 0
    ? cfg.connections
    : [{ name: 'local', url: typeof cfg.url === 'string' && cfg.url.trim() !== '' ? cfg.url.trim() : (env.DSH_REDIS_URL || DEFAULT_URL) }];

  const connections = [];
  const seen = new Set();
  for (const raw of rawConnections) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Redis connections entries must be objects.');
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '') throw new Error('Each Redis connection needs a non-empty name.');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate Redis connection name: ' + name + '.');
    seen.add(key);
    connections.push(parseConnection(raw, name, env));
  }

  const requestedDefault = typeof cfg.defaultConnection === 'string' ? cfg.defaultConnection.trim() : '';
  const defaultConnection = requestedDefault || connections[0].name;
  if (!connections.some((item) => item.name.toLowerCase() === defaultConnection.toLowerCase())) {
    throw new Error('Unknown default Redis connection: ' + defaultConnection + '.');
  }

  return {
    connections,
    defaultConnection,
    maxScanKeys: positiveInteger(cfg.maxScanKeys, 1000, 'maxScanKeys', 10000),
    maxCollectionItems: positiveInteger(cfg.maxCollectionItems, 1000, 'maxCollectionItems', 10000),
    maxStringLength: positiveInteger(cfg.maxStringLength, 1000000, 'maxStringLength', 10000000),
    operationTimeoutMs: positiveInteger(cfg.operationTimeoutMs, 30000, 'operationTimeoutMs', 600000),
    writeApproval: cfg.writeApproval !== false,
  };
}
