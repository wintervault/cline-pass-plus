import { describe, expect, it } from 'vitest';
import {
  injectPrefs,
  parsePlannedChain,
  parseRouting,
  SORT_KEYS,
  type SortKey,
  slugify,
  type UpstreamPrefs,
} from '../src/upstream/routing.ts';
import type { Pipeline } from '../src/upstream/types.ts';

// ---------- parseRouting ----------

describe('parseRouting', () => {
  it('planner 管道：message.provider_metadata.gateway.routing', () => {
    const r = parseRouting({
      data: {
        choices: [
          {
            message: {
              content: 'OK',
              provider_metadata: {
                gateway: {
                  routing: {
                    finalProvider: 'alibaba',
                    canonicalSlug: 'zai/glm-5.2',
                    fallbacksAvailable: ['baseten', 'targon'],
                    planningReasoning: 'alibaba won tier 0 over baseten and targon',
                  },
                },
              },
            },
          },
        ],
        usage: { total_tokens: 12 },
      },
    });
    expect(r.pipeline).toBe('planner');
    expect(r.finalProvider).toBe('alibaba');
    expect(r.finalProviderName).toBe('alibaba');
    expect(r.canonicalSlug).toBe('zai/glm-5.2');
    expect(r.fallbacks).toEqual(['baseten', 'targon']);
    expect(r.usage).toEqual({ total_tokens: 12 });
  });

  it('direct 管道：顶层 provider 显示名 + model 真实 ID', () => {
    const r = parseRouting({
      provider: 'GMICloud',
      model: 'zai-org/glm-5.3-flash',
      choices: [{ message: { content: 'OK' } }],
    });
    expect(r.pipeline).toBe('direct');
    expect(r.finalProvider).toBe('gmicloud');
    expect(r.finalProviderName).toBe('GMICloud');
    expect(r.canonicalSlug).toBe('zai-org/glm-5.3-flash');
  });

  it('无任何元数据 → pipeline 为 null', () => {
    const r = parseRouting({ choices: [{ message: { content: 'OK' } }] });
    expect(r.pipeline).toBeNull();
    expect(r.finalProvider).toBeNull();
    expect(r.canonicalSlug).toBeNull();
  });

  it('错误响应（带 error 无 choices）也能安全解析', () => {
    const r = parseRouting({ error: 'Available providers are: alibaba, baseten. ' });
    expect(r.pipeline).toBeNull();
    expect(r.content).toBeNull();
  });

  it('完全不是对象 → 不抛异常', () => {
    expect(parseRouting(null).pipeline).toBeNull();
    expect(parseRouting('oops').pipeline).toBeNull();
    expect(parseRouting(42).pipeline).toBeNull();
    expect(parseRouting([1, 2]).pipeline).toBeNull();
  });

  it('fallbacksAvailable 含非字符串时被过滤', () => {
    const r = parseRouting({
      provider_metadata: { gateway: { routing: { finalProvider: 'a', fallbacksAvailable: ['b', 42, null, 'c'] } } },
    });
    expect(r.fallbacks).toEqual(['b', 'c']);
  });
});

// ---------- injectPrefs ----------

const basePrefs = (over: Partial<UpstreamPrefs> = {}): UpstreamPrefs => ({
  upstream: null,
  orderRest: [],
  excludeList: [],
  strict: true,
  sort: null,
  ...over,
});

