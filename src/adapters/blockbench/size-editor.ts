import { common } from '../../application/inspector';
import {
  composeSize,
  formatSize,
  parseSize,
  sizeTerms,
  sizeUnits,
  stepExpression,
} from '../../domain/expression';
import type { Axis, SizeRule, SizeTerm, SizeUnit } from '../../domain/types';
import { button, el, input, select, type ControlContext } from './inspector-controls';
import { scrubLabel } from './input-scrub';
export type SizeEditorMode = 'visual' | 'expression';
interface SizeEditorOptions {
  read(axis: Axis): SizeRule | undefined;
  rules(axis: Axis): SizeRule[];
  resolved(axis: Axis): number | undefined;
  edit(axis: Axis, change: (rule: SizeRule, resolved: number) => SizeRule): void;
  mode(): SizeEditorMode;
  setMode(mode: SizeEditorMode): void;
  contentLabel(): string;
  allowAuto(): boolean;
}
const bases: Record<string, string> = {
  px: 'px 像素',
  ...Object.fromEntries(
    Object.entries(sizeUnits).map(([unit, label]) => [unit, `${unit} ${label}`]),
  ),
  sum: '多项组合',
  default: 'default 父级默认',
  fill: 'fill 剩余空间',
  hug: '内容尺寸（插件）',
  auto: '自动 · 跟随子元素',
};
const descriptions: Record<string, string> = {
  '%': '父级同一轴：宽度参照父宽，高度参照父高。',
  '%x': '自身宽度，通常用于高度计算；宽度引用自身宽度会形成循环。',
  '%y': '自身高度，通常用于宽度计算；高度引用自身高度会形成循环。',
  '%c': '直接子项尺寸之和，含隐藏及绝对子项；不含位置偏移、gap 或 padding。',
  '%cm': '最大可见直接子项的尺寸；不含位置偏移、gap 或 padding，也不是 Image 原图尺寸。',
  '%sm': '自身以外的同级尺寸最大值；没有同级时为 0。',
  default: '基岩默认值：父级同轴 100%。',
  fill: '父级剩余空间；Stack 主轴扣除其他子项、gap、padding 后分配。',
  auto: 'Frame 跟随可见子元素的边界；Stack 跟随排列内容。空 Frame 保留当前尺寸。',
  hug: '插件扩展：Image 的素材原尺寸，或 Frame 的流式布局内容（含间距和内边距）。',
};
const hint =
  '尺寸支持 px、%、%c、%cm、%sm、%x、%y、加减组合、fill、default 和 auto（Frame）；↑/↓ 只调整像素项。';
const basis = (r: SizeRule | undefined) =>
  r?.kind === 'fixed' ? 'px' : r?.kind === 'expression' ? (r.unit ?? '%') : r?.kind;
const constant = (r: SizeRule) =>
  r.kind === 'fixed' ? r.value : r.kind === 'expression' || r.kind === 'sum' ? r.pixels : 0;

