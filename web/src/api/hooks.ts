import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { type Feedback, useFeedback } from '../feedback.ts';
import { codeText, noticeText } from '../i18n/codes.ts';
import { useI18n } from '../i18n/index.tsx';
import { api } from './client.ts';
import type {
  AccountsResponse,
  AccountTestResult,
  ClassifyResponse,
  ConsoleInfo,
  GatewaysResponse,
  HistoryEntry,
  MetaInfo,
  ModelsResponse,
  PerModelConfig,
  ProbeResult,
  TestResult,
  ValidationResult,
} from './types.ts';

export const qk = {
  meta: ['meta'] as const,
  /** 模型检测按**账号**：同一模型在不同账号上的结论可能完全不同。 */
  models: (gatewayId: string, account: string) => ['models', gatewayId, account] as const,
  accounts: ['accounts'] as const,
  gateways: ['gateways'] as const,
  history: ['history'] as const,
  console: ['console'] as const,
};

/**
 * 订阅模型 + 路由配置 + 检测记录。
 * - `gatewayId` 决定路由配置（钉住/排除）来自哪个网关；
 * - `account` 决定检测记录来自哪个账号。
 */
export function useModels(
  params: { gatewayId?: string; account?: string } = {},
): ReturnType<typeof useQuery<ModelsResponse>> {
  return useQuery({
    queryKey: qk.models(params.gatewayId ?? '', params.account ?? ''),
    queryFn: () =>
      api<ModelsResponse>('/api/models', {
        query: {
          ...(params.gatewayId ? { gateway: params.gatewayId } : {}),
          ...(params.account ? { account: params.account } : {}),
        },
      }),
  });
}
export function useAccounts(): ReturnType<typeof useQuery<AccountsResponse>> {
  return useQuery({ queryKey: qk.accounts, queryFn: () => api<AccountsResponse>('/api/accounts') });
}
/** 网关列表 + 运行状态。轮询是刻意的：端口绑定失败/恢复要能被看见。 */
export function useGateways(options: { poll?: boolean } = {}): ReturnType<typeof useQuery<GatewaysResponse>> {
  return useQuery({
    queryKey: qk.gateways,
    queryFn: () => api<GatewaysResponse>('/api/gateways'),
    refetchInterval: options.poll === false ? false : 2000,
  });
}
export function useHistory(): ReturnType<typeof useQuery<{ history: HistoryEntry[] }>> {
  return useQuery({ queryKey: qk.history, queryFn: () => api<{ history: HistoryEntry[] }>('/api/history') });
}

/** 批量失效（多数写操作之后调用，让表格回到服务端真实状态）。 */
export function useRefresh(): () => void {
  const qc = useQueryClient();
  return () => {
    // meta 也要失效：它承载「是否已配置账号」——漏掉会让「尚未配置」提示
    // 在保存账号后继续显示（读的是旧缓存）
    void qc.invalidateQueries({ queryKey: qk.meta });
    void qc.invalidateQueries({ queryKey: ['models'] });
    void qc.invalidateQueries({ queryKey: qk.accounts });
    void qc.invalidateQueries({ queryKey: qk.gateways });
    void qc.invalidateQueries({ queryKey: qk.history });
    void qc.invalidateQueries({ queryKey: qk.console });
  };
}

/**
 * 写操作一律在**这里**给回执，而不是各调用点自己记得弹。
 *
 * 起因：功能做完不给任何反馈，用户不知道「到底成了没有」。把成功与失败的提示
 * 收进 mutation 本身，调用点就不存在「忘了弹」的可能——这是结构性保证，
 * 不是纪律要求。调用点想说得更具体时，用变量里的 `note` 覆盖默认成功文案。
 *
 * 失败的文案统一带上「哪件事失败了 + 服务端给的原因」，不允许只显示「失败」。
 */
export function useSaveModelConfig(gatewayId: string) {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { modelId: string; config: PerModelConfig; note?: string }) =>
      api<{ ok: boolean }>('/api/config', {
        query: { gateway: gatewayId },
        json: { perModel: { [vars.modelId]: vars.config } },
      }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? t('toast.config.saved'));
    },
    onError: (err) => {
      // 调用点做过乐观更新：失败必须拉回服务端真值，否则界面会显示一个并未保存的状态
      refresh();
      fb.fail(t('toast.config.saveFailed'), err);
    },
  });
}

export function useProbe(account: string) {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (modelId: string) => api<ProbeResult>('/api/probe', { json: { model: modelId, account } }),
    onSuccess: (r) => {
      refresh();
      if (r.ok) fb.ok(t('toast.probe.done', { count: r.upstreams.length }));
      else fb.fail(t('toast.probe.failed'), codeText(t, r.code) || r.error || t('toast.probe.noChannels'));
    },
    onError: (err) => fb.fail(t('toast.probe.failed'), err),
  });
}

export function useValidate(account: string) {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (modelId: string) =>
      api<ValidationResult>('/api/validate-upstreams', { json: { model: modelId, account } }),
    onSuccess: (r) => {
      refresh();
      const s = r.summary;
      fb.ok(
        t('toast.validate.done', {
          ok: s.ok ?? 0,
          limited: s.limited ?? 0,
          quota: s.quota ?? 0,
          bad: s.bad ?? 0,
          auth: s.auth ?? 0,
        }),
      );
    },
    onError: (err) => fb.fail(t('toast.validate.failed'), err),
  });
}

