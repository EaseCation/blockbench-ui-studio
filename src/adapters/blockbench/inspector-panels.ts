import type { Studio } from '../../application/studio';
import {
  anchorLabel,
  common,
  editCompound,
  inspect,
  type InspectorModel,
} from '../../application/inspector';
import { sizeModeError } from '../../domain/layout-authoring';
import { hasAppearance } from '../../domain/raster';
import type { UiDocument, UiNode } from '../../domain/types';
import { fields } from './property-fields';
import {
  button,
  color,
  el,
  input,
  matrix,
  select,
  type ControlContext,
} from './inspector-controls';
import { Disposables, type HostObject, type HostRuntime } from './runtime';
import css from './inspector.css';

type Tab = 'element' | 'mcui_layout' | 'mcui_content';
type Section = 'size' | 'frame' | 'position' | 'source' | 'fill' | 'stroke' | 'resolution';

/** Registered native forms compose small stable controls; all edits use the existing transaction. */
export class InspectorPanels {
  readonly panels: HostObject[] = [];
  private life = new Disposables();
  private cleanup: (() => void)[] = [];
  private updates: (() => void)[] = [];
  private nodes: UiNode[] = [];
  private doc?: UiDocument;
  private model?: InspectorModel;
  private preferred: Tab = 'element';
  private opened: Record<string, boolean> = {};
  private refreshing = false;
  private disposed = false;
  private sizes = new Map<string, string | null>();
  private sizeDoc?: UiDocument;
  private sizeKey = '';
  private context: ControlContext;
  constructor(
    readonly bb: HostRuntime,
    readonly current: () => Studio | null,
    readonly targets: () => UiNode[],
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem('mcui_preferences') ?? '{}').inspector;
      if (['element', 'mcui_layout', 'mcui_content'].includes(saved?.tab))
        this.preferred = saved.tab;
      if (saved?.open && typeof saved.open === 'object') this.opened = saved.open;
    } catch {
      /* Missing or malformed local preferences use defaults. */
    }
    this.context = {
      key: () =>
        this.current()?.state.doc.id +
        ':' +
        this.targets()
          .map((n) => n.id)
          .sort()
          .join('|'),
      enabled: () =>
        !this.disposed &&
        !!this.nodes.length &&
        !this.model?.suspended &&
        this.current()?.state.doc.id === this.doc?.id,
      update: this.updates,
      cleanup: this.cleanup,
      report: (error) =>
        bb.Blockbench.showQuickMessage(
          error instanceof Error ? error.message : String(error),
          4500,
        ),
    };
    const style = el('style');
    style.textContent = css;
    document.head.append(style);
    this.life.add(() => style.remove());
    const owner = this,
      Base = bb.FormElement,
      previous = Base.types.mcui_inspector_section;
    class InspectorSection extends Base {
      build(bar: HTMLElement) {
        super.build(bar);
        const root = el('div', 'mcui-inspector-section');
        root.dataset.section = this.options.section;
        bar.append(root);
        owner.build(this.options.section, root);
      }
    }
    Base.registerType('mcui_inspector_section', InspectorSection);
    this.life.add(() => {
      if (previous) Base.types.mcui_inspector_section = previous;
      else delete Base.types.mcui_inspector_section;
    });
    this.create('mcui_layout', 'UI 布局', ['size', 'frame', 'position'], 1);
    this.create('mcui_content', 'UI 内容', ['source', 'fill', 'stroke', 'resolution'], 2);
    for (const panel of [bb.Interface.Panels.element, ...this.panels]) {
      this.life.listen(panel.handle, 'mousedown', (() => {
        this.preferred = panel.id;
        this.save();
      }) as EventListener);
    }
  }
  private save() {
    try {
      const preferences = JSON.parse(localStorage.getItem('mcui_preferences') ?? '{}');
      localStorage.setItem(
        'mcui_preferences',
        JSON.stringify({ ...preferences, inspector: { tab: this.preferred, open: this.opened } }),
      );
    } catch {
      /* A storage failure must not prevent editing. */
    }
  }
  showLayout() {
    this.preferred = 'mcui_layout';
    this.save();
    this.selectPreferredTab();
  }
  selectPreferredTab() {
    if (!this.nodes.length || this.disposed) return;
    const id =
      this.preferred === 'mcui_content' && !this.model?.images ? 'mcui_layout' : this.preferred;
    const panel = this.bb.Interface.Panels[id];
    if (!panel) return;
    (panel.getHostPanel?.() ?? panel).selectTab(panel);
    panel.folded = false;
  }
  private create(id: string, name: string, sections: Section[], index: number) {
    const form: Record<string, unknown> = {};
    for (const section of sections)
      form['mcui_' + section] = {
        type: 'mcui_inspector_section',
        full_width: true,
        section,
        condition: () => section !== 'frame' || !!this.model?.frames,
      };
    const applicable = () =>
      !!this.current() &&
      this.bb.Modes.edit &&
      this.targets().length > 0 &&
      (id !== 'mcui_content' || this.targets().every((n) => n.kind === 'image'));
    const panel = new this.bb.Panel(id, {
      name,
      icon: id === 'mcui_layout' ? 'view_quilt' : 'image',
      form: new this.bb.InputForm(form),
      min_height: 90,
      condition: applicable,
      display_condition: applicable,
      default_position: {
        slot: 'right_bar',
        attached_to: this.bb.Interface.Panels.element.getHostPanel()?.id ?? 'element',
        attached_index: -index,
        height: 400,
        sidebar_index: 3 + index,
      },
    });
    panel.form.node.classList.add('mcui-inspector');
    const status = el('div', 'mcui-inspector-status');
    status.setAttribute('role', 'status');
    panel.form.node.prepend(status);
    const recovery = el('div', 'mcui-inspector-row');
    recovery.append(
      this.action('采用当前结果', 'mcui_adopt'),
      this.action('按规则重新生成', 'mcui_regenerate'),
    );
    panel.form.node.prepend(recovery);
    this.updates.push(() => {
      status.textContent =
        this.model?.suspended ||
        (this.nodes.length > 1
          ? `已选 ${this.nodes.length} 项 · 混合值分别保留，只修改编辑项`
          : '');
      recovery.hidden = !this.model?.suspended || this.nodes.length !== 1;
    });
    this.panels.push(panel);
  }
  private value<T = any>(id: string): T | undefined {
    const field = fields.find((f) => f.id === id);
    return field ? common(this.nodes.map((n) => field.read(n) as T)) : undefined;
  }
  private axis(id: string, axis: number) {
    const field = fields.find((f) => f.id === id)!;
    return common(this.nodes.map((n) => (field.read(n) as (string | number)[])[axis]));
  }
  private commit(id: string, value: unknown) {
    const app = this.current();
    if (!app || !this.context.enabled()) throw new Error('当前选区不可编辑');
    const ids = this.nodes.map((n) => n.id);
    if (this.context.key() !== this.model?.key) throw new Error('选区已改变，请重新编辑');
    const field = fields.find((f) => f.id === id);
    const change = (doc: UiDocument) => {
      for (const nodeId of ids) {
        const node = doc.nodes[nodeId]!;
        if (node.suspended) throw new Error('请先处理原生修改保护');
        if (!editCompound(node, id, value)) {
          if (!field?.write || (field.applies && !field.applies(node)))
            throw new Error('此属性不适用于当前选区');
          field.write(node, value, doc);
        }
      }
    };
    app.validateChange(change);
    if (!app.execute('修改 ' + (field?.label ?? 'UI 属性'), change))
      throw new Error(app.state.error ?? '修改失败');
    this.refresh();
  }
  private perform(id: string, value: unknown) {
    try {
      this.commit(id, value);
    } catch (error) {
      this.context.report(error);
    }
  }
  private action(label: string, id: string, hint = label) {
    return button(label, () => this.bb.BarItems[id]?.trigger(), hint);
  }
  private heading(root: HTMLElement, title: string) {
    const h = el('h3', 'mcui-inspector-heading', title);
    root.append(h);
    return h;
  }
  private hint(root: HTMLElement, text = '') {
    const h = el('div', 'mcui-inspector-hint', text);
    root.append(h);
    return h;
  }
  private pair(root: HTMLElement) {
    const p = el('div', 'mcui-inspector-pair');
    root.append(p);
    return p;
  }
  private row(root: HTMLElement) {
    const p = el('div', 'mcui-inspector-row');
    root.append(p);
    return p;
  }
  private cell(root: HTMLElement, label: string, control: HTMLElement) {
    const c = el('label', 'mcui-inspector-cell');
    c.append(el('span', '', label), control);
    root.append(c);
    return c;
  }
  private disclosure(root: HTMLElement, id: string, label: () => string) {
    const details = el('details'),
      summary = el('summary');
    details.dataset.disclosure = id;
    details.open = this.opened[id] === true;
    details.append(summary);
    root.append(details);
    details.ontoggle = () => {
      this.opened[id] = details.open;
      this.save();
    };
    this.updates.push(() => {
      summary.textContent = label();
    });
    return details;
  }
  private number(id: string, label?: string, min?: number) {
    const f = fields.find((f) => f.id === id)!;
    return input(
      this.context,
      label ?? f.label.replace(/^UI /, ''),
      () => this.value(id),
      (v) => this.commit(id, Number(v)),
      { number: true, min: min ?? f.min, hint: f.description },
    );
  }
  private choose(id: string, label?: string) {
    const f = fields.find((f) => f.id === id)!;
    const node = select(
      this.context,
      label ?? f.label.replace(/^UI /, ''),
      f.options!,
      () => this.value(id),
      (v) => this.commit(id, v),
    );
    node.title = f.description ?? f.label;
    return node;
  }
  private textPair(
    root: HTMLElement,
    id: 'size' | 'offset' | 'image_offset',
    labels: [string, string],
    disabled?: () => boolean,
  ) {
    const pair = this.pair(root),
      f = fields.find((f) => f.id === id)!;
    labels.forEach((label, i) => {
      const name =
        id === 'size'
          ? `布局${i ? '高度' : '宽度'}`
          : id === 'offset'
            ? `布局 ${label} 偏移`
            : `图片 ${label} 偏移`;
      const control = input(
        this.context,
        name,
        () => this.axis(id, i),
        (v) => {
          const values: any = [0, 0];
          values[i] = id === 'image_offset' ? Number(v) : v;
          values.changedAxis = i;
          this.commit(id, values);
        },
        { hint: f.description, number: id === 'image_offset', disabled },
      );
      this.cell(pair, label, control);
    });
    return pair;
  }
  private build(section: Section, root: HTMLElement) {
    if (section === 'size') this.buildSize(root);
    if (section === 'frame') this.buildFrame(root);
    if (section === 'position') this.buildPosition(root);
    if (section === 'source') this.buildSource(root);
    if (section === 'fill' || section === 'stroke') this.buildStyle(root, section);
    if (section === 'resolution') this.buildResolution(root);
  }
  private buildSize(root: HTMLElement) {
    this.heading(root, '自身尺寸');
    const pair = this.textPair(root, 'size', ['W', 'H']);
    for (const [i, axis] of (['width', 'height'] as const).entries()) {
      const mode = select(
        this.context,
        i ? '高度模式' : '宽度模式',
        { fixed: '固定', fill: '填充', hug: '包裹', expression: '%' },
        () => this.value('sizing_' + axis),
        (v) => this.commit('sizing_' + axis, v),
        (mode) => this.sizes.get(axis + ':' + mode) ?? null,
      );
      mode.classList.add('mcui-inspector-size-mode');
      pair.children[i]!.append(mode);
      mode.title = '固定／填充／包裹／百分比表达式；输入具体数值会改为固定尺寸';
    }
    const resolved = this.hint(root);
    this.updates.push(() => {
      pair.classList.toggle(
        'mcui-inspector-long',
        this.nodes.some(
          (n) => n.layout.width.kind === 'expression' || n.layout.height.kind === 'expression',
        ),
      );
      resolved.textContent = this.nodes.some(
        (n) => n.layout.width.kind !== 'fixed' || n.layout.height.kind !== 'fixed',
      )
        ? (common(this.nodes.map((n) => `实际 ${n.rect.width} × ${n.rect.height}px`)) ??
          '实际尺寸混合')
        : '';
    });
    const details = this.disclosure(
      root,
      'limits',
      () => '尺寸限制 · ' + (this.model?.constraints ?? '未设置'),
    );
    const min = this.pair(details),
      max = this.pair(details);
    max.classList.add('mcui-inspector-space');
    this.cell(min, '最小 W', this.number('minWidth', '最小宽度'));
    this.cell(min, 'H', this.number('minHeight', '最小高度'));
    for (const [key, name] of [
      ['maxWidth', '最大宽度'],
      ['maxHeight', '最大高度'],
    ]) {
      const node = input(
        this.context,
        name!,
        () => this.value(key!),
        (v) => this.commit(key!, v),
        { hint: '正数或留空表示不限' },
      );
      this.cell(max, key === 'maxWidth' ? '最大 W' : 'H', node);
    }
  }
  private buildFrame(root: HTMLElement) {
    this.heading(root, '子项排列');
    const flow = el('div', 'mcui-inspector-segments');
    root.append(flow);
    for (const [key, label] of Object.entries({ free: '自由', row: '→ 横向', column: '↓ 纵向' })) {
      const b = button(label, () => this.perform('direction', key));
      b.dataset.flow = key;
      flow.append(b);
      this.updates.push(() => {
        b.disabled = !this.context.enabled();
        b.setAttribute('aria-pressed', String(this.value('direction') === key));
      });
    }
    const auto = el('div', 'mcui-inspector-alignment');
    root.append(auto);
    const left = el('div'),
      right = el('div', 'mcui-inspector-stack');
    auto.append(left, right);
    this.hint(left, '子项对齐');
    const alignment = () => this.value<any[]>('alignment');
    left.append(
      matrix(
        this.context,
        '子项对齐',
        () => {
          const v = alignment();
          if (!v) return undefined;
          const x = v[2] && v[3] === 'row' ? 1 : v[0],
            y = v[2] && v[3] === 'column' ? 1 : v[1];
          return `${x / 2},${y / 2}`;
        },
        (value) => {
          const [x, y] = value.split(',').map((v) => Number(v) * 2);
          // Preserve each selected frame's distribution and direction, including mixed selections.
          this.commit('alignment', [x, y, undefined, undefined]);
        },
        (x, y) => {
          const values = this.nodes.map((n) => n.frame!);
          return values.every(
            (v) =>
              !v || v.justify !== 'space-between' || (v.direction === 'row' ? x === 1 : y === 1),
          );
        },
      ),
    );
    this.hint(right, '间距方式');
    right.append(
      select(
        this.context,
        '间距方式',
        { fixed: '固定间距', auto: 'Auto · 两端分布' },
        () =>
          common(this.nodes.map((n) => (n.frame?.justify === 'space-between' ? 'auto' : 'fixed'))),
        (v) => this.commit('gapMode', v),
      ),
    );
    const gapLabel = this.hint(right);
    right.append(this.number('gap', '间距数值'));
    this.updates.push(() => {
      auto.hidden = !this.nodes.every((n) => n.frame?.direction !== 'free');
      gapLabel.textContent = this.nodes.some((n) => n.frame?.justify === 'space-between')
        ? '最小间距 · px'
        : '间距 · px';
    });
    const padding = el('div', 'mcui-inspector-space');
    root.append(padding);
    const head = this.row(padding),
      caption = el('span', 'mcui-inspector-grow');
    head.append(caption);
    let four = this.opened.paddingFour === true,
      linked = false;
    const expand = button('四边', () => {
      four = !four;
      this.opened.paddingFour = four;
      this.save();
      updatePadding();
    });
    head.append(expand);
    const pairs = this.pair(padding);
    pairs.classList.add('mcui-inspector-space');
    for (const [axis, label] of [
      ['horizontal', '水平'],
      ['vertical', '垂直'],
    ]) {
      const indices = axis === 'horizontal' ? [1, 3] : [0, 2];
      this.cell(
        pairs,
        label!,
        input(
          this.context,
          `${label}内边距`,
          () => common(this.nodes.flatMap((n) => indices.map((i) => n.frame?.padding[i]))),
          (v) => this.commit('padding_' + axis, Number(v)),
          { number: true, min: 0 },
        ),
      );
    }
    const sides = this.pair(padding);
    sides.classList.add('mcui-inspector-space');
    ['上', '右', '下', '左'].forEach((side, i) =>
      this.cell(
        sides,
        side,
        input(
          this.context,
          side + '内边距',
          () => this.axis('padding', i),
          (v) => {
            if (linked) this.commit('padding_all', Number(v));
            else {
              const values: any = [0, 0, 0, 0];
              values[i] = Number(v);
              values.changedSide = i;
              this.commit('padding', values);
            }
          },
          { number: true, min: 0 },
        ),
      ),
    );
    const link = button(
      '联动四边',
      () => {
        linked = !linked;
        updatePadding();
      },
      '启用后下一次输入统一四边；切换本身不改数值',
    );
    link.setAttribute('aria-label', '联动四边内边距');
    padding.append(link);
    const updatePadding = () => {
      const values = common(this.nodes.map((n) => n.frame?.padding));
      caption.textContent =
        '内边距 · ' +
        (values
          ? values[1] === values[3] && values[0] === values[2]
            ? `${values[1]} / ${values[0]}`
            : `上${values[0]} 右${values[1]} 下${values[2]} 左${values[3]}`
          : '混合');
      expand.textContent = four ? '水平／垂直' : '四边';
      expand.setAttribute('aria-expanded', String(four));
      pairs.hidden = four;
      sides.hidden = !four;
      link.hidden = !four;
      link.setAttribute('aria-pressed', String(linked));
    };
    this.updates.push(updatePadding);
  }
  private buildPosition(root: HTMLElement) {
    this.heading(root, '自身定位');
    const position = this.choose('positioning', '定位方式');
    root.append(position);
    const controlled = this.hint(root),
      offset = this.textPair(root, 'offset', ['X', 'Y'], () => !!this.model?.anyFlowControlled);
    offset.classList.add('mcui-inspector-space');
    const anchors = el('div', 'mcui-inspector-space');
    root.append(anchors);
    const caption = this.hint(anchors);
    anchors.append(
      matrix(
        this.context,
        '定位预设',
        () => this.model?.preset,
        (v) => this.commit('anchorPreset', v),
      ),
    );
    const independent = this.disclosure(
      anchors,
      'anchors',
      () => '独立锚点 · ' + (this.model?.anchors ?? ''),
    );
    const pair = this.pair(independent);
    for (const [id, label] of [
      ['anchorFrom', '父锚点'],
      ['anchorTo', '自身锚点'],
    ]) {
      const cell = el('div');
      pair.append(cell);
      this.hint(cell, label!);
      cell.append(
        matrix(
          this.context,
          label!,
          () => this.value(id!),
          (v) => this.commit(id!, v),
        ),
      );
    }
    const contribution = this.disclosure(
      root,
      'contribution',
      () =>
        '父级包裹 · ' +
        (common(this.nodes.map((n) => (n.layout.positioning === 'flow' ? '计入' : '不计入'))) ??
          '混合'),
    );
    contribution.append(
      select(
        this.context,
        '父级包裹统计',
        { flow: '计入父级包裹', absolute: '不计入父级包裹' },
        () => this.value('positioning'),
        (v) => this.commit('positioning', v),
      ),
    );
    const wrap = this.action('将选区组成自动布局', 'mcui_wrap_layout');
    root.append(wrap);
    this.updates.push(() => {
      position.hidden = !this.model?.hasParent || !this.model.parentStack;
      controlled.textContent = this.model?.anyFlowControlled
        ? '位置由父级自动布局控制；切换为绝对定位后可编辑。'
        : '';
      anchors.hidden = !this.model?.hasParent || !!this.model.anyFlowControlled;
      caption.textContent =
        '定位预设 · ' +
        (this.model?.preset
          ? anchorLabel(this.model.preset.split(',').map(Number))
          : '自定义／混合');
      contribution.hidden = !this.model?.hasParent || !!this.model.parentStack;
      if (this.model?.hasParent && !this.model.parentFrame)
        contribution.querySelector('summary')!.textContent =
          '定位角色 · ' + (this.value('positioning') === 'absolute' ? '绝对定位' : '自由定位');
      wrap.hidden = this.nodes.length < 2;
      wrap.disabled =
        !this.context.enabled() || new Set(this.nodes.map((n) => n.parent)).size !== 1;
    });
  }
  private buildSource(root: HTMLElement) {
    const header = this.row(root),
      thumbnail = el('img', 'mcui-inspector-source'),
      body = el('div', 'mcui-inspector-grow');
    thumbnail.alt = '源素材预览';
    header.append(thumbnail, body);
    const title = this.heading(body, '素材'),
      sourceInfo = this.hint(body);
    const actions = this.row(root);
    actions.classList.add('mcui-inspector-space');
    const paint = this.action('绘画', 'mcui_edit_source'),
      preview = this.action('预览', 'mcui_content_preview'),
      replace = this.action('导入／替换', 'mcui_import_image');
    actions.append(paint, preview, replace);
    const image = el('div', 'mcui-inspector-space');
    root.append(image);
    this.cell(image, '适配', this.choose('image_mode', '图片适配'));
    const crop = el('div', 'mcui-inspector-space');
    image.append(crop);
    this.cell(crop, '倍率', this.number('image_scale', '图片倍率'));
    this.textPair(crop, 'image_offset', ['X', 'Y']).classList.add('mcui-inspector-space');
    const imageOptions = this.disclosure(image, 'imageOptions', () => {
      const anchor = this.value<string>('image_anchor');
      const down = this.value<boolean>('only_downscale');
      return `图片对齐 · ${anchorLabel(anchor?.split(',').map(Number))}${down === true ? ' · 只允许缩小' : down === undefined ? ' · 缩放限制混合' : ''}`;
    });
    imageOptions.append(
      matrix(
        this.context,
        '图片锚点',
        () => this.value('image_anchor'),
        (v) => this.commit('image_anchor', v),
      ),
    );
    const downLabel = el('label', 'mcui-inspector-row mcui-inspector-space'),
      down = el('input', 'focusable_input');
    down.type = 'checkbox';
    downLabel.append(down, el('span', '', '只允许缩小'));
    imageOptions.append(downLabel);
    down.onchange = () => this.perform('only_downscale', down.checked);
    const inactive = this.hint(image);
    const nine = el('div', 'mcui-inspector-space');
    root.append(nine);
    this.cell(nine, '九宫格', this.choose('nine_mode', '九宫格模式'));
    const insets = this.hint(nine);
    const nineDetails = this.disclosure(nine, 'nineInsets', () => '四边参数 · 源图像素');
    const sides = this.pair(nineDetails);
    ['上', '右', '下', '左'].forEach((side, i) =>
      this.cell(
        sides,
        side,
        input(
          this.context,
          '九宫格' + side + '边距',
          () => this.axis('nine_insets', i),
          (v) => {
            const values: any = [0, 0, 0, 0];
            values[i] = Number(v);
            values.changedSide = i;
            this.commit('nine_insets', values);
          },
          { number: true, min: 0 },
        ),
      ),
    );
    const makeNine = this.action('设为九宫格', 'mcui_nine_slice');
    root.append(makeNine);
    const restore = this.action('恢复原始来源', 'mcui_restore_source');
    root.append(restore);
    this.updates.push(() => {
      const n = this.nodes[0],
        asset = n?.content && this.doc?.assets[n.content.source];
      title.textContent =
        this.model?.contentKind === 'paint'
          ? '像素绘画'
          : this.model?.contentKind === 'nine-slice'
            ? '九宫格素材'
            : this.model?.contentKind === 'image'
              ? '图片素材'
              : this.model?.contentKind === 'generated'
                ? '文字素材'
                : '混合素材';
      thumbnail.hidden = this.nodes.length !== 1 || !asset;
      if (asset && thumbnail.getAttribute('src') !== asset.png) thumbnail.src = asset.png;
      sourceInfo.textContent =
        this.nodes.length === 1 && asset
          ? `源图 ${asset.width}×${asset.height}`
          : `${this.nodes.length} 项 · 素材分别保留`;
      paint.textContent =
        n?.content?.kind === 'generated'
          ? '编辑文字'
          : hasAppearance(n?.appearance)
            ? '合成后绘画'
            : n?.content?.kind === 'paint'
              ? '绘画'
              : '编辑源图';
      paint.title = hasAppearance(n?.appearance)
        ? '先合并填充与描边为像素，再进入绘画；可撤销并恢复原始来源'
        : '进入原生绘画或源图编辑';
      preview.textContent = this.model?.contentKind === 'nine-slice' ? '编辑切片' : '预览裁切';
      preview.hidden = ['paint', 'generated'].includes(this.model?.contentKind ?? '');
      for (const b of [paint, preview, replace, makeNine, restore])
        b.disabled = this.nodes.length !== 1 || !this.context.enabled();
      image.hidden = this.model?.contentKind !== 'image';
      crop.hidden = !this.nodes.every(
        (n) => n.content?.kind === 'image' && n.content.mode === 'crop',
      );
      const stretch = this.value('image_mode') === 'stretch';
      imageOptions.hidden = stretch;
      inactive.textContent =
        stretch && this.nodes.some((n) => n.content?.kind === 'image' && n.content.onlyDownscale)
          ? '已保存「只允许缩小」；拉伸模式下不生效'
          : '';
      down.indeterminate = this.value('only_downscale') === undefined;
      down.checked = this.value('only_downscale') === true;
      down.disabled = !this.context.enabled();
      nine.hidden = this.model?.contentKind !== 'nine-slice';
      const v = this.value<number[]>('nine_insets');
      insets.textContent = v ? `上 ${v[0]} · 右 ${v[1]} · 下 ${v[2]} · 左 ${v[3]}` : '四边参数混合';
      makeNine.hidden =
        this.nodes.length !== 1 || ['nine-slice', 'generated'].includes(n?.content?.kind ?? '');
      restore.hidden = this.nodes.length !== 1 || !n?.originalContent;
    });
  }
  private buildStyle(root: HTMLElement, kind: 'fill' | 'stroke') {
    const row = this.row(root),
      heading = this.heading(row, kind === 'fill' ? '填充' : '描边');
    heading.classList.add('mcui-inspector-grow');
    const field = kind === 'fill' ? 'style_fill' : 'style_stroke';
    const add = button('＋ 添加', () => this.perform(field, kind === 'fill' ? 'solid' : 1));
    add.setAttribute('aria-label', '添加' + (kind === 'fill' ? '填充' : '描边'));
    row.append(add);
    const controls = el('div', 'mcui-inspector-style-row');
    root.append(controls);
    controls.append(
      color(
        this.bb,
        this.context,
        kind === 'fill' ? '填充颜色' : '描边颜色',
        () => this.value(kind === 'fill' ? 'style_color' : 'style_strokeColor'),
        (v) => this.commit(kind === 'fill' ? 'style_color' : 'style_strokeColor', v),
      ),
    );
    controls.append(
      kind === 'fill'
        ? this.choose('style_fill', '填充类型')
        : this.number('style_stroke', '描边粗细'),
    );
    const remove = button('移除', () => this.perform(field, kind === 'fill' ? 'none' : 0));
    remove.setAttribute('aria-label', '移除' + (kind === 'fill' ? '填充' : '描边'));
    controls.append(remove);
    const extra = el('div', 'mcui-inspector-pair mcui-inspector-space');
    root.append(extra);
    if (kind === 'fill') {
      extra.append(
        color(
          this.bb,
          this.context,
          '渐变终点',
          () => this.value('style_endColor'),
          (v) => this.commit('style_endColor', v),
        ),
      );
      this.cell(extra, '角度', this.number('style_angle', '渐变角度'));
    }
    const hint = this.hint(root);
    this.updates.push(() => {
      const allOff = this.nodes.every((n) =>
        kind === 'fill'
          ? !n.appearance || n.appearance.fill === 'none'
          : !n.appearance?.strokeWidth,
      );
      const someOff = this.nodes.some((n) =>
        kind === 'fill'
          ? !n.appearance || n.appearance.fill === 'none'
          : !n.appearance?.strokeWidth,
      );
      add.hidden = !allOff;
      controls.hidden = allOff;
      extra.hidden = kind !== 'fill' || !this.nodes.every((n) => n.appearance?.fill === 'linear');
      add.disabled = remove.disabled = !this.context.enabled();
      hint.textContent =
        someOff && !allOff
          ? '混合 · 部分图层未启用'
          : kind === 'stroke' && !allOff
            ? '内描边 · 贴图像素'
            : '';
    });
  }
  private buildResolution(root: HTMLElement) {
    this.heading(root, '尺寸变化');
    const mode = select(
      this.context,
      '尺寸变化策略',
      {
        'text-reflow': '文字 · 调整文本框并重排',
        'text-scale': '文字 · 缩放成品',
        preserve: '保留贴图',
        extend: '跟随显示尺寸 · 扩展画布',
        scale: '跟随显示尺寸 · 重采样',
        image: '跟随显示尺寸 · 按图片适配生成',
        nine: '跟随显示尺寸 · 九宫格生成',
      },
      () => this.model?.strategy,
      (v) => this.commit('resizeStrategy', v),
    );
    root.append(mode);
    const summary = this.hint(root),
      tip = this.hint(root);
    const flatten = this.action(
      '合成为可绘制像素',
      'mcui_flatten',
      '合并源内容、填充与描边；可撤销，或恢复原始来源',
    );
    root.append(flatten);
    this.updates.push(() => {
      const kind = this.model?.contentKind;
      for (const option of Array.from(mode.options).slice(1))
        option.hidden = !(kind === 'generated'
          ? ['text-reflow', 'text-scale'].includes(option.value)
          : kind === 'nine-slice'
            ? option.value === 'nine'
            : option.value === 'preserve' ||
              (kind === 'paint'
                ? ['extend', 'scale'].includes(option.value)
                : kind === 'image' && option.value === 'image'));
      mode.disabled =
        !this.context.enabled() || !kind || ['nine-slice', 'generated'].includes(kind);
      summary.textContent = this.model?.resolution ?? '';
      tip.textContent =
        kind === 'generated'
          ? '在「文字」标签中设置重排／缩放和栅格密度；缺少文字插件时仅使用保存的成品。'
          : this.model?.strategy === 'preserve'
            ? '改变显示大小不会重采样贴图或改变 UV。'
            : this.model?.strategy === 'nine'
              ? '按目标尺寸生成，保持源图四角。'
              : '';
      flatten.hidden =
        this.nodes.length !== 1 || (kind === 'paint' && !hasAppearance(this.nodes[0]?.appearance));
      flatten.disabled = !this.context.enabled();
    });
  }
  refresh() {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      this.nodes = this.targets();
      this.doc = this.current()?.state.doc;
      this.model = this.doc ? inspect(this.doc, this.nodes) : undefined;
      if (this.doc && (this.doc !== this.sizeDoc || this.sizeKey !== this.model?.key)) {
        this.sizes.clear();
        this.sizeDoc = this.doc;
        this.sizeKey = this.model!.key;
        for (const axis of ['width', 'height'] as const)
          for (const mode of ['fixed', 'fill', 'hug', 'expression'] as const)
            this.sizes.set(
              axis + ':' + mode,
              sizeModeError(
                this.doc,
                this.nodes.map((n) => n.id),
                axis,
                mode,
              ),
            );
      }
      for (const update of this.updates) update();
      for (const panel of this.panels) panel.form.updateValues();
    } finally {
      this.refreshing = false;
    }
  }
  dispose() {
    this.disposed = true;
    for (const dispose of this.cleanup.splice(0).reverse()) dispose();
    for (const panel of this.panels) panel.delete();
    this.life.dispose();
    this.updates = [];
  }
}