/** Native panel content only. Both views write the same parsed rules through the owner transaction. */
export function buildSizeEditor(
  root: HTMLElement,
  ctx: ControlContext,
  options: SizeEditorOptions,
) {
  const heading = el('div', 'mcui-size-heading'),
    title = el('h3', 'mcui-inspector-heading', '自身尺寸'),
    toggle = el('div', 'mcui-inspector-segments');
  heading.append(title, toggle);
  root.append(heading);
  const expression = el('div', 'mcui-inspector-pair'),
    visual = el('div', 'mcui-inspector-pair mcui-size-builder');
  root.append(expression, visual);
  for (const [mode, label] of [
    ['visual', '组合'],
    ['expression', '表达式'],
  ] as const) {
    const b = button(
      label,
      () => {
        if (mode === 'visual' && expression.querySelector('[aria-invalid=true]')) {
          ctx.report(new Error('请先修正表达式，再切换到组合编辑'));
          return;
        }
        options.setMode(mode);
        refresh();
      },
      mode === 'visual' ? '选择参照、比例和像素偏移' : '直接输入完整尺寸公式',
    );
    b.dataset.sizeEditor = mode;
    toggle.append(b);
    ctx.update.push(() => b.setAttribute('aria-pressed', String(options.mode() === mode)));
  }
  const cells: Array<{ refresh: () => void; dispose: () => void }> = [];
  for (const [axis, label] of [
    ['width', '宽度'],
    ['height', '高度'],
  ] as const) {
    const line = el('label', 'mcui-inspector-cell'),
      axisLabel = el('span', '', axis === 'width' ? 'W' : 'H');
    const raw = input(
      ctx,
      `布局${label}`,
      () => {
        const r = options.read(axis);
        return r ? formatSize(r) : undefined;
      },
      (value) => {
        const rule = parseSize(value);
        options.edit(axis, () => rule);
      },
      {
        hint,
        validate: (value) => {
          parseSize(value);
        },
        step: (value, delta) => stepExpression(value, delta, 'size'),
      },
    );
    raw.addEventListener('input', () =>
      expression.classList.toggle(
        'mcui-inspector-long',
        Array.from(expression.querySelectorAll('input')).some((i) => i.value.length > 9),
      ),
    );
    line.append(axisLabel, raw);
    scrubLabel(raw, axisLabel);
    const autoButton = button(
      '自动',
      () => {
        if (!ctx.enabled() || !options.allowAuto()) return;
        try {
          const allAuto = options.rules(axis).every((r) => r.kind === 'auto');
          options.edit(axis, (_rule, resolved) =>
            allAuto ? { kind: 'fixed', value: resolved } : { kind: 'auto' },
          );
        } catch (error) {
          ctx.report(error);
        }
        refresh();
      },
      '自动跟随子元素；再次点击锁定当前尺寸。也可直接输入像素值。',
    );
    autoButton.setAttribute('aria-label', `${label}自动尺寸`);
    autoButton.dataset.autoSize = axis;
    line.append(autoButton);
    ctx.update.push(() => {
      autoButton.hidden = !options.allowAuto();
      autoButton.disabled = !ctx.enabled();
      autoButton.setAttribute(
        'aria-pressed',
        String(options.rules(axis).every((r) => r.kind === 'auto')),
      );
    });
    expression.append(line);
    const cell = el('div', 'mcui-size-axis'),
      caption = el('div', 'mcui-size-caption', axis === 'width' ? 'W 宽度' : 'H 高度'),
      rows = el('div', 'mcui-size-terms'),
      summary = el('div', 'mcui-inspector-hint');
    visual.append(cell);
    const base = select(
      ctx,
      `${label}参照`,
      bases,
      () => common(options.rules(axis).map(basis)),
      (value) =>
        options.edit(axis, (old, resolved) => {
          if (value === 'px') return { kind: 'fixed', value: resolved };
          if (['fill', 'default', 'hug', 'auto'].includes(value))
            return { kind: value as 'fill' | 'default' | 'hug' | 'auto' };
          if (value === 'sum') {
            const ts = [...sizeTerms(old)];
            if (!ts.length) ts.push({ unit: '%', percent: 0 });
            if (ts.length < 2)
              ts.push({
                unit: (Object.keys(sizeUnits) as SizeUnit[]).find((u) => u !== ts[0]!.unit)!,
                percent: 0,
              });
            return composeSize(ts, constant(old));
          }
          const previous = sizeTerms(old)[0];
          return composeSize(
            [{ unit: value as SizeUnit, percent: previous?.percent ?? 1 }],
            old.kind === 'fixed' ? 0 : constant(old),
          );
        }),
    );
    base.title =
      '选择尺寸的参照来源；%x/%y 是自身宽/高，%c 合计子项，%cm 最大可见子项，%sm 最大同级。';
    cell.append(caption, base, rows, summary);
    let signature = '',
      local: ControlContext = { ...ctx, update: [], cleanup: [] };
    const dispose = () => {
      for (const f of local.cleanup.splice(0).reverse()) f();
      local.update.length = 0;
    };
    const refreshAxis = () => {
      const rules = options.rules(axis),
        schema = common(
          rules.map((r) => JSON.stringify([basis(r), sizeTerms(r).map((t) => t.unit)])),
        );
      const rule = schema ? rules[0] : undefined,
        terms = rule ? sizeTerms(rule) : [],
        next = JSON.stringify([basis(rule), terms.map((t) => t.unit)]);
      if (next !== signature) {
        signature = next;
        dispose();
        rows.replaceChildren();
        const number = (
          name: string,
          read: () => number | undefined,
          write: (n: number) => void,
        ) => {
          const control = input(local, name, read, (value) => write(Number(value)), {
            number: true,
          });
          control.step = 'any';
          return control;
        };
        const field = (name: string, node: HTMLInputElement, suffix: string) => {
          const r = el('label', 'mcui-size-term');
          const l = el('span', '', name);
          r.append(l, node, el('span', '', suffix));
          scrubLabel(node, l);
          rows.append(r);
        };
        if (rule?.kind === 'fixed')
          field(
            '数值',
            number(
              `${label}像素`,
              () => {
                return common(
                  options.rules(axis).map((r) => (r.kind === 'fixed' ? r.value : undefined)),
                );
              },
              (value) => options.edit(axis, () => ({ kind: 'fixed', value })),
            ),
            'px',
          );
        else if (rule && (rule.kind === 'expression' || rule.kind === 'sum')) {
          terms.forEach((_, index) => {
            const row = el('div', 'mcui-size-term'),
              unit = select(
                local,
                `${label}第${index + 1}项参照`,
                Object.fromEntries(Object.entries(sizeUnits).map(([k, v]) => [k, `${k} ${v}`])),
                () => {
                  return common(options.rules(axis).map((r) => sizeTerms(r)[index]?.unit));
                },
                (u) =>
                  options.edit(axis, (r) =>
                    composeSize(
                      sizeTerms(r).map((t, i) => (i === index ? { ...t, unit: u as SizeUnit } : t)),
                      constant(r),
                    ),
                  ),
              );
            const value = number(
              `${label}第${index + 1}项比例`,
              () => {
                return common(
                  options.rules(axis).map((r) => {
                    const t = sizeTerms(r)[index];
                    return t ? t.percent * 100 : undefined;
                  }),
                );
              },
              (v) =>
                options.edit(axis, (r) =>
                  composeSize(
                    sizeTerms(r).map((t, i) => (i === index ? { ...t, percent: v / 100 } : t)),
                    constant(r),
                  ),
                ),
            );
            if (terms.length > 1) row.append(unit);
            row.append(value, el('span', '', '%'));
            if (terms.length > 1)
              row.append(
                button(
                  '−',
                  () =>
                    options.edit(axis, (r) =>
                      composeSize(
                        sizeTerms(r).filter((_, i) => i !== index),
                        constant(r),
                      ),
                    ),
                  '移除此参照项',
                ),
              );
            rows.append(row);
          });
          field(
            '偏移',
            number(
              `${label}像素偏移`,
              () => {
                return common(options.rules(axis).map(constant));
              },
              (v) => options.edit(axis, (r) => composeSize(sizeTerms(r), v)),
            ),
            'px',
          );
          const add = button(
            '+ 参照项',
            () =>
              options.edit(axis, (r) => {
                const ts = sizeTerms(r),
                  unit = (Object.keys(sizeUnits) as SizeUnit[]).find(
                    (u) => !ts.some((t) => t.unit === u),
                  );
                return unit ? composeSize([...ts, { unit, percent: 0 }], constant(r)) : r;
              }),
            '添加另一项百分比参照',
          );
          add.disabled = terms.length >= 6;
          rows.append(add);
        }
      }
      for (const f of local.update) f();
      const autoOption = base.querySelector<HTMLOptionElement>('option[value=auto]');
      if (autoOption) {
        autoOption.hidden = !options.allowAuto();
        autoOption.disabled = !options.allowAuto();
      }
      const contentOption = base.querySelector('option[value=hug]');
      if (contentOption) contentOption.textContent = options.contentLabel();
      base.title = descriptions[basis(rule) ?? ''] ?? hint;
      const value = options.read(axis);
      summary.textContent = value ? formatSize(value) : '混合尺寸';
      summary.title =
        rule?.kind === 'hug'
          ? '插件扩展：Image 使用素材原尺寸；Frame 包含流式子项、间距和内边距。'
          : rule?.kind === 'fill'
            ? '占用父级剩余空间；Stack 主轴与其他 fill 子项分配。'
            : rule?.kind === 'default'
              ? '基岩版默认尺寸：父级同轴的 100%。'
              : hint;
    };
    cells.push({ refresh: refreshAxis, dispose });
  }
  const result = el('div', 'mcui-inspector-hint');
  root.append(result);
  function refresh() {
    expression.classList.toggle(
      'mcui-inspector-long',
      Array.from(expression.querySelectorAll('input')).some((i) => i.value.length > 9),
    );
    expression.hidden = options.mode() !== 'expression';
    visual.hidden = options.mode() !== 'visual';
    toggle
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.sizeEditor === options.mode())),
      );
    for (const c of cells) c.refresh();
    const display = (axis: Axis) => {
      const value = options.resolved(axis);
      return value === undefined ? '混合' : Math.round(value * 1000) / 1000;
    };
    result.textContent = `实际尺寸 ${display('width')} × ${display('height')} px`;
  }
  ctx.update.push(refresh);
  ctx.cleanup.push(() => cells.forEach((c) => c.dispose()));
  refresh();
}