export function useTest(gatewayId: string, account: string) {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { model: string; upstreams: string[]; exclude: string[] }) =>
      api<TestResult>('/api/test', { query: { gateway: gatewayId }, json: { ...vars, account } }),
    onSuccess: (r) => {
      refresh();
      if (r.ok)
        fb.ok(
          t('toast.test.ok', {
            provider: r.actual ?? r.actualName ?? t('common.unknown'),
            suffix: r.ms ? t('toast.test.msSuffix', { ms: r.ms }) : '',
          }),
        );
      else fb.fail(t('toast.test.failed'), codeText(t, r.code) || r.error || t('toast.test.notSuccessful'));
    },
    onError: (err) => fb.fail(t('toast.test.failed'), err),
  });
}

export function useFetchOfficial(gatewayId: string) {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; sources: string[]; found: number; added: string[]; knownModels: string[] }>(
        '/api/fetch-official-models',
        { query: { gateway: gatewayId }, json: {} },
      ),
    onSuccess: (r) => {
      refresh();
      if (r.added.length) fb.ok(t('toast.official.added', { count: r.added.length }));
      else fb.info(t('toast.official.current', { count: r.found }));
    },
    onError: (err) => fb.fail(t('toast.official.failed'), err),
  });
}

export function useSaveAccounts() {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { payload: unknown; note?: string }) =>
      api<{ ok: boolean; renamed?: Array<{ from: string; to: string }> }>('/api/accounts', { json: vars.payload }),
    onSuccess: (data, vars) => {
      refresh();
      // 账号改名后通知检测页把「当前检测账号」跟着改，否则会回退到第一个账号
      if (data.renamed?.length) {
        window.dispatchEvent(new CustomEvent('cps:accounts-renamed', { detail: data.renamed }));
      }
      fb.ok(vars.note ?? t('toast.accounts.saved'));
    },
    onError: (err) => {
      // 账号页同样有乐观更新：保存失败时回到服务端状态（例如删除最后一个账号被拒）
      refresh();
      fb.fail(t('toast.accounts.failed'), err);
    },
  });
}

export function useTestAccount() {
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { payload: { key: string } | { name: string }; label: string }) =>
      api<AccountTestResult>('/api/accounts/test', { json: vars.payload }),
    onSuccess: (r, vars) => {
      const detail = noticeText(t, r.notice);
      if (r.ok) fb.ok(t('toast.account.available', { name: vars.label, ms: r.ms, detail }));
      else
        fb.fail(t('toast.account.unavailable', { name: vars.label }), detail || r.error || t('toast.account.untested'));
    },
    onError: (err, vars) => fb.fail(t('toast.account.requestFailed', { name: vars.label }), err),
  });
}

/**
 * 风控体检。批量可能跑十几秒（串行、每账号 1 发最小请求），所以用两段式回执：
 * 按下时「正在体检…」，跑完换成结果（成功与失败都必带原因）。
 */
export function useClassifyAccounts() {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  const busy = useRef<ReturnType<Feedback['busy']> | null>(null);
  return useMutation({
    mutationFn: (vars: { names?: string[] }) => api<ClassifyResponse>('/api/accounts/classify', { json: vars }),
    onMutate: (vars) => {
      busy.current = fb.busy(
        vars.names?.length ? t('toast.classify.busy', { count: vars.names.length }) : t('toast.classify.busyAll'),
      );
    },
    onSuccess: (r) => {
      refresh();
      const s = r.summary;
      const tail = s.failed ? t('toast.classify.tail', { count: s.failed }) : '';
      busy.current?.ok(
        t('toast.classify.done', {
          normal: s.normal,
          private: s.private,
          unknown: s.unknown,
          tail,
        }),
      );
    },
    onError: (err) => busy.current?.fail(t('toast.classify.failed'), err),
    onSettled: () => {
      busy.current = null;
    },
  });
}

/** 保存网关（新建或更新；id 创建后不可改）。 */
export function useSaveGateway() {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { gateway: Record<string, unknown>; note?: string; created?: boolean }) =>
      api<{ ok: boolean; deferred: boolean }>('/api/gateways/save', { json: { gateway: vars.gateway } }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? (vars.created ? t('toast.gateway.created') : t('toast.gateway.saved')));
    },
    onError: (err) => fb.fail(t('toast.gateway.saveFailed'), err),
  });
}

export function useDeleteGateway() {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      api<{ ok: boolean }>('/api/gateways/delete', { json: { id: vars.id } }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(t('toast.gateway.deleted', { name: vars.name }));
    },
    onError: (err) => fb.fail(t('toast.gateway.deleteFailed'), err),
  });
}

export function useConsole(): ReturnType<typeof useQuery<ConsoleInfo & { ok: boolean }>> {
  return useQuery({
    queryKey: qk.console,
    queryFn: () => api<ConsoleInfo & { ok: boolean }>('/api/console'),
    refetchInterval: 3000,
  });
}

/** 保存控制台监听设置。绑定目标变化时服务端会延迟重建 listener。 */
export function useSaveConsole() {
  const refresh = useRefresh();
  const fb = useFeedback();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: { port?: number; bindHost?: string; proxyKey?: string | null; note?: string }) =>
      api<ConsoleInfo & { ok: boolean; deferred: boolean }>('/api/console/save', { json: { ...vars } }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? t('toast.console.saved'));
    },
    onError: (err) => fb.fail(t('toast.console.failed'), err),
  });
}

export function useMeta(): ReturnType<typeof useQuery<MetaInfo>> {
  return useQuery({ queryKey: qk.meta, queryFn: () => api<MetaInfo>('/api/meta') });
}