describe('injectPrefs', () => {
  it('planner：strict 注入 providerOptions.gateway.only', () => {
    const body = { model: 'cline-pass/x', messages: [] };
    const { body: out, degraded } = injectPrefs(
      body,
      { pipeline: 'planner', knownUpstreams: [], forceChannelBinding: false },
      basePrefs({ upstream: 'alibaba' }),
    );
    expect(degraded).toBe(false);
    expect(out['providerOptions']).toEqual({ gateway: { only: ['alibaba'] } });
    expect(out['provider']).toBeUndefined(); // planner 不动顶层 provider
  });

  it('planner：preferred 注入 order 首位 + 回退序列', () => {
    const body = {};
    const { body: out } = injectPrefs(
      body,
      { pipeline: 'planner', knownUpstreams: [], forceChannelBinding: false },
      basePrefs({ upstream: 'alibaba', orderRest: ['baseten', 'targon'], strict: false }),
    );
    expect(out['providerOptions']).toEqual({ gateway: { order: ['alibaba', 'baseten', 'targon'] } });
  });

  it('direct：strict 注入顶层 provider.only', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'direct', knownUpstreams: [] },
      basePrefs({ upstream: 'gmicloud' }),
    );
    expect(out['provider']).toEqual({ only: ['gmicloud'] });
    expect(out['providerOptions']).toBeUndefined(); // direct 不动 providerOptions
  });

  it('管道未知：两种形式同时注入（各自取用、互不干扰）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: null, knownUpstreams: [], forceChannelBinding: false },
      basePrefs({ upstream: 'alibaba' }),
    );
    expect(out['providerOptions']).toEqual({ gateway: { only: ['alibaba'] } });
    expect(out['provider']).toEqual({ only: ['alibaba'] });
  });

  it('排除换算成 only 白名单（自动模式）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: ['a', 'b', 'c', 'd'], forceChannelBinding: false },
      basePrefs({ excludeList: ['b'] }),
    );
    expect(out['providerOptions']).toEqual({ gateway: { only: ['a', 'c', 'd'] } });
  });

  it('preferred + 排除：order 首位之外仍带白名单（防止网关回退到被排除渠道）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: ['a', 'b', 'c'], forceChannelBinding: false },
      basePrefs({ upstream: 'a', orderRest: ['b'], excludeList: ['c'], strict: false }),
    );
    // 排除项同时从 orderRest 中剔除
    expect(out['providerOptions']).toEqual({ gateway: { order: ['a', 'b'], only: ['a', 'b'] } });
  });

  it('未探测过（已知清单为空）时排除失效 → degraded=true 且不注入错误的空白名单', () => {
    const { body: out, degraded } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [] },
      basePrefs({ excludeList: ['b'] }),
    );
    expect(degraded).toBe(true);
    // 关键：不能注入 only: []（那是无效偏好）
    expect(out['providerOptions']).toBeUndefined();
  });

  it('把已知清单全排除 → degraded=true（排除无法生效）', () => {
    const { degraded } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: ['b'] },
      basePrefs({ excludeList: ['b'] }),
    );
    expect(degraded).toBe(true);
  });

  it('已钉住的上游不出现在排除换算里（钉住优先）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'direct', knownUpstreams: ['a', 'b'] },
      basePrefs({ upstream: 'b', excludeList: ['b'] }),
    );
    expect(out['provider']).toEqual({ only: ['b'] });
  });

  it.each([
    ['cost', 'price'],
    ['ttft', 'latency'],
    ['tps', 'throughput'],
  ] as const)('排序映射 %s → OpenRouter 字段 %s', (key, orField) => {
    expect(SORT_KEYS).toContain(key);
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'direct', knownUpstreams: [] },
      basePrefs({ sort: key as SortKey }),
    );
    expect(out['provider']).toEqual({ sort: orField });
  });

  it('planner 的 sort 直接透传（Vercel AI Gateway 用原名）', () => {
    const { body: out } = injectPrefs({}, { pipeline: 'planner', knownUpstreams: [] }, basePrefs({ sort: 'cost' }));
    expect(out['providerOptions']).toEqual({ gateway: { sort: 'cost' } });
  });

  it('无偏好时不注入任何字段', () => {
    const body = { model: 'x', provider: { existing: 1 } };
    const { body: out, degraded } = injectPrefs(body, { pipeline: 'planner', knownUpstreams: [] }, basePrefs());
    expect(degraded).toBe(false);
    expect(out).toEqual(body);
  });

  it('不修改入参（深拷贝）', () => {
    const body = { model: 'x', provider: { nested: { v: 1 } } };
    const snapshot = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    injectPrefs(body, { pipeline: 'planner', knownUpstreams: ['a'] }, basePrefs({ upstream: 'a' }));
    expect(body).toEqual(snapshot);
  });

  it('保留调用方已有的 providerOptions 字段', () => {
    const body = { providerOptions: { gateway: { custom: 'keep' }, other: 1 } };
    const { body: out } = injectPrefs(
      body,
      { pipeline: 'planner', knownUpstreams: [], forceChannelBinding: false },
      basePrefs({ upstream: 'a' }),
    );
    expect(out['providerOptions']).toEqual({ gateway: { custom: 'keep', only: ['a'] }, other: 1 });
  });
});

/**
 * 区域排除私有渠道（2026-11-04 linux.do 3119385 实测写法）。
 * 只写 only 挡不住 openai-compatible-private：网关会先走它再回退官方。
 */
