import { hostRuntime } from './adapters/blockbench/runtime';
import { install } from './adapters/blockbench/install';
const bb = hostRuntime();
let dispose: (() => void) | undefined;
bb.Blockbench.Plugin.register('mcui_studio', {
  title: 'UI Studio',
  author: 'MC UI Studio contributors',
  icon: 'dashboard_customize',
  description: '二维 UI 设计：图层编辑、像素绘制、图片适配、九宫格与自动布局。',
  version: '0.8.1',
  variant: 'both',
  min_version: '5.2.1',
  tags: ['Painting'],
  onload() {
    dispose = install(bb);
  },
  onunload() {
    dispose?.();
    dispose = undefined;
  },
});
