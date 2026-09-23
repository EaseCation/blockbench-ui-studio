import { hostRuntime } from './adapters/blockbench/runtime';
import { install } from './adapters/blockbench/install';
const bb = hostRuntime();
let dispose: (() => void) | undefined;
bb.Blockbench.Plugin.register('mcui_studio', {
  title: 'MC UI Studio',
  author: 'MC UI Studio contributors',
  icon: 'dashboard_customize',
  description: 'Minecraft 像素 UI：图层、九宫格、图片适配、二维交互与响应式布局。',
  version: '0.5.0',
  variant: 'both',
  min_version: '5.2.1',
  tags: ['Minecraft: Bedrock Edition', 'Painting'],
  onload() {
    dispose = install(bb);
  },
  onunload() {
    dispose?.();
    dispose = undefined;
  },
});
