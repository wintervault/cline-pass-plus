import { describe, expect, it } from 'vitest';

import { ensureUniqueAccountNames } from '../src/accounts/naming.ts';
import { AccountPool } from '../src/accounts/pool.ts';
import { defaultConfig } from '../src/config/schema.ts';

const acc = (name: string, key = `sk_${name}`) => ({ name, key });

describe('ensureUniqueAccountNames', () => {
  it('原型链保留名会被改成可见的普通名字', () => {
    const r = ensureUniqueAccountNames([acc('__proto__'), acc('constructor'), acc('正常')]);
    expect(r.accounts.map((a) => a.name)).toEqual(['账号-__proto__', '账号-constructor', '正常']);
    expect(r.renamed).toHaveLength(2);
  });
});

/**
 * 账号池按网关构造：这里直接用「一个网关」的视角（账号子集 = 全部）。
 * single 模式用**账号名**指定（3.0 起账号标识是 name，不再用下标）。
 */
const poolWith = (accounts: Parameters<typeof acc>[], mode: 'sticky' | 'single' | 'roundrobin', active = '') => {
  const config = defaultConfig();
  config.accounts = accounts.map(([n, k]) => acc(n as string, k as string | undefined));
  const view = { accounts: config.accounts, accountMode: mode, activeAccount: active };
  return new AccountPool(() => view);
};

describe('AccountPool.pick', () => {
  it('无可用账号 → null（调用方应返回明确的配置错误）', () => {
    expect(poolWith([], 'sticky').pick()).toBeNull();
    expect(poolWith([['a', '']], 'sticky').pick()).toBeNull();
  });

  it('sticky：反复 pick 得到同一个账号（保 prompt cache）', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'sticky');
    const first = pool.pick();
    expect(first?.name).toBe('a');
    expect(pool.pick()?.name).toBe('a');
    expect(pool.pick()?.name).toBe('a');
  });

  it('single：用 activeAccount 指定的账号', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'single', 'c');
    expect(pool.pick()?.name).toBe('c');
  });

  it('single：activeAccount 指向不存在的账号时回退到第一个', () => {
    const pool = poolWith([['a'], ['b']], 'single', 'missing');
    expect(pool.pick()?.name).toBe('a');
  });

  it('roundrobin：连续 pick 依次轮换（旧版行为，牺牲缓存）', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'roundrobin');
    expect([pool.pick()?.name, pool.pick()?.name, pool.pick()?.name, pool.pick()?.name]).toEqual(['a', 'b', 'c', 'a']);
  });

  it('roundrobin 只有一个账号时不轮换', () => {
    const pool = poolWith([['a']], 'roundrobin');
    expect(pool.pick()?.name).toBe('a');
  });
});

describe('AccountPool.rotate', () => {
  it('sticky：账号级错误后轮转到下一个启用账号并保持', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'sticky');
    const failed = pool.pick();
    expect(failed?.name).toBe('a');
    const next = pool.rotate(failed as never, 'key 失效');
    expect(next?.name).toBe('b');
    expect(pool.pick()?.name).toBe('b'); // 粘在新账号上
  });

  it('轮转到最后一个后回到第一个（环形）', () => {
    const pool = poolWith([['a'], ['b']], 'sticky');
    let current = pool.pick();
    const seen = [current?.name];
    for (let i = 0; i < 3; i++) {
      current = pool.rotate(current as never, 'err');
      seen.push(current?.name);
    }
    expect(seen).toEqual(['a', 'b', 'a', 'b']);
  });

  it('只有一个启用账号时 rotate 返回 null（调用方应直接报错）', () => {
    const pool = poolWith([['a']], 'sticky');
    const failed = pool.pick();
    expect(pool.rotate(failed as never, 'err')).toBeNull();
  });

  it('rotate 触发监听器（供日志/历史记录）', () => {
    const pool = poolWith([['a'], ['b']], 'sticky');
    const events: string[] = [];
    pool.onRotate((info) => events.push(`${info.from}→${info.to}:${info.reason}`));
    const failed = pool.pick();
    pool.rotate(failed as never, '401');
    expect(events).toEqual(['a→b:401']);
  });

  it('single 模式同样可以轮转（账号挂了总比直接失败好）', () => {
    const pool = poolWith([['a'], ['b']], 'single', 'a');
    const failed = pool.pick();
    expect(pool.rotate(failed as never, 'key 失效')?.name).toBe('b');
  });

  it('账号列表变更后 pick 反映最新状态（引用同一 Config 对象）', () => {
    const config = defaultConfig();
    config.accounts = [acc('a')];
    const pool = new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' }));
    expect(pool.pick()?.name).toBe('a');
    // 控制台保存后是就地更新同一对象
    config.accounts = [acc('a'), acc('b')];
    expect(pool.usable()).toHaveLength(2);
    expect(pool.pick()?.name).toBe('a');
  });

  it('sticky：账号顺序变化后仍粘在同一个账号（不按位置漂移）', () => {
    const config = defaultConfig();
    config.accounts = [acc('a'), acc('b')];
    const pool = new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' }));
    expect(pool.pick()?.name).toBe('a');
    // 网关把 b 的粘性优先级调到最前：当前账号仍是 a，不能悄悄换号毁掉 prompt cache
    config.accounts = [acc('b'), acc('a')];
    expect(pool.pick()?.name).toBe('a');
  });

  it('sticky：当前账号改名前后的位置不变时仍选中它', () => {
    const config = defaultConfig();
    config.accounts = [acc('a'), acc('b')];
    const pool = new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' }));
    expect(pool.pick()?.name).toBe('a');
    // a 改名为 x（位置不变）——名字对不上时按旧位置兜底
    config.accounts = [acc('x'), acc('b')];
    expect(pool.pick()?.name).toBe('x');
  });

  it('rotate：配置对象被替换后仍按名字找到 failed 并轮转', () => {
    const config = defaultConfig();
    config.accounts = [acc('a'), acc('b')];
    const pool = new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' }));
    const failed = pool.pick();
    config.accounts = [acc('a'), acc('b')]; // 新的对象引用
    expect(pool.rotate(failed as never, 'err')?.name).toBe('b');
  });
});
