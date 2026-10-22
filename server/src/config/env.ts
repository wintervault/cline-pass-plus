import { ensureUniqueAccountNames } from '../accounts/naming.ts';
import { primaryGateway } from './derive.ts';
import type { Config } from './schema.ts';

/**
 * 环境变量覆盖配置，便于 Docker 部署时注入密钥而不用把明文写进挂载卷。
 *
 * 2.1 起控制台是独立监听，所以变量的归属也拆开了：
 * - `PORT` / `BIND_HOST` → **控制台**监听（桌面壳固定 `PORT=3125`）
 * - `PROXY_KEY` / `PUBLIC_BASE_URL` → 第一个网关（兼容既有 `/v1` 客户端）
 * - `CONSOLE_KEY` → 控制台远端访问密钥
 * - `GATEWAY_BIND_HOST` → 所有网关的绑定地址（Docker 内需要 0.0.0.0）
 *
 * 注意：覆盖结果就是「当前生效值」，控制台保存设置时会以生效值写回 config.json
 * （与旧版行为一致，README 有说明）。因此这里只覆盖用户明确设了的环境变量。
 */
export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const notes: string[] = [];
  const gateway = primaryGateway(config);

  const clineKey = env.CLINE_PASS_KEY?.trim();
  if (clineKey) {
    /**
     * 环境变量只用于**首次启动引导**。
     *
     * 账号池一旦有账号，就完全以控制台里的账号池为准：否则每次启动都会
     * 塞回一个界面上删不掉、也看不出是环境变量来的 `env-account`，在账号已经
     * 很多时既多余又会参与轮转（旧 key 失效时还会造成请求失败）。
     * 多账号请直接在「账号池」里维护，或挂载 config.json；不在这里加分隔符——
     * 那等于把账号池拆成两套真值。
     */
    if (config.accounts.length > 0) {
      notes.push(`账号池已有 ${config.accounts.length} 个账号，已忽略 CLINE_PASS_KEY（该变量仅用于首次启动）`);
    } else if (!config.accounts.some((a) => a.key === clineKey)) {
      const merged = ensureUniqueAccountNames([{ name: 'env-account', key: clineKey }, ...config.accounts]);
      config.accounts = merged.accounts;
      for (const r of merged.renamed) notes.push(`账号名重复，已自动改名：${r.from} → ${r.to}`);
      notes.push('CLINE_PASS_KEY 已注入账号池（首次启动引导）');
    }
  }

  const proxyKey = env.PROXY_KEY?.trim();
  if (proxyKey) {
    gateway.proxyKey = proxyKey;
    notes.push(`PROXY_KEY 已覆盖网关「${gateway.name}」的代理密钥`);
    // 兼容旧部署：以前 PROXY_KEY 同时守住控制台（那时两者共用监听）。
    // 现在控制台密钥为空时继续沿用它，远端控制台访问不会因为升级而失效。
    if (!config.console.proxyKey && !env.CONSOLE_KEY?.trim()) {
      config.console.proxyKey = proxyKey;
      notes.push('PROXY_KEY 同时作为控制台的远端访问密钥（可用 CONSOLE_KEY 单独指定）');
    }
  }

  const consoleKey = env.CONSOLE_KEY?.trim();
  if (consoleKey) {
    config.console.proxyKey = consoleKey;
    notes.push('CONSOLE_KEY 已覆盖控制台的远端访问密钥');
  }

  const publicBase = env.PUBLIC_BASE_URL?.trim();
  if (publicBase) {
    gateway.publicBaseUrl = publicBase.replace(/\/+$/, '');
    notes.push(`PUBLIC_BASE_URL 已覆盖网关「${gateway.name}」的公网地址`);
  }

  const gatewayBindHost = env.GATEWAY_BIND_HOST?.trim();
  if (gatewayBindHost) {
    for (const gw of config.gateways) gw.bindHost = gatewayBindHost;
    notes.push(`GATEWAY_BIND_HOST 已覆盖所有网关的绑定地址为 ${gatewayBindHost}`);
  }

  const port = Number(env.PORT);
  if (env.PORT && Number.isInteger(port) && port > 0 && port < 65536) {
    config.console.port = port;
    const clash = config.gateways.find((g) => g.port === port);
    notes.push(
      clash
        ? `PORT 已覆盖控制台端口为 ${port}，但该端口已被网关「${clash.name}」占用（控制台会绑定失败）`
        : `PORT 已覆盖控制台端口为 ${port}`,
    );
  }

  const bindHost = env.BIND_HOST?.trim();
  if (bindHost) {
    config.console.bindHost = bindHost;
    notes.push(`BIND_HOST 已覆盖控制台的绑定地址为 ${bindHost}`);
  }

  return notes;
}
