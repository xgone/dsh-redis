import { resolveConfig } from './config.js';
import { buildRedisTools } from './tools.js';

export const name = 'redis';
export const inject = ['tools'];

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const { tools } = buildRedisTools(cfg);
  const disposers = tools.map((definition) => ctx.tools.register(definition));

  if (cfg.writeApproval) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'redis_set' && exec.name !== 'redis_delete') return next();
      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
      const keyText = exec.name === 'redis_delete'
        ? (Array.isArray(args.keys) ? args.keys.join(', ').slice(0, 200) : '')
        : (typeof args.key === 'string' ? args.key.slice(0, 200) : '');
      return {
        kind: 'ask',
        reason: 'Redis 写操作需要确认：' + exec.name + (keyText === '' ? '' : ' (' + keyText + ')'),
      };
    });
  }

  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose();
  });
}

export * from './config.js';
export * from './resp.js';
export * from './tools.js';
