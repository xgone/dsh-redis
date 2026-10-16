import { executeRedisCommand } from './resp.js';

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredText(args, key, label) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' (' + key + ') must be a non-empty string.');
  }
  return value;
}

function optionalText(args, key) {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function executionSignal(exec) {
  return exec && exec.signal instanceof AbortSignal ? exec.signal : undefined;
}

function command(cfg, connection, args, signal) {
  return executeRedisCommand({ ...connection, operationTimeoutMs: cfg.operationTimeoutMs }, args, signal);
}

function selectConnection(cfg, name) {
  const requested = name ?? cfg.defaultConnection;
  const connection = cfg.connections.find((item) => item.name.toLowerCase() === requested.toLowerCase());
  if (!connection) {
    throw new Error('Redis connection not found: ' + requested + '. Use redis_list to see configured connections.');
  }
  return connection;
}

function connectionSummary(connection) {
  return {
    name: connection.name,
    host: connection.host,
    port: connection.port,
    db: connection.db,
    tls: connection.tls,
  };
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderJson(_args, value) {
  const text = jsonText(value);
  return [{ type: 'text', text: text.length > 12000 ? text.slice(0, 12000) + '\n... output truncated' : text }];
}

function output(schema) {
  return { schema: { type: 'object', additionalProperties: true, ...schema }, render: renderJson };
}

// Leave a small grace period for the Host to observe our timeout result before
// its own tool watchdog aborts the execution.
function toolTimeout(cfg) {
  return cfg.operationTimeoutMs + 5000;
}

function parseMaybeJson(raw, parseJson) {
  if (!parseJson || typeof raw !== 'string') return { value: raw, parsed: false };
  try {
    return { value: JSON.parse(raw), parsed: true };
  } catch {
    return { value: raw, parsed: false };
  }
}

function limitString(value, maxLength) {
  if (typeof value !== 'string' || value.length <= maxLength) return { value, truncated: false };
  return { value: value.slice(0, maxLength), truncated: true };
}

function pairsToObject(items, maxItems) {
  const object = {};
  const values = Array.isArray(items) ? items : [];
  const limit = Math.min(values.length - (values.length % 2), maxItems * 2);
  for (let index = 0; index + 1 < limit; index += 2) object[String(values[index])] = values[index + 1];
  return { value: object, truncated: values.length > limit };
}

async function scanCollection(cfg, connection, commandName, key, signal) {
  let cursor = '0';
  const values = [];
  let truncated = false;
  do {
    const response = await command(cfg, connection, [commandName, key, cursor, 'COUNT', String(Math.min(1000, cfg.maxCollectionItems + 1))], signal);
    if (!Array.isArray(response) || !Array.isArray(response[1])) throw new Error(commandName + ' returned an invalid response.');
    cursor = String(response[0] ?? '0');
    values.push(...response[1]);
    if (values.length > cfg.maxCollectionItems) {
      truncated = true;
      break;
    }
  } while (cursor !== '0');
  return { values: values.slice(0, cfg.maxCollectionItems), truncated: truncated || cursor !== '0' };
}

async function readKey(cfg, connection, key, signal, parseJson) {
  const type = String(await command(cfg, connection, ['TYPE', key], signal));
  if (type === 'none') return { exists: false, key, type, value: null, ttl: -2 };
  const ttl = Number(await command(cfg, connection, ['TTL', key], signal));
  if (type === 'string') {
    const raw = await command(cfg, connection, ['GET', key], signal);
    const limited = limitString(raw, cfg.maxStringLength);
    const parsed = parseMaybeJson(limited.value, parseJson && !limited.truncated);
    return {
      exists: true,
      key,
      type,
      ttl,
      value: parsed.value,
      rawValue: limited.value,
      parsedJson: parsed.parsed,
      truncated: limited.truncated,
    };
  }
  if (type === 'list') {
    const raw = await command(cfg, connection, ['LRANGE', key, '0', String(cfg.maxCollectionItems)], signal);
    const values = Array.isArray(raw) ? raw : [];
    return {
      exists: true,
      key,
      type,
      ttl,
      value: values.slice(0, cfg.maxCollectionItems),
      truncated: values.length > cfg.maxCollectionItems,
    };
  }
  if (type === 'hash') {
    const raw = await scanCollection(cfg, connection, 'HSCAN', key, signal);
    const pairs = pairsToObject(raw.values, cfg.maxCollectionItems);
    return { exists: true, key, type, ttl, value: pairs.value, truncated: raw.truncated || pairs.truncated };
  }
  if (type === 'set') {
    const raw = await scanCollection(cfg, connection, 'SSCAN', key, signal);
    return { exists: true, key, type, ttl, value: raw.values, truncated: raw.truncated };
  }
  if (type === 'zset') {
    const raw = await command(cfg, connection, ['ZRANGE', key, '0', String(cfg.maxCollectionItems), 'WITHSCORES'], signal);
    const values = Array.isArray(raw) ? raw : [];
    const value = [];
    for (let index = 0; index + 1 < values.length && value.length < cfg.maxCollectionItems; index += 2) {
      const score = Number(values[index + 1]);
      value.push({ member: values[index], score: Number.isFinite(score) ? score : values[index + 1] });
    }
    return { exists: true, key, type, ttl, value, truncated: values.length > cfg.maxCollectionItems * 2 };
  }
  return { exists: true, key, type, ttl, value: null, supported: false };
}

async function pingConnection(cfg, connection, signal) {
  const result = connectionSummary(connection);
  try {
    const reply = await command(cfg, connection, ['PING'], signal);
    result.ok = reply === 'PONG';
    if (!result.ok) result.error = 'Unexpected PING reply: ' + String(reply);
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function buildRedisListTool(cfg) {
  return {
    name: 'redis_list',
    description: '列出配置的 Redis 连接并逐一执行 PING 连通性检查，不回显密码。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: output({ properties: { connections: { type: 'array', items: { type: 'object', additionalProperties: true } } } }),
    async execute(_rawArgs, exec) {
      const signal = executionSignal(exec);
      const connections = await Promise.all(cfg.connections.map((connection) => pingConnection(cfg, connection, signal)));
      return { connections, defaultConnection: cfg.defaultConnection };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => true,
  };
}

function buildRedisHealthTool(cfg) {
  return {
    name: 'redis_health',
    description: '检查 Redis 插件配置和所有连接状态，适合在读写前诊断连接问题。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: output({ properties: { ok: { type: 'boolean' }, connections: { type: 'array', items: { type: 'object', additionalProperties: true } } } }),
    async execute(_rawArgs, exec) {
      const signal = executionSignal(exec);
      const connections = await Promise.all(cfg.connections.map((connection) => pingConnection(cfg, connection, signal)));
      return {
        ok: connections.every((item) => item.ok === true),
        plugin: 'dsh-redis',
        defaultConnection: cfg.defaultConnection,
        connections,
        writeApproval: cfg.writeApproval,
        maxScanKeys: cfg.maxScanKeys,
        maxCollectionItems: cfg.maxCollectionItems,
        operationTimeoutMs: cfg.operationTimeoutMs,
      };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => true,
  };
}

function buildRedisGetTool(cfg) {
  return {
    name: 'redis_get',
    description: '按 key 查询 Redis 值，返回类型、TTL 和内容；支持 string、hash、list、set、zset，默认连接可省略。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis key。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
        parseJson: { type: 'boolean', description: 'string 值是否尝试 JSON.parse；原始文本仍会在 rawValue 中返回。', default: false },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, type: { type: 'string' }, ttl: { type: 'integer' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      return readKey(cfg, connection, key, executionSignal(exec), args.parseJson === true);
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => true,
  };
}

function encodeValue(value, json) {
  if (typeof value === 'string') return value;
  if (!json) throw new Error('value must be a string when json=false.');
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('value cannot be JSON serialized.');
    return encoded;
  } catch (error) {
    throw new Error('value cannot be JSON serialized: ' + (error instanceof Error ? error.message : String(error)));
  }
}

function buildRedisSetTool(cfg) {
  return {
    name: 'redis_set',
    description: '创建或更新 Redis key。value 支持字符串或可 JSON 序列化的值；可设置 TTL，并用 nx/xx 控制是否仅在不存在/存在时写入。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis key。' },
        value: { description: '要写入的字符串或 JSON 值。字符串按原文写入。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
        json: { type: 'boolean', description: '非字符串 value 是否 JSON.stringify，默认 true。', default: true },
        ttlSeconds: { type: 'integer', description: '可选过期时间，单位秒，必须大于 0。' },
        onlyIf: { type: 'string', enum: ['always', 'nx', 'xx'], description: 'always 无条件写入；nx 仅 key 不存在；xx 仅 key 已存在。', default: 'always' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    output: output({ properties: { ok: { type: 'boolean' }, key: { type: 'string' }, result: { type: 'string' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Object.prototype.hasOwnProperty.call(args, 'value')) throw new Error('value is required.');
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const json = args.json !== false;
      const serialized = encodeValue(args.value, json);
      const onlyIf = args.onlyIf === undefined ? 'always' : args.onlyIf;
      if (onlyIf !== 'always' && onlyIf !== 'nx' && onlyIf !== 'xx') throw new Error('onlyIf must be always, nx, or xx.');
      const commandArgs = ['SET', key, serialized];
      if (args.ttlSeconds !== undefined) {
        if (typeof args.ttlSeconds !== 'number' || !Number.isInteger(args.ttlSeconds) || args.ttlSeconds <= 0) {
          throw new Error('ttlSeconds must be a positive integer.');
        }
        commandArgs.push('EX', String(args.ttlSeconds));
      }
      if (onlyIf === 'nx') commandArgs.push('NX');
      if (onlyIf === 'xx') commandArgs.push('XX');
      const result = await command(cfg, connection, commandArgs, executionSignal(exec));
      return {
        ok: result === 'OK',
        key,
        connection: connection.name,
        result: result === null ? 'NOT_MODIFIED' : String(result),
        serializedLength: serialized.length,
        ttlSeconds: args.ttlSeconds ?? null,
        onlyIf,
      };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisDeleteTool(cfg) {
  return {
    name: 'redis_delete',
    description: '删除一个或多个 Redis key，返回实际删除数量。',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: '要删除的 key 列表。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    output: output({ properties: { deleted: { type: 'integer' }, keys: { type: 'array', items: { type: 'string' } } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('keys must be a non-empty array.');
      const keys = args.keys.map((key) => {
        if (typeof key !== 'string' || key.length === 0) throw new Error('Every Redis key must be a non-empty string.');
        return key;
      });
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const deleted = Number(await command(cfg, connection, ['DEL', ...keys], executionSignal(exec)));
      return { connection: connection.name, keys, deleted };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisHSetTool(cfg) {
  return {
    name: 'redis_hset',
    description: '向 Redis hash 新增或更新一个或多个 field；非字符串值会按 JSON 序列化。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis hash key。' },
        fields: { type: 'object', description: 'field 到 value 的映射；字符串按原文写入，其他值按 JSON 序列化。', additionalProperties: true },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'fields'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, updated: { type: 'integer' }, fields: { type: 'array', items: { type: 'string' } } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      const fields = asRecord(args.fields);
      const entries = Object.entries(fields);
      if (entries.length === 0) throw new Error('fields must contain at least one hash field.');
      const commandArgs = ['HSET', key];
      for (const [field, value] of entries) {
        if (field.length === 0) throw new Error('Hash field names must be non-empty strings.');
        commandArgs.push(field, encodeValue(value, true));
      }
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const updated = Number(await command(cfg, connection, commandArgs, executionSignal(exec)));
      return { connection: connection.name, key, fields: entries.map(([field]) => field), updated };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisHDelTool(cfg) {
  return {
    name: 'redis_hdel',
    description: '从 Redis hash 删除一个或多个 field，返回实际删除数量。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis hash key。' },
        fields: { type: 'array', items: { type: 'string' }, description: '要删除的 field 列表。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'fields'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, deleted: { type: 'integer' }, fields: { type: 'array', items: { type: 'string' } } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Array.isArray(args.fields) || args.fields.length === 0) throw new Error('fields must be a non-empty array.');
      const fields = args.fields.map((field) => {
        if (typeof field !== 'string' || field.length === 0) throw new Error('Every hash field must be a non-empty string.');
        return field;
      });
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const deleted = Number(await command(cfg, connection, ['HDEL', key, ...fields], executionSignal(exec)));
      return { connection: connection.name, key, fields, deleted };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisZAddTool(cfg) {
  return {
    name: 'redis_zadd',
    description: '向 Redis sorted set 新增或更新 member 和 score，支持 always/nx/xx 条件写入。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis sorted-set key。' },
        members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              member: { type: 'string', description: '有序集合成员。' },
              score: { type: 'number', description: '有限数值 score。' },
            },
            required: ['member', 'score'],
            additionalProperties: false,
          },
          description: '要写入的 member/score 列表。',
        },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
        onlyIf: { type: 'string', enum: ['always', 'nx', 'xx'], description: 'always 无条件写入；nx 仅新增成员；xx 仅更新已存在成员。', default: 'always' },
      },
      required: ['key', 'members'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, changed: { type: 'integer' }, members: { type: 'integer' }, onlyIf: { type: 'string' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Array.isArray(args.members) || args.members.length === 0) throw new Error('members must be a non-empty array.');
      const members = args.members.map((item) => {
        const entry = asRecord(item);
        const member = requiredText(entry, 'member', 'Sorted-set member');
        if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) throw new Error('Every sorted-set score must be a finite number.');
        return { member, score: String(entry.score) };
      });
      const onlyIf = args.onlyIf === undefined ? 'always' : args.onlyIf;
      if (!['always', 'nx', 'xx'].includes(onlyIf)) throw new Error('onlyIf must be always, nx, or xx.');
      const commandArgs = ['ZADD', key];
      if (onlyIf !== 'always') commandArgs.push(onlyIf.toUpperCase());
      for (const item of members) commandArgs.push(item.score, item.member);
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const changed = Number(await command(cfg, connection, commandArgs, executionSignal(exec)));
      return { connection: connection.name, key, members: members.length, changed, onlyIf };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisZRemTool(cfg) {
  return {
    name: 'redis_zrem',
    description: '从 Redis sorted set 删除一个或多个 member，返回实际删除数量。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis sorted-set key。' },
        members: { type: 'array', items: { type: 'string' }, description: '要删除的成员列表。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'members'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, deleted: { type: 'integer' }, members: { type: 'array', items: { type: 'string' } } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Array.isArray(args.members) || args.members.length === 0) throw new Error('members must be a non-empty array.');
      const members = args.members.map((member) => {
        if (typeof member !== 'string' || member.length === 0) throw new Error('Every sorted-set member must be a non-empty string.');
        return member;
      });
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const deleted = Number(await command(cfg, connection, ['ZREM', key, ...members], executionSignal(exec)));
      return { connection: connection.name, key, members, deleted };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisSetMemberTool(cfg, redisCommand, toolName, action) {
  return {
    name: toolName,
    description: action + ' Redis set 中的一个或多个 member，返回实际新增或删除数量。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis set key。' },
        members: { type: 'array', items: { type: 'string' }, description: '要操作的成员列表。' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'members'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, affected: { type: 'integer' }, members: { type: 'array', items: { type: 'string' } } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Array.isArray(args.members) || args.members.length === 0) throw new Error('members must be a non-empty array.');
      const members = args.members.map((member) => {
        if (typeof member !== 'string' || member.length === 0) throw new Error('Every set member must be a non-empty string.');
        return member;
      });
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const affected = Number(await command(cfg, connection, [redisCommand, key, ...members], executionSignal(exec)));
      return { connection: connection.name, key, members, affected };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisListPushTool(cfg) {
  return {
    name: 'redis_list_push',
    description: '向 Redis list 左侧或右侧追加一个或多个值；非字符串值按 JSON 序列化。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis list key。' },
        values: { type: 'array', items: {}, description: '要追加的字符串或 JSON 值。' },
        side: { type: 'string', enum: ['left', 'right'], description: 'left 对应 LPUSH，right 对应 RPUSH。', default: 'right' },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'values'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, length: { type: 'integer' }, pushed: { type: 'integer' }, side: { type: 'string' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Array.isArray(args.values) || args.values.length === 0) throw new Error('values must be a non-empty array.');
      const side = args.side === undefined ? 'right' : args.side;
      if (side !== 'left' && side !== 'right') throw new Error('side must be left or right.');
      const values = args.values.map((value) => encodeValue(value, true));
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const length = Number(await command(cfg, connection, [side === 'left' ? 'LPUSH' : 'RPUSH', key, ...values], executionSignal(exec)));
      return { connection: connection.name, key, length, pushed: values.length, side };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisLRemTool(cfg) {
  return {
    name: 'redis_lrem',
    description: '从 Redis list 删除指定值；count=0 删除所有匹配项，正数从头部开始，负数从尾部开始计数。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis list key。' },
        value: { description: '要匹配删除的字符串或 JSON 值。' },
        count: { type: 'integer', description: '删除数量规则，默认 0 表示删除所有匹配项。', default: 0 },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    output: output({ properties: { key: { type: 'string' }, removed: { type: 'integer' }, count: { type: 'integer' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const key = requiredText(args, 'key', 'Redis key');
      if (!Object.prototype.hasOwnProperty.call(args, 'value')) throw new Error('value is required.');
      const count = args.count === undefined ? 0 : args.count;
      if (typeof count !== 'number' || !Number.isInteger(count)) throw new Error('count must be an integer.');
      const value = encodeValue(args.value, true);
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const removed = Number(await command(cfg, connection, ['LREM', key, String(count), value], executionSignal(exec)));
      return { connection: connection.name, key, removed, count };
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => false,
  };
}

function buildRedisScanTool(cfg) {
  return {
    name: 'redis_scan',
    description: '使用 Redis SCAN 分页查找 key，默认只返回 key 名；可选 includeValues=true 获取 string 值。结果受 maxKeys 和插件 maxScanKeys 限制。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'SCAN MATCH 模式，可选，默认 *。' },
        maxKeys: { type: 'integer', description: '最多返回多少个 key，可选。' },
        includeValues: { type: 'boolean', description: '是否额外获取 string 类型的值，默认 false。', default: false },
        connection: { type: 'string', description: '连接名，可选，缺省使用默认连接。' },
      },
      additionalProperties: false,
    },
    output: output({ properties: { keys: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' } } }),
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const connection = selectConnection(cfg, optionalText(args, 'connection'));
      const requestedMax = args.maxKeys === undefined ? cfg.maxScanKeys : args.maxKeys;
      if (typeof requestedMax !== 'number' || !Number.isInteger(requestedMax) || requestedMax <= 0) throw new Error('maxKeys must be a positive integer.');
      const maxKeys = Math.min(requestedMax, cfg.maxScanKeys);
      const pattern = optionalText(args, 'pattern') ?? '*';
      const signal = executionSignal(exec);
      let cursor = '0';
      const keys = [];
      let truncated = false;
      do {
        const scanArgs = ['SCAN', cursor, 'COUNT', String(Math.min(1000, maxKeys + 1))];
        if (pattern !== '*') scanArgs.splice(2, 0, 'MATCH', pattern);
        const response = await command(cfg, connection, scanArgs, signal);
        if (!Array.isArray(response) || !Array.isArray(response[1])) throw new Error('SCAN returned an invalid response.');
        cursor = String(response[0] ?? '0');
        keys.push(...response[1].map(String));
        if (keys.length >= maxKeys) {
          truncated = keys.length > maxKeys || cursor !== '0';
          break;
        }
      } while (cursor !== '0');
      const result = { connection: connection.name, pattern, keys: keys.slice(0, maxKeys), truncated: truncated || cursor !== '0' };
      if (args.includeValues === true) {
        const values = [];
        for (const key of result.keys) {
          const type = String(await command(cfg, connection, ['TYPE', key], signal));
          values.push({ key, type, value: type === 'string' ? await command(cfg, connection, ['GET', key], signal) : null });
        }
        result.values = values;
      }
      return result;
    },
    timeoutMs: toolTimeout(cfg),
    isConcurrencySafe: () => true,
  };
}

export function buildRedisTools(cfg) {
  return {
    tools: [
      buildRedisListTool(cfg),
      buildRedisHealthTool(cfg),
      buildRedisGetTool(cfg),
      buildRedisSetTool(cfg),
      buildRedisDeleteTool(cfg),
      buildRedisHSetTool(cfg),
      buildRedisHDelTool(cfg),
      buildRedisZAddTool(cfg),
      buildRedisZRemTool(cfg),
      buildRedisSetMemberTool(cfg, 'SADD', 'redis_sadd', '新增'),
      buildRedisSetMemberTool(cfg, 'SREM', 'redis_srem', '删除'),
      buildRedisListPushTool(cfg),
      buildRedisLRemTool(cfg),
      buildRedisScanTool(cfg),
    ],
  };
}
