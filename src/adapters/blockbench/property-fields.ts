import { setDirection, setPositioning, setSizeMode } from '../../domain/layout-authoring';
import type { UiDocument, UiNode } from '../../domain/types';
import { defaultAppearance, defaultFrame } from '../../domain/types';
import { formatSize, parseSize, formatOffset, parseOffset } from '../../domain/expression';

export interface Field {
  id: string;
  label: string;
  type: string;
  propertyType?: string;
  read(node: UiNode): unknown;
  write?(node: UiNode, value: any, doc: UiDocument): void;
  applies?(node: UiNode): boolean;
  options?: Record<string, string>;
  dimensions?: number;
  axes?: [string, string];
  min?: number;
  readonly?: boolean;
  description?: string;
}
const anchors: Record<string, string> = {};
for (const [yi, y] of [0, 0.5, 1].entries())
  for (const [xi, x] of [0, 0.5, 1].entries())
    anchors[`${x},${y}`] = `${['上', '中', '下'][yi]}${['左', '中', '右'][xi]}`;
export const fields: Field[] = [
  {
    id: 'status',
    label: 'UI 状态',
    type: 'text',
    readonly: true,
    read: (n) => n.suspended ?? '',
    applies: (n) => !!n.suspended,
  },
  {
    id: 'offset',
    label: 'UI 位置',
    type: 'mcui_pair',
    axes: ['X', 'Y'],
    propertyType: 'array',
    dimensions: 2,
    description:
      'X、Y 坐标偏移：支持 16px、-8px、50% - 8px。百分比分别参照父级宽、高，在锚点位置上叠加；自动布局的流式子项由父级排列控制。Enter 或失焦提交。',
    read: (n) => [
      formatOffset(n.layout.offsetPercent?.x ?? 0, n.layout.offset.x),
      formatOffset(n.layout.offsetPercent?.y ?? 0, n.layout.offset.y),
    ],
    write: (n, v) => {
      const pct = { x: n.layout.offsetPercent?.x ?? 0, y: n.layout.offsetPercent?.y ?? 0 };
      for (const [i, axis] of (['x', 'y'] as const).entries())
        if (v.changedAxis === undefined || v.changedAxis === i) {
          const parsed = parseOffset(String(v[i]));
          n.layout.offset[axis] = parsed.pixels;
          pct[axis] = parsed.percent;
        }
      n.layout.offsetPercent = pct;
    },
  },
  {
    id: 'size',
    label: 'UI 尺寸',
    type: 'mcui_pair',
    propertyType: 'array',
    dimensions: 2,
    axes: ['W', 'H'],
    read: (n) => [formatSize(n.layout.width), formatSize(n.layout.height)],
    write: (n, v) => {
      if (v.changedAxis === undefined || v.changedAxis === 0)
        n.layout.width = parseSize(String(v[0]));
      if (v.changedAxis === undefined || v.changedAxis === 1)
        n.layout.height = parseSize(String(v[1]));
    },
    description:
      'W 宽、H 高。支持 80px、100% - 16px、75% + 12px。百分比参照父级对应尺寸；fill 填充剩余空间，hug 包裹内容。根节点没有父级百分比。Enter 或失焦提交，多选时只更新修改的轴。',
  },
  ...(['minWidth', 'minHeight'] as const).map((axis, i) => ({
    id: axis,
    label: i ? 'UI 最小高' : 'UI 最小宽',
    type: 'number',
    propertyType: 'number',
    min: 1,
    read: (n: UiNode) => n.layout[axis],
    write: (n: UiNode, v: number) => {
      n.layout[axis] = v;
    },
  })),
  ...(['maxWidth', 'maxHeight'] as const).map((axis, i) => ({
    id: axis,
    label: i ? 'UI 最大高' : 'UI 最大宽',
    type: 'mcui_draft',
    read: (n: UiNode) => (n.layout[axis] === undefined ? '' : String(n.layout[axis])),
    description: '最大尺寸，单位为 UI 像素；只接受正数或空白，空白表示不限。不支持百分比。',
    write: (n: UiNode, v: string) => {
      if (v.trim() === '') {
        delete n.layout[axis];
        return;
      }
      const x = Number(v);
      if (!Number.isFinite(x) || x < 1) throw new Error('最大尺寸必须是正数或空白');
      n.layout[axis] = x;
    },
  })),
  {
    id: 'positioning',
    label: 'UI 定位',
    type: 'inline_select',
    options: { flow: '参与布局', absolute: '绝对定位' },
    read: (n) => n.layout.positioning,
    write: (n, v, doc) => setPositioning(doc, n, v),
  },
  ...(['anchorFrom', 'anchorTo'] as const).map((key, i) => ({
    id: key,
    label: i ? 'UI 自身锚点' : 'UI 父锚点',
    type: 'mcui_anchor',
    options: anchors,
    read: (n: UiNode) => n.layout[key].join(','),
    write: (n: UiNode, v: string) => {
      n.layout[key] = v.split(',').map(Number) as [number, number];
    },
  })),
  {
    id: 'image_resolution',
    label: '贴图尺寸',
    type: 'select',
    options: { preserve: '保留分辨率', follow: '跟随图层尺寸' },
    applies: (n) => !!n.content && n.content.kind !== 'nine-slice',
    read: (n) => (n.rasterSize ? 'preserve' : 'follow'),
    write: (n, v) => {
      if (v === 'preserve') n.rasterSize ??= { width: n.rect.width, height: n.rect.height };
      else delete n.rasterSize;
    },
    description:
      '保留模式固定贴图、UV 和 UV 尺寸，改变 W/H 只改变显示大小，非等比修改会拉伸；等比缩放可在较小 UI 内显示高清素材。导入图片默认保留。跟随模式按 UI 尺寸重新生成像素。九宫格始终按目标尺寸生成。Shift 拖动八点框会启用保留模式。',
  },
  {
    id: 'style_fill',
    label: '背景填充',
    type: 'select',
    options: { none: '无', solid: '纯色', linear: '线性渐变' },
    applies: (n) => n.kind === 'image',
    read: (n) => n.appearance?.fill ?? 'none',
    write: (n, v) => {
      (n.appearance ??= defaultAppearance()).fill = v;
    },
    description: '填充位于图片或绘画内容下方。渐变使用起止两种颜色；最终结果保存为标准贴图。',
  },
  ...(['color', 'endColor', 'strokeColor'] as const).map(
    (key, i): Field => ({
      id: 'style_' + key,
      label: ['填充颜色', '渐变终点', '描边颜色'][i]!,
      type: 'color',
      applies: (n) =>
        n.kind === 'image' &&
        (key === 'strokeColor' ||
          (key === 'endColor'
            ? n.appearance?.fill === 'linear'
            : !!n.appearance && n.appearance.fill !== 'none')),
      read: (n) => (n.appearance ?? defaultAppearance())[key],
      write: (n, v) => {
        (n.appearance ??= defaultAppearance())[key] = v;
      },
      description: '使用原生颜色选择器设置颜色与透明度。描边在内容上方、图层边界内侧绘制。',
    }),
  ),
  {
    id: 'style_angle',
    label: '渐变角度',
    type: 'number',
    propertyType: 'number',
    applies: (n) => n.appearance?.fill === 'linear',
    read: (n) => n.appearance?.angle ?? 90,
    write: (n, v) => {
      (n.appearance ??= defaultAppearance()).angle = v;
    },
    description: '角度单位为度：0 从左到右，90 从上到下。',
  },
  {
    id: 'style_stroke',
    label: '描边粗细',
    type: 'number',
    propertyType: 'number',
    min: 0,
    applies: (n) => n.kind === 'image',
    read: (n) => n.appearance?.strokeWidth ?? 0,
    write: (n, v) => {
      (n.appearance ??= defaultAppearance()).strokeWidth = v;
    },
    description:
      '向内描边，单位为贴图像素；0 关闭。保留分辨率时，描边随贴图整体缩放。可通过“栅格化为绘画图层”烘焙为可绘制像素。',
  },
  {
    id: 'paint_resize',
    label: 'UI 尺寸变化',
    type: 'select',
    options: { extend: '扩展画布（保持像素）', scale: '重采样像素（改变贴图尺寸）' },
    applies: (n) => n.content?.kind === 'paint' && !n.rasterSize,
    read: (n) => (n.content?.kind === 'paint' ? n.content.mode : undefined),
    write: (n, v) => {
      if (n.content?.kind === 'paint') n.content.mode = v;
    },
  },
  {
    id: 'image_mode',
    label: 'UI 图片适配',
    type: 'select',
    options: {
      stretch: '拉伸 Stretch',
      fit: '完整显示 Fit',
      fill: '铺满 Fill',
      crop: '手动裁切 Crop',
      original: '原始像素',
    },
    applies: (n) => n.content?.kind === 'image',
    read: (n) => (n.content?.kind === 'image' ? n.content.mode : undefined),
    write: (n, v) => {
      if (n.content?.kind === 'image') n.content.mode = v;
    },
  },
  {
    id: 'image_anchor',
    label: 'UI 图片锚点',
    type: 'mcui_anchor',
    options: anchors,
    applies: (n) => n.content?.kind === 'image',
    read: (n) => (n.content?.kind === 'image' ? n.content.anchor.join(',') : ''),
    write: (n, v) => {
      if (n.content?.kind === 'image') n.content.anchor = v.split(',').map(Number);
    },
  },
  {
    id: 'image_scale',
    label: 'UI 图片倍率',
    type: 'number',
    propertyType: 'number',
    min: 0.01,
    applies: (n) => n.content?.kind === 'image' && n.content.mode === 'crop',
    read: (n) => (n.content?.kind === 'image' ? n.content.scale : 1),
    write: (n, v) => {
      if (n.content?.kind === 'image') n.content.scale = v;
    },
  },
  {
    id: 'image_offset',
    label: 'UI 图片偏移',
    type: 'vector',
    propertyType: 'vector2',
    dimensions: 2,
    applies: (n) => n.content?.kind === 'image' && n.content.mode === 'crop',
    read: (n) => (n.content?.kind === 'image' ? [n.content.offset.x, n.content.offset.y] : [0, 0]),
    write: (n, v) => {
      if (n.content?.kind === 'image') {
        if (v.changedAxis === undefined || v.changedAxis === 0) n.content.offset.x = v[0];
        if (v.changedAxis === undefined || v.changedAxis === 1) n.content.offset.y = v[1];
      }
    },
  },
  {
    id: 'only_downscale',
    label: 'UI 只允许缩小',
    type: 'checkbox',
    propertyType: 'boolean',
    applies: (n) => n.content?.kind === 'image',
    read: (n) => n.content?.kind === 'image' && n.content.onlyDownscale,
    write: (n, v) => {
      if (n.content?.kind === 'image') n.content.onlyDownscale = v;
    },
  },
  {
    id: 'nine_insets',
    label: 'UI 九宫格边距',
    type: 'vector',
    propertyType: 'vector4',
    dimensions: 4,
    min: 0,
    description: '上、右、下、左，单位为源图像素',
    applies: (n) => n.content?.kind === 'nine-slice',
    read: (n) => (n.content?.kind === 'nine-slice' ? n.content.insets : [0, 0, 0, 0]),
    write: (n, v) => {
      if (n.content?.kind === 'nine-slice')
        for (let i = 0; i < 4; i++)
          if (v.changedSide === undefined || v.changedSide === i) n.content.insets[i] = v[i];
    },
  },
  {
    id: 'nine_mode',
    label: 'UI 九宫格模式',
    type: 'select',
    options: { stretch: '拉伸', tile: '平铺' },
    applies: (n) => n.content?.kind === 'nine-slice',
    read: (n) => (n.content?.kind === 'nine-slice' ? n.content.mode : undefined),
    write: (n, v) => {
      if (n.content?.kind === 'nine-slice') n.content.mode = v;
    },
  },
  {
    id: 'direction',
    label: 'UI 排列',
    type: 'inline_select',
    options: { free: '自由', row: '→ 横向', column: '↓ 纵向' },
    applies: (n) => n.kind === 'frame',
    read: (n) => n.frame?.direction ?? 'free',
    write: (n, v, doc) => setDirection(doc, n, v),
  },
  {
    id: 'gap',
    label: 'UI 间距',
    type: 'number',
    propertyType: 'number',
    min: 0,
    applies: (n) => n.kind === 'frame',
    read: (n) => n.frame?.gap ?? 0,
    write: (n, v) => {
      n.frame!.gap = v;
    },
  },
  {
    id: 'padding',
    label: 'UI 内边距',
    type: 'mcui_padding',
    propertyType: 'vector4',
    dimensions: 4,
    min: 0,
    description: '上、右、下、左',
    applies: (n) => n.kind === 'frame',
    read: (n) => n.frame?.padding ?? [0, 0, 0, 0],
    write: (n, v) => {
      for (let i = 0; i < 4; i++)
        if (v.changedSide === undefined || v.changedSide === i) n.frame!.padding[i] = v[i];
    },
  },
  {
    id: 'alignment',
    label: 'UI 子项对齐',
    type: 'mcui_alignment',
    propertyType: 'array',
    applies: (n) => n.kind === 'frame' && n.frame?.direction !== 'free',
    read: (n) => {
      const f = n.frame ?? defaultFrame(),
        index = (v: string) => Math.max(0, ['start', 'center', 'end'].indexOf(v));
      return [
        index(f.direction === 'row' ? f.justify : f.align),
        index(f.direction === 'row' ? f.align : f.justify),
        f.justify === 'space-between',
        f.direction,
      ];
    },
    write: (n, v) => {
      const f = n.frame!;
      f.justify =
        (v[2] ?? f.justify === 'space-between')
          ? 'space-between'
          : (['start', 'center', 'end'] as const)[f.direction === 'row' ? v[0] : v[1]]!;
      f.align = (['start', 'center', 'end'] as const)[f.direction === 'row' ? v[1] : v[0]]!;
    },
    description:
      '点击九点图直接设置子项在容器内的对齐位置。横向／纵向自动换算主轴与交叉轴；两端分布将剩余空间分配到子项之间，此时另一轴仍可选择。',
  },
  ...(['width', 'height'] as const).map(
    (axis): Field => ({
      id: 'sizing_' + axis,
      label: axis === 'width' ? 'UI 宽度策略' : 'UI 高度策略',
      type: 'inline_select',
      options: { fixed: '固定', fill: '填充', hug: '包裹', expression: '%' },
      read: (n) => n.layout[axis].kind,
      write: (n, v) => setSizeMode(n, axis, v),
      description:
        '固定取当前显示尺寸；填充占用父级剩余空间；包裹根据内容计算；% 初始为父级 100%。精确数值和百分比±像素仍在“元素”的 W/H 输入。根节点不能使用父级百分比，父包裹与子填充的循环会回滚。',
    }),
  ),
];

