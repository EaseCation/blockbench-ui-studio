import {
  setDirection,
  setPositioning,
  setSizeMode,
  sizeModeError,
} from '../../domain/layout-authoring';
import { registerLayoutFields } from './layout-fields';
import type { Studio } from '../../application/studio';
import type { Id, UiDocument, UiNode } from '../../domain/types';
import { defaultAppearance, defaultFrame } from '../../domain/types';
import { topSelection } from '../../domain/document';
import { formatSize, parseSize, formatOffset, parseOffset } from '../../domain/expression';
import { FIELD_PREFIX, ROLE_MARKER, SOURCE_MARKER } from './native-fields';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

interface Field {
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
const all: Field[] = [
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
        (n.appearance ??= defaultAppearance())[key] = typeof v === 'string' ? v : v.toHex8String();
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
    read: (n) => n.content?.mode,
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
    read: (n) => n.content?.mode,
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
      if (n.content?.kind === 'image') n.content.offset = { x: v[0], y: v[1] };
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
        n.content.insets = [...v] as [number, number, number, number];
    },
  },
  {
    id: 'nine_mode',
    label: 'UI 九宫格模式',
    type: 'select',
    options: { stretch: '拉伸', tile: '平铺' },
    applies: (n) => n.content?.kind === 'nine-slice',
    read: (n) => n.content?.mode,
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
      f.justify = v[2]
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
for (const field of all) field.description = explanations[field.id] ?? field.description;

type Section = 'element' | 'layout' | 'content';
function section(field: Field): Section {
  if (['status', 'offset', 'size', 'selection_info'].includes(field.id)) return 'element';
  return /^(paint_|image_|nine_|style_|only_downscale)/.test(field.id) ? 'content' : 'layout';
}
/** Declarative native fields; draft text is the only custom input behavior. */
export class PropertyBridge {
  private life = new Disposables();
  private disposed = false;
  private selectionKey = '';
  private tabsKey = '';
  private refreshing = false;
  private panels: HostObject[] = [];
  private advancedLayout = false;
  private eligibilityDoc?: UiDocument;
  private eligibilitySelection = '';
  private sizeErrors = new Map<string, string | null>();
  readonly fieldIds = new Set([
    SOURCE_MARKER,
    ROLE_MARKER,
    FIELD_PREFIX + 'justify',
    FIELD_PREFIX + 'align',
    ...all.map((f) => FIELD_PREFIX + f.id),
    FIELD_PREFIX + 'selection_info',
  ]);
  constructor(
    readonly bb: HostRuntime,
    readonly current: () => Studio | null,
  ) {
    this.registerDraft();
    const widgets = registerLayoutFields(bb, () =>
      this.targets()
        .map((n) => n.id)
        .sort()
        .join('|'),
    );
    this.life.add(() => widgets.dispose());
    for (const [type, ctor] of [
      ['cube', bb.Cube],
      ['group', bb.Group],
    ] as const) {
      this.life.add(
        new bb.Property(ctor, 'string', SOURCE_MARKER, { default: '', exposed: false }),
      );
      this.life.add(new bb.Property(ctor, 'string', ROLE_MARKER, { default: '', exposed: false }));
      if (type === 'cube') continue;
      for (const field of all) this.register(type, ctor, field);
      this.register(type, ctor, {
        id: 'selection_info',
        label: 'UI 多选',
        type: 'text',
        readonly: true,
        read: () => `已选择 ${this.targets().length} 个对象；显示首个值，修改统一应用`,
        applies: () => this.targets().length > 1,
      });
    }
    this.createSection('layout', 'UI 布局', 1);
    this.createSection('content', 'UI 内容', 2);
  }
  private createSection(kind: 'layout' | 'content', name: string, index: number) {
    const order = [
      'direction',
      'alignment',
      'gap',
      'padding',
      'sizing_width',
      'sizing_height',
      'positioning',
      'anchorFrom',
      'anchorTo',
      'minWidth',
      'minHeight',
      'maxWidth',
      'maxHeight',
    ];
    const fields = all
        .filter((f) => section(f) === kind)
        .sort((a, b) => (kind === 'layout' ? order.indexOf(a.id) - order.indexOf(b.id) : 0)),
      config: Record<string, unknown> = {};
    const applicable = () => {
      const nodes = this.targets();
      return (
        nodes.length > 0 &&
        nodes.every(
          (n) =>
            (n.kind === 'image' || n.kind === 'frame') &&
            (n.kind === 'image') === (nodes[0]!.kind === 'image'),
        )
      );
    };
    if (kind === 'layout')
      config.mcui_layout_selection = {
        type: 'info',
        text: '排列与对齐控制子项；尺寸与定位控制当前对象。',
      };
    for (const field of fields) {
      if (kind === 'layout' && field.id === 'minWidth')
        config.mcui_advanced_layout = {
          type: 'checkbox',
          label: '尺寸约束',
          value: this.advancedLayout,
          description: '展开最小／最大宽高。折叠不会清除已设置的约束。',
        };
      config[FIELD_PREFIX + field.id] = {
        label: field.label.replace(/^UI /, ''),
        type: field.type,
        options: field.options,
        dimensions: field.dimensions,
        axisLabels: field.axes,
        min: field.min,
        description: field.description,
        readonly: field.readonly,
        force_step: field.type === 'vector',
        step: 1,
        condition: () =>
          applicable() &&
          (!/^(min|max)(Width|Height)$/.test(field.id) || this.advancedLayout) &&
          this.targets().every((n) => {
            if (field.applies && !field.applies(n)) return false;
            if (['gap', 'padding'].includes(field.id) && n.frame?.direction === 'free')
              return false;
            if (['anchorFrom', 'anchorTo'].includes(field.id)) {
              const parent = n.parent ? this.current()?.state.doc.nodes[n.parent] : undefined;
              return (
                !!parent &&
                (n.layout.positioning === 'absolute' ||
                  parent.kind === 'image' ||
                  parent.frame?.direction === 'free')
              );
            }
            if (field.id === 'positioning') return !!n.parent;
            return true;
          }),
      };
    }
    if (kind === 'layout')
      config.mcui_wrap_selection = {
        type: 'buttons',
        buttons: ['组成自动布局'],
        description:
          '将同父级选区组成 Frame，按当前位置推断排列方向和平均间距，固定子项当前尺寸，Frame 包裹内容；可一次撤销。',
        condition: () => this.targets().length > 0,
        click: () => this.bb.BarItems.mcui_wrap_layout?.trigger(),
      };
    if (kind === 'content')
      config.mcui_rasterize = {
        type: 'buttons',
        label: '像素编辑',
        buttons: ['一键栅格化'],
        description: '将当前填充、渐变、描边与图片合成为可绘制像素，保留显示和贴图尺寸。可撤销。',
        condition: () => this.targets().length === 1 && this.targets()[0]?.kind === 'image',
        click: () => {
          const n = this.targets()[0];
          if (n) this.current()?.flatten(n.id);
        },
      };
    const panel = new this.bb.Panel('mcui_' + kind, {
      name,
      icon: kind === 'layout' ? 'view_quilt' : 'image',
      form: new this.bb.InputForm(config),
      min_height: 90,
      condition: () =>
        !!this.current() &&
        this.bb.Modes.edit &&
        applicable() &&
        (kind !== 'content' ||
          fields.some((f) => this.targets().every((n) => !f.applies || f.applies(n)))),
      display_condition: () =>
        applicable() && (kind !== 'content' || this.targets().every((n) => n.kind === 'image')),
      default_position: {
        slot: 'right_bar',
        attached_to: this.bb.Interface.Panels.element.getHostPanel()?.id ?? 'element',
        attached_index: -index,
        height: 400,
        sidebar_index: 3 + index,
      },
    });
    panel.form.on('input', ({ result, changed_keys }: HostObject) => {
      const app = this.current();
      if (!app || this.disposed) return;
      if (changed_keys?.includes('mcui_advanced_layout')) {
        this.advancedLayout = !!result.mcui_advanced_layout;
        panel.form.updateValues();
        return;
      }
      const ids = this.targets().map((n) => n.id);
      app.execute('修改 ' + name, (doc) => {
        for (const key of changed_keys ?? []) {
          const field = fields.find((f) => FIELD_PREFIX + f.id === key);
          if (!field?.write) continue;
          for (const id of ids) {
            const n = doc.nodes[id]!;
            if (!field.applies || field.applies(n)) field.write(n, result[key], doc);
          }
        }
      });
      this.refresh(false);
    });
    if (kind === 'layout') {
      this.life.listen(
        panel.node,
        'click',
        ((event: MouseEvent) => {
          const item = (event.target as HTMLElement).closest('[data-mcui-unavailable]');
          if (item) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.bb.Blockbench.showQuickMessage(item.getAttribute('title'), 4000);
          }
        }) as EventListener,
        true,
      );
      this.life.listen(panel.node, 'keydown', ((event: KeyboardEvent) => {
        const item = (event.target as HTMLElement).closest(
          '.form_inline_select li',
        ) as HTMLElement | null;
        if (!item) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          item.click();
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const options = Array.from(
            item.parentElement!.querySelectorAll<HTMLElement>('li:not([data-mcui-unavailable])'),
          );
          const index = options.indexOf(item),
            next =
              options[
                (index + (event.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length
              ];
          next?.focus();
          next?.click();
        }
      }) as EventListener);
    }
    this.panels.push(panel);
    this.life.add(panel);
  }
  targets(): UiNode[] {
    const app = this.current();
    if (!app) return [];
    const lookup = new Map(
      Object.entries(app.state.doc.bindings).flatMap(
        ([id, b]) =>
          [[b.containerId, id], ...(b.surfaceId ? [[b.surfaceId, id]] : [])] as [string, string][],
      ),
    );
    const raw = [...this.bb.Outliner.selected, ...this.bb.Group.multi_selected];
    if (raw.some((e) => !lookup.has(e.uuid))) return [];
    return topSelection(app.state.doc, [...new Set(raw.map((e) => lookup.get(e.uuid)!))]).map(
      (id) => app.state.doc.nodes[id]!,
    );
  }
  private visible(type: string, field: Field, node?: HostObject): boolean {
    if (this.disposed || !this.current()) return false;
    if (node?.uuid) {
      const app = this.current()!;
      const id = Object.entries(app.state.doc.bindings).find(
        ([, b]) => b.containerId === node.uuid,
      )?.[0];
      const n = id ? app.state.doc.nodes[id] : undefined;
      return !!n && (!field.applies || field.applies(n));
    }
    const targets = this.targets();
    return (
      targets.length > 0 &&
      targets.every((n) => type === 'group' && (!field.applies || field.applies(n)))
    );
  }
  private register(type: string, ctor: HostObject, field: Field) {
    this.life.add(
      new this.bb.Property(ctor, field.propertyType ?? 'string', FIELD_PREFIX + field.id, {
        condition: (node?: HostObject) => this.visible(type, field, node),
        exposed: false,
        inputs:
          section(field) === 'element'
            ? {
                element_panel: {
                  input: {
                    label: field.label,
                    type: field.type,
                    readonly: field.readonly,
                    options: field.options,
                    dimensions: field.dimensions,
                    axisLabels: field.axes,
                    min: field.min,
                    description: field.description,
                    force_step: field.type === 'vector',
                    step: 1,
                  },
                  onChange: (value: unknown, nodes: HostObject[]) => {
                    if (this.disposed || !field.write) return;
                    const app = this.current();
                    if (!app) return;
                    const ids = nodes
                      .map(
                        (e) =>
                          Object.entries(app.state.doc.bindings).find(
                            ([, b]) => b.containerId === e.uuid,
                          )?.[0],
                      )
                      .filter((id): id is string => !!id);
                    app.executeWithinHostEdit(field.label, (doc) => {
                      for (const id of ids) {
                        const n = doc.nodes[id]!;
                        if (!field.applies || field.applies(n)) field.write!(n, value, doc);
                      }
                    });
                    this.hydrate(app.state.doc);
                    this.refresh(false);
                  },
                },
              }
            : undefined,
      }),
    );
  }
  hydrate(doc: UiDocument) {
    if (this.disposed) return;
    for (const [id, binding] of Object.entries(doc.bindings)) {
      const object =
        this.bb.Project?.elements.find((e: HostObject) => e.uuid === binding.containerId) ??
        this.bb.Project?.groups.find((e: HostObject) => e.uuid === binding.containerId);
      const node = doc.nodes[id];
      if (!object || !node) continue;
      object[SOURCE_MARKER] = id;
      object[ROLE_MARKER] = 'container';
      const surface = this.bb.Project?.elements.find(
        (e: HostObject) => e.uuid === binding.surfaceId,
      );
      if (surface) {
        surface[SOURCE_MARKER] = id;
        surface[ROLE_MARKER] = 'content';
      }
      for (const f of all) object[FIELD_PREFIX + f.id] = f.read(node) ?? '';
      object[FIELD_PREFIX + 'selection_info'] =
        `已选择 ${this.targets().length} 个对象；显示首个值，修改统一应用`;
    }
  }
  refresh(autoSelect = true) {
    if (this.refreshing || this.disposed) return;
    const app = this.current();
    if (!app) {
      this.selectionKey = '';
      return;
    }
    this.refreshing = true;
    try {
      this.hydrate(app.state.doc);
      const targets = this.targets(),
        key = targets
          .map((n) => n.id)
          .sort()
          .join('|');
      const panel = this.bb.Interface.Panels.element;
      const values: Record<string, unknown> = {};
      for (const n of targets) {
        const type = 'group';
        for (const f of all) {
          const id = `${type}__${FIELD_PREFIX}${f.id}`;
          if (!(id in values)) values[id] = f.read(n) ?? '';
        }
        values[`${type}__${FIELD_PREFIX}selection_info`] =
          `已选择 ${targets.length} 个对象；显示首个值，修改统一应用`;
      }
      panel.form.setValues(values);
      for (const extra of this.panels) {
        const own: Record<string, unknown> = {};
        if (targets[0]) for (const f of all) own[FIELD_PREFIX + f.id] = f.read(targets[0]) ?? '';
        extra.form.setValues(own);
        if (extra.id === 'mcui_layout') {
          if (this.eligibilityDoc !== app.state.doc || this.eligibilitySelection !== key) {
            this.sizeErrors.clear();
            for (const axis of ['width', 'height'] as const)
              for (const mode of ['fixed', 'fill', 'hug', 'expression'] as const)
                this.sizeErrors.set(
                  axis + ':' + mode,
                  targets.length
                    ? sizeModeError(
                        app.state.doc,
                        targets.map((n) => n.id),
                        axis,
                        mode,
                      )
                    : null,
                );
            this.eligibilityDoc = app.state.doc;
            this.eligibilitySelection = key;
          }
          for (const item of extra.node.querySelectorAll('.form_inline_select li')) {
            const axis = item.closest('.form_bar_mcui_sizing_width')
              ? 'width'
              : item.closest('.form_bar_mcui_sizing_height')
                ? 'height'
                : null;
            const reason = axis ? this.sizeErrors.get(axis + ':' + item.getAttribute('key')) : null;
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', reason ? '-1' : '0');
            item.setAttribute('aria-pressed', String(item.classList.contains('selected')));
            item.setAttribute('aria-disabled', String(!!reason));
            if (reason) {
              item.setAttribute('data-mcui-unavailable', '');
              item.setAttribute('title', reason);
            } else {
              item.removeAttribute('data-mcui-unavailable');
              item.removeAttribute('title');
            }
          }
          const hint = extra.form.form_data.mcui_layout_selection?.bar.querySelector('.small_text');
          if (hint) {
            const constrained = targets.some(
              (n) =>
                n.layout.minWidth !== 1 ||
                n.layout.minHeight !== 1 ||
                n.layout.maxWidth !== undefined ||
                n.layout.maxHeight !== undefined,
            );
            hint.textContent =
              (targets.length > 1
                ? `已选 ${targets.length} 项：图示显示首项，修改应用到选区。`
                : '排列与对齐控制子项；尺寸与定位控制当前对象。') +
              (constrained ? ' 已设置尺寸约束。' : '');
          }
        }
        extra.form.updateLabelWidth(true);
      }
      const tabsKey = targets.map((n) => `${n.id}:${n.kind}:${n.content?.kind ?? ''}`).join('|');
      if (tabsKey !== this.tabsKey) {
        this.tabsKey = tabsKey;
        (panel.getHostPanel?.() ?? panel).update();
      }
      if (
        autoSelect &&
        key &&
        key !== this.selectionKey &&
        this.bb.Modes.edit &&
        targets.some((n) => n.kind === 'image' || n.kind === 'frame')
      ) {
        const host = panel.getHostPanel?.() ?? panel;
        host.selectTab(panel);
        panel.folded = false;
      }
      if (autoSelect) this.selectionKey = key;
    } finally {
      this.refreshing = false;
    }
  }
  private validate(formId: string, value: unknown) {
    const field = all.find(
      (f) => formId === FIELD_PREFIX + f.id || formId.endsWith('__' + FIELD_PREFIX + f.id),
    );
    const app = this.current();
    if (!field?.write || !app) throw new Error('当前选区不可编辑');
    const ids = this.targets().map((n) => n.id);
    app.validateChange((doc) => {
      for (const id of ids) field.write!(doc.nodes[id]!, value, doc);
    });
  }
  private registerDraft() {
    const bridge = this,
      Base = this.bb.FormElement.types.text;
    const previous = this.bb.FormElement.types.mcui_draft;
    class Draft extends Base {
      committed = '';
      dirty = false;
      selection = '';
      key() {
        return bridge
          .targets()
          .map((n) => n.id)
          .sort()
          .join('|');
      }
      build(bar: HTMLElement) {
        super.build(bar);
        this.committed = this.input.value;
        this.input.onfocus = () => {
          this.selection = this.key();
        };
        this.input.oninput = () => {
          this.dirty = true;
          this.input.removeAttribute('aria-invalid');
        };
        this.input.onchange = () => this.commit();
        this.input.onblur = () => this.commit();
        this.input.onkeydown = (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this.commit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.dirty = false;
            this.input.value = this.committed;
            this.input.removeAttribute('aria-invalid');
          }
        };
      }
      commit() {
        if (!this.dirty) return;
        if (this.selection !== this.key()) {
          this.dirty = false;
          this.input.value = this.committed;
          return;
        }
        try {
          bridge.validate(this.id, this.input.value);
          this.committed = this.input.value;
          this.dirty = false;
          this.change();
        } catch (error) {
          this.input.setAttribute('aria-invalid', 'true');
          bridge.bb.Blockbench.showQuickMessage(
            error instanceof Error ? error.message : String(error),
            4500,
          );
        }
      }
      getValue() {
        return this.committed;
      }
      setValue(value: string) {
        if (this.dirty && this.selection === this.key()) return;
        this.dirty = false;
        this.committed = String(value ?? '');
        super.setValue(this.committed);
      }
    }
    class PairDraft extends Base {
      inputs: HTMLInputElement[] = [];
      committed = ['0px', '0px'];
      changedAxis: number | undefined;
      dirty = false;
      selection = '';
      key() {
        return bridge
          .targets()
          .map((n) => n.id)
          .sort()
          .join('|');
      }
      build(bar: HTMLElement) {
        bridge.bb.FormElement.prototype.build.call(this, bar);
        const wrap = document.createElement('div');
        wrap.className = 'dialog_vector_group half';
        wrap.style.cssText = 'display:flex;gap:4px';
        bar.append(wrap);
        for (const axis of (this.options.axisLabels ?? ['X', 'Y']).map((s: string) =>
          s.toLowerCase(),
        )) {
          const child = new Base(
            this.id + '_' + axis,
            { type: 'text', placeholder: axis.toUpperCase() },
            this.form,
          );
          const cell = document.createElement('div');
          cell.style.cssText = 'display:flex;align-items:center;gap:3px;flex:1;min-width:0';
          const label = document.createElement('span');
          label.textContent = axis.toUpperCase();
          label.style.cssText = 'font-size:10px;color:var(--color-subtle_text);flex:none';
          cell.append(label);
          wrap.append(cell);
          child.build(cell);
          const input = child.input as HTMLInputElement;
          input.classList.remove('half');
          input.style.cssText = 'width:0;min-width:0;flex:1';
          input.setAttribute(
            'aria-label',
            axis === 'w'
              ? 'UI 宽度'
              : axis === 'h'
                ? 'UI 高度'
                : 'UI ' + axis.toUpperCase() + ' 偏移',
          );
          input.setAttribute('title', axis.toUpperCase());
          this.inputs.push(input);
          input.onfocus = () => {
            this.selection = this.key();
          };
          input.oninput = () => {
            this.dirty = true;
            input.removeAttribute('aria-invalid');
          };
          input.onchange = () => this.commit();
          input.onblur = () => this.commit();
          input.onkeydown = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              this.commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              this.dirty = false;
              this.setValue(this.committed);
            }
          };
        }
      }
      commit() {
        if (!this.dirty) return;
        if (this.selection !== this.key()) {
          this.dirty = false;
          this.setValue(this.committed);
          return;
        }
        const values = this.inputs.map((i) => i.value) as string[] & { changedAxis?: number };
        const changed = values
          .map((v, i) => (v !== this.committed[i] ? i : -1))
          .filter((i) => i >= 0);
        values.changedAxis = changed.length === 1 ? changed[0] : undefined;
        try {
          bridge.validate(this.id, values);
          this.changedAxis = values.changedAxis;
          this.committed = values;
          this.dirty = false;
          this.change();
        } catch (error) {
          for (const i of this.inputs) i.setAttribute('aria-invalid', 'true');
          bridge.bb.Blockbench.showQuickMessage(
            error instanceof Error ? error.message : String(error),
            4500,
          );
        }
      }
      getValue() {
        const values = [...this.committed] as string[] & { changedAxis?: number };
        values.changedAxis = this.changedAxis;
        return values;
      }
      setValue(values: string[]) {
        if (this.dirty && this.selection === this.key()) return;
        this.dirty = false;
        this.changedAxis = undefined;
        this.committed = Array.isArray(values) ? values.map(String) : ['0px', '0px'];
        this.inputs.forEach((input, i) => {
          input.value = this.committed[i] ?? '0px';
          input.removeAttribute('aria-invalid');
        });
      }
    }
    const previousPosition = this.bb.FormElement.types.mcui_pair;
    this.bb.FormElement.registerType('mcui_pair', PairDraft);
    this.life.add(() => {
      if (previousPosition) this.bb.FormElement.types.mcui_pair = previousPosition;
      else delete this.bb.FormElement.types.mcui_pair;
    });
    this.bb.FormElement.registerType('mcui_draft', Draft);
    this.life.add(() => {
      if (previous) this.bb.FormElement.types.mcui_draft = previous;
      else delete this.bb.FormElement.types.mcui_draft;
    });
  }
  stripSerialized(model: HostObject) {
    for (const object of [...(model.elements ?? []), ...(model.groups ?? [])])
      for (const key of this.fieldIds) delete object[key];
  }
  dispose() {
    this.disposed = true;
    this.life.dispose();
    const form = this.bb.Interface.Panels.element.form;
    for (const id of Object.keys(form.form_config))
      if ([...this.fieldIds].some((key) => id === `cube__${key}` || id === `group__${key}`))
        delete form.form_config[id];
    form.buildForm();
    for (const project of this.bb.ModelProject.all)
      for (const node of [...project.elements, ...project.groups])
        for (const key of this.fieldIds) delete node[key];
    this.bb.updateSelection();
  }
}
