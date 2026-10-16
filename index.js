import { resolveConfig } from './config.js';
import { buildRedisTools } from './tools.js';

export const name = 'redis';
export const inject = ['tools', 'userQuestions'];

const REDIS_WRITE_QUESTION_ID = 'redis-write-operation';
const REDIS_WRITE_TOOLS = new Set([
  'redis_set',
  'redis_delete',
  'redis_hset',
  'redis_hdel',
  'redis_zadd',
  'redis_zrem',
  'redis_sadd',
  'redis_srem',
  'redis_list_push',
  'redis_lrem',
]);

function describeWrite(exec) {
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const connection = typeof args.connection === 'string' && args.connection !== '' ? args.connection : '默认连接';
  const labels = {
    redis_set: '写入或更新 string key',
    redis_delete: '删除 key',
    redis_hset: '写入或更新 hash field',
    redis_hdel: '删除 hash field',
    redis_zadd: '写入或更新 sorted-set member',
    redis_zrem: '删除 sorted-set member',
    redis_sadd: '向 set 新增 member',
    redis_srem: '从 set 删除 member',
    redis_list_push: '向 list 追加值',
    redis_lrem: '从 list 删除匹配值',
  };
  const list = exec.name === 'redis_delete'
    ? args.keys
    : exec.name === 'redis_hset' || exec.name === 'redis_hdel'
      ? (exec.name === 'redis_hset' && args.fields && typeof args.fields === 'object' ? Object.keys(args.fields) : args.fields)
      : exec.name === 'redis_zadd' || exec.name === 'redis_zrem' || exec.name === 'redis_sadd' || exec.name === 'redis_srem'
        ? args.members
        : exec.name === 'redis_list_push'
          ? args.values
          : undefined;
  const targetList = Array.isArray(list)
    ? list.map((item) => typeof item === 'object' && item !== null ? item.member ?? item.field ?? '' : item).filter((item) => typeof item === 'string').join(', ')
    : exec.name === 'redis_hset' && args.fields && typeof args.fields === 'object'
      ? Object.keys(args.fields).join(', ')
      : '';
  const targetSummary = typeof args.key === 'string'
    ? args.key + (targetList === '' ? '' : ' [' + targetList + ']')
    : Array.isArray(list) ? targetList : '';
  const clipped = targetSummary.length > 300 ? targetSummary.slice(0, 300) + '…' : targetSummary;
  return {
    question: '允许 Redis ' + (labels[exec.name] ?? '写操作') + '？',
    detail: '连接：' + connection + (clipped === '' ? '' : '\nKey/成员：' + clipped),
  };
}

export async function requestRedisWriteApproval(userQuestions, exec) {
  if (!exec.agent) {
    return { kind: 'deny', reason: 'Redis 写操作需要当前会话中的用户确认。' };
  }
  const { question, detail } = describeWrite(exec);
  try {
    const answer = await userQuestions.ask({
      agent: exec.agent,
      signal: exec.signal,
      questions: [{
        id: REDIS_WRITE_QUESTION_ID,
        header: 'Redis 写入确认',
        question,
        detail,
        options: [
          { label: '允许本次操作', description: '仅执行这次 Redis 写入或删除。' },
          { label: '拒绝', description: '取消这次 Redis 写操作。' },
        ],
      }],
    });
    const decision = answer.answers.find((item) => item.id === REDIS_WRITE_QUESTION_ID);
    if (decision?.selected.includes('允许本次操作')) return { kind: 'allow' };
    return { kind: 'deny', reason: '用户拒绝或未确认 Redis 写操作。' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'deny', reason: '无法取得 Redis 写操作确认：' + reason };
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const { tools } = buildRedisTools(cfg);
  const disposers = tools.map((definition) => ctx.tools.register(definition));

  if (cfg.writeApproval) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!REDIS_WRITE_TOOLS.has(exec.name)) return next();
      return requestRedisWriteApproval(ctx.userQuestions, exec);
    });
  }

  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose();
  });
}

export * from './config.js';
export * from './resp.js';
export * from './tools.js';