const explanations: Record<string, string> = {
  minWidth: '最小宽度，单位为 UI 像素。九宫格还会受到四边边距和中心像素的下限约束。',
  minHeight: '最小高度，单位为 UI 像素。九宫格还会受到四边边距和中心像素的下限约束。',
  positioning: '参与布局：由父 Frame 自动排列。绝对定位：使用锚点和位置偏移，不参与父级 Hug 计算。',
  anchorFrom: '选择父级上的参照点。UI 位置偏移相对此点计算。',
  anchorTo: '选择自身对齐到父锚点的点。例如父锚点和自身锚点都为中心时居中。',
  paint_resize:
    '扩展画布保持原有像素大小并增加透明空间；缩小保留源像素。重采样像素会将源画面缩放到新尺寸。如只改变显示大小，请选择保留贴图分辨率。',
  image_mode:
    'Fit 完整显示并留透明边；Fill 等比铺满并裁切；Stretch 拉伸；Crop 使用倍率与偏移；原始像素不缩放。',
  image_anchor: '图片在可用空间中的对齐点；Fill 时也决定裁切方向。',
  image_scale: 'Crop 模式中的源图缩放倍率。1 表示原始大小，像素素材建议整数倍率。',
  image_offset: 'Crop 模式的 X/Y 图片偏移，单位为目标 UI 像素。这里仅接受像素数，不接受百分比。',
  only_downscale: '图片适配时允许缩小，但不将源图放大超过原始尺寸。',
  nine_insets: '上、右、下、左四边宽度，单位为源图像素。必须保留至少 1px 的中心区域。',
  nine_mode: '拉伸：固定四角，伸展边和中心；平铺：重复边与中心，最后不足一块的区域裁切。',
  direction: '自由布局按锚点和偏移定位；横向/纵向按大纲顺序排列流式子项。',
  gap: '相邻流式子项之间的距离，单位为 UI 像素。',
  padding: '上、右、下、左四边内边距，单位为 UI 像素。Fill 分配空间时会扣除内边距。',
  justify: '主轴上的排列方式：起点、居中、终点，或将剩余空间分配到子项之间。',
  align: '交叉轴对齐。例如横向布局时，控制子项的垂直对齐。',
};
for (const field of fields) field.description = explanations[field.id] ?? field.description;