describe('injectPrefs：区域约束排掉私有渠道', () => {
  const PRIVATE = 'openai-compatible-private';
  const GUARD = { scope: 'global', providers: { [PRIVATE]: { scope: 'zone', geoRegion: 'us' } } };
  const gatewayOf = (out: Record<string, unknown>): Record<string, unknown> =>
    ((out['providerOptions'] as Record<string, unknown>)?.['gateway'] ?? {}) as Record<string, unknown>;

  it('钉住别的渠道、且观测到私有渠道 → 注入区域约束', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek'] },
      basePrefs({ upstream: 'deepseek' }),
    );
    expect(gatewayOf(out)).toEqual({ only: ['deepseek'], inferenceRegion: GUARD });
  });

  it('钉的就是私有渠道 → 不注入（否则把自己钉死）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek'] },
      basePrefs({ upstream: PRIVATE }),
    );
    expect(gatewayOf(out)['inferenceRegion']).toBeUndefined();
  });

  it('没观测到私有渠道也注入（健康账号的计划清单里本来就没有它）', () => {
    // 私有 contributor 不出现在 planningReasoning 里，按观测结果决定要不要防它，
    // 正好会在最需要防的时候不防——所以这里故意不要求「已知清单包含它」。
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: ['deepseek'] },
      basePrefs({ upstream: 'deepseek' }),
    );
    expect(gatewayOf(out)).toEqual({ only: ['deepseek'], inferenceRegion: GUARD });
  });

  it('开关关闭 → 不注入（退回旧写法）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek'], forceChannelBinding: false },
      basePrefs({ upstream: 'deepseek' }),
    );
    expect(gatewayOf(out)).toEqual({ only: ['deepseek'] });
  });

  it('只设排序、没有限定渠道 → 不注入（那不是「排除」）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek'] },
      basePrefs({ sort: 'cost' }),
    );
    expect(gatewayOf(out)).toEqual({ sort: 'cost' });
  });

  it('preferred + 白名单排掉私有渠道 → 也注入', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek', 'together'] },
      basePrefs({ upstream: 'deepseek', strict: false, excludeList: [PRIVATE] }),
    );
    expect(gatewayOf(out)).toEqual({
      order: ['deepseek'],
      only: ['deepseek', 'together'],
      inferenceRegion: GUARD,
    });
  });

  it('调用方自带 inferenceRegion → 不覆盖', () => {
    const mine = { scope: 'zone', geoRegion: 'eu', providers: { deepseek: null } };
    const body = { providerOptions: { gateway: { inferenceRegion: mine } } };
    const { body: out } = injectPrefs(
      body,
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek'] },
      basePrefs({ upstream: 'deepseek' }),
    );
    expect(gatewayOf(out)['inferenceRegion']).toEqual(mine);
  });

  it('preferred 的最后一个候选（放开网关回退）→ 不加区域约束', () => {
    // 用户要的就是让网关自己选，包括私有渠道；加约束等于把回退取消
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: ['deepseek'] },
      basePrefs({ upstream: 'deepseek', strict: false, allowGatewayFallback: true }),
    );
    expect(gatewayOf(out)).toEqual({ order: ['deepseek'] });
  });

  it('放开回退但显式排除了私有渠道 → 仍然加约束（排除优先）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'planner', knownUpstreams: [PRIVATE, 'deepseek', 'together'] },
      basePrefs({ upstream: 'deepseek', strict: false, allowGatewayFallback: true, excludeList: [PRIVATE] }),
    );
    expect(gatewayOf(out)['inferenceRegion']).toEqual(GUARD);
  });

  it('direct 管道不注入（那条路走 OpenRouter 的 provider 字段）', () => {
    const { body: out } = injectPrefs(
      {},
      { pipeline: 'direct', knownUpstreams: [PRIVATE, 'deepseek'] },
      basePrefs({ upstream: 'deepseek' }),
    );
    expect(out['providerOptions']).toBeUndefined();
    expect(out['provider']).toEqual({ only: ['deepseek'] });
  });
});

describe('slugify', () => {
  it('显示名转 slug', () => {
    expect(slugify('GMICloud')).toBe('gmicloud');
    expect(slugify('Sail Research')).toBe('sail-research');
  });
});

describe('Pipeline 类型完备性', () => {
  it('只允许 planner / direct', () => {
    const valid: Pipeline[] = ['planner', 'direct'];
    expect(valid).toHaveLength(2);
  });
});

describe('parsePlannedChain（docs/pinning.md D2）', () => {
  it('解析 System credentials planned for + Total execution order，含链首', () => {
    const plan =
      'System credentials planned for: deepseek, alibaba, baseten. Total execution order: deepseek(system) → alibaba(system) → baseten(system)';
    expect(parsePlannedChain(plan)).toEqual(['deepseek', 'alibaba', 'baseten']);
  });

  it('链首渠道也会出现在结果里（fallbacksAvailable 不含链首的缺陷由此补齐）', () => {
    const plan =
      'System credentials planned for: deepseek, alibaba. Total execution order: deepseek(system) → alibaba(system)';
    const chain = parsePlannedChain(plan);
    expect(chain).toContain('deepseek');
    expect(chain[0]).toBe('deepseek');
  });

  it('非法 slug（含 JSON 片段）被过滤', () => {
    const plan =
      'System credentials planned for: deepseek, "type":"invalid_request_error", alibaba. Total execution order: deepseek(system) → alibaba(system)';
    expect(parsePlannedChain(plan)).toEqual(['deepseek', 'alibaba']);
  });

  it('空/无匹配输入 → 空数组', () => {
    expect(parsePlannedChain('')).toEqual([]);
    expect(parsePlannedChain('no markers here')).toEqual([]);
  });
});
