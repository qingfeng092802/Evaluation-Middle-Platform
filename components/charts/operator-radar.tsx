'use client';

import * as React from 'react';
import * as echarts from 'echarts/core';
import { RadarChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([RadarChart, LegendComponent, TooltipComponent, CanvasRenderer]);

/**
 * 算子雷达图（`DESIGN.md` §5.1：PG-08 / PG-03 双系列雷达）。
 *
 * option 由 `lib/ui/compare.ts` 的纯函数生成（主题来自 Token，禁裸 hex）；
 * 本组件只负责 echarts 生命周期：init → setOption → resize → dispose。
 * `role="img"` + `aria-label`：图表不是读数的唯一途径（红线 8），
 * 表格孪生由调用方的「图表 / 表格」切换提供（红线 3）。
 */
export function OperatorRadar({
  option,
  ariaLabel,
}: {
  option: Record<string, unknown>;
  ariaLabel: string;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(option as Parameters<typeof chart.setOption>[0]);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className="h-[320px] w-full" />;
}
