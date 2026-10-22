import { Select, Tooltip } from 'antd';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { useMeta } from './api/hooks.ts';

/**
 * 「路由区块」当前所属的网关（订阅模型 / 测试台共用）。
 *
 * 2.1 起页面顶部的主选择器是**账号**（检测属于账号），网关只决定钉住/排除
 * 这份路由配置存在哪里。所以这里不再有「控制台网关」的概念，默认落到第一个
 * 启用的网关；用户选择的网关存在本地。
 *
 * 为什么仍放在 context：六个页面同时挂载，两个检测页各自持有会不同步。
 */
const PICKED_KEY = 'cps_routing_gateway';

export interface GatewaySummary {
  id: string;
  name: string;
  enabled: boolean;
}

interface RoutingGatewayValue {
  /** 当前路由配置所属的网关 id（一定存在）。 */
  gatewayId: string;
  gateways: GatewaySummary[];
  setGatewayId: (id: string) => void;
}

const RoutingGatewayContext = createContext<RoutingGatewayValue | null>(null);

export function RoutingGatewayProvider({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const gateways = useMemo<GatewaySummary[]>(
    () => (meta.data?.gateways ?? []).map((g) => ({ id: g.id, name: g.name, enabled: g.enabled !== false })),
    [meta.data?.gateways],
  );
  const fallback = gateways.find((g) => g.enabled)?.id ?? gateways[0]?.id ?? meta.data?.defaultGatewayId ?? 'main';
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem(PICKED_KEY));

  const gatewayId = picked && gateways.some((g) => g.id === picked) ? picked : fallback;

  const setGatewayId = useCallback((id: string) => {
    localStorage.setItem(PICKED_KEY, id);
    setPicked(id);
  }, []);

  const value = useMemo(() => ({ gatewayId, gateways, setGatewayId }), [gatewayId, gateways, setGatewayId]);
  return <RoutingGatewayContext.Provider value={value}>{children}</RoutingGatewayContext.Provider>;
}

export function useRoutingGateway(): RoutingGatewayValue {
  const value = useContext(RoutingGatewayContext);
  if (!value) throw new Error('useRoutingGateway 必须在 RoutingGatewayProvider 内使用');
  return value;
}

/** 路由区块里的「所属网关」选择器（不是页面主选择器）。 */
export function RoutingGatewayPicker() {
  const { gatewayId, gateways, setGatewayId } = useRoutingGateway();
  // 只有一个网关时也显示（只读），否则区块里会留下一个没有控件的「所属网关」标签
  return (
    <Select
      size="small"
      style={{ minWidth: 140 }}
      value={gatewayId}
      disabled={gateways.length <= 1}
      onChange={(v) => setGatewayId(String(v))}
      options={gateways.map((g) => ({
        value: g.id,
        label: (
          <Tooltip title={g.name}>
            <span
              style={{
                display: 'inline-block',
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                verticalAlign: 'bottom',
              }}
            >
              {g.name}
            </span>
          </Tooltip>
        ),
      }))}
    />
  );
}
