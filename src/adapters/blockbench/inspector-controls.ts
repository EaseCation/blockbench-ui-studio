import type { HostRuntime } from './runtime';
import { inputStep, stepNumber } from './input-step';
import { bindScrub } from './input-scrub';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
export interface ControlContext {
  key(): string;
  enabled(): boolean;
  update: (() => void)[];
  cleanup: (() => void)[];
  report(error: unknown): void;
  beginScrub?(): (commit: boolean) => void;
}

export function button(label: string, run: () => void, title = label) {
  const b = el('button', 'mcui-inspector-button', label);
  b.type = 'button';
  b.title = title;
  b.onclick = run;
  return b;
}

/** Stable draft controls survive refresh and cannot commit against a different selection. */
export function input(
  ctx: ControlContext,
  label: string,
  read: () => string | number | undefined,
  write: (value: string) => void,
  options: {
    number?: boolean;
    min?: number;
    hint?: string;
    disabled?: () => boolean;
    step?: (value: string, delta: number) => string;
  } = {},
) {
  const node = el('input', 'focusable_input mcui-inspector-input');
  const step =
    options.step ??
    (options.number
      ? (value: string, delta: number) => stepNumber(value, delta, options.min)
      : undefined);
  node.type = options.number ? 'number' : 'text';
  if (options.min !== undefined) node.min = String(options.min);
  node.step = '1';
  node.setAttribute('aria-label', label);
  node.title = options.hint ?? label;
  let dirty = false,
    key = '',
    committed = '';
  const refresh = () => {
    const changed = key !== ctx.key();
    if (changed) dirty = false;
    key = ctx.key();
    node.disabled = !ctx.enabled() || !!options.disabled?.();
    if (dirty) return;
    const value = read();
    committed = value === undefined ? '' : String(value);
    node.value = committed;
    node.placeholder = value === undefined ? '混合' : '';
    node.removeAttribute('aria-invalid');
  };
  const commit = () => {
    if (!dirty) return;
    if (key !== ctx.key() || !ctx.enabled()) {
      dirty = false;
      refresh();
      return;
    }
    if (node.value === committed) {
      dirty = false;
      return;
    }
    try {
      if (options.number && (node.value.trim() === '' || !Number.isFinite(Number(node.value))))
        throw new Error(`${label}需要有效数值`);
      if (options.min !== undefined && Number(node.value) < options.min)
        throw new Error(`${label}不能小于 ${options.min}`);
      const value = node.value;
      dirty = false;
      write(value);
      refresh();
    } catch (error) {
      dirty = true;
      node.setAttribute('aria-invalid', 'true');
      ctx.report(error);
    }
  };
  node.onfocus = () => {
    key = ctx.key();
  };
  node.oninput = () => {
    dirty = true;
    node.removeAttribute('aria-invalid');
  };
  node.onchange = commit;
  node.onblur = commit;
  node.onkeydown = (e) => {
    const delta = step ? inputStep(e) : null;
    if (delta !== null && step) {
      if (node.disabled || node.readOnly || key !== ctx.key() || !ctx.enabled()) return;
      try {
        const next = step(node.value, delta);
        if (next === node.value) return;
        node.value = next;
        dirty = true;
        commit();
      } catch (error) {
        node.setAttribute('aria-invalid', 'true');
        ctx.report(error);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dirty = false;
      refresh();
    }
  };
  ctx.update.push(refresh);
  if (step && ctx.beginScrub)
    ctx.cleanup.push(
      bindScrub(node, {
        key: ctx.key,
        enabled: () => ctx.enabled() && !options.disabled?.(),
        step,
        report: ctx.report,
        refresh,
        begin: () => {
          const finish = ctx.beginScrub!();
          dirty = false;
          return {
            preview: (value) => {
              write(value);
              return true;
            },
            finish,
          };
        },
      }),
    );
  return node;
}

export function select(
  ctx: ControlContext,
  label: string,
  options: Record<string, string>,
  read: () => string | undefined,
  write: (value: string) => void,
  unavailable?: (value: string) => string | null,
) {
  const node = el('select', 'focusable_input mcui-inspector-select');
  node.setAttribute('aria-label', label);
  const mixed = el('option', '', '混合');
  mixed.value = '';
  mixed.disabled = true;
  node.append(mixed);
  for (const [value, text] of Object.entries(options)) {
    const option = el('option', '', text);
    option.value = value;
    node.append(option);
  }
  node.onchange = () => {
    try {
      write(node.value);
    } catch (error) {
      ctx.report(error);
    }
    refresh();
  };
  const refresh = () => {
    node.disabled = !ctx.enabled();
    node.value = read() ?? '';
    for (const option of Array.from(node.options).slice(1)) {
      const reason = unavailable?.(option.value);
      option.disabled = !!reason;
      option.title = reason ?? '';
      option.textContent = options[option.value]! + (reason ? `（${reason}）` : '');
    }
  };
  ctx.update.push(refresh);
  return node;
}

export function matrix(
  ctx: ControlContext,
  label: string,
  read: () => string | undefined,
  write: (value: string) => void,
  allowed: (x: number, y: number) => boolean = () => true,
) {
  const root = el('div', 'mcui-inspector-matrix');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const buttons: HTMLButtonElement[] = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++) {
      const value = `${x / 2},${y / 2}`;
      const b = button('•', () => {
        if (ctx.enabled()) {
          try {
            write(value);
          } catch (error) {
            ctx.report(error);
          }
        }
      });
      const name = `${label}：${['上', '中', '下'][y]}${['左', '中', '右'][x]}`;
      b.setAttribute('aria-label', name);
      b.title = name;
      b.onkeydown = (e) => {
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        e.stopPropagation();
        const target =
          buttons[Math.max(0, Math.min(2, y + dy)) * 3 + Math.max(0, Math.min(2, x + dx))];
        if (!target?.disabled) {
          target?.focus();
          target?.click();
        }
      };
      buttons.push(b);
      root.append(b);
      ctx.update.push(() => {
        b.disabled = !ctx.enabled() || !allowed(x, y);
        b.setAttribute('aria-pressed', String(read() === value));
      });
    }
  return root;
}

/** Spectrum handles local preview/cancel; only its confirmed change enters document history. */
export function color(
  bb: HostRuntime,
  ctx: ControlContext,
  label: string,
  read: () => string | undefined,
  write: (value: string) => void,
) {
  const root = el('div', 'mcui-inspector-color');
  const picker = new bb.ColorPicker({
    id: 'mcui_color_' + bb.guid(),
    name: label,
    label: false,
    private: true,
  });
  const text = el('span', 'mcui-inspector-hint');
  root.append(picker.getNode(), text);
  let opened = false,
    key = '',
    last = '',
    initial: string | undefined,
    shown = '',
    cancelling = false;
  const cancel = () => {
    cancelling = true;
    picker.hide();
    cancelling = false;
  };
  const escape = (event: KeyboardEvent) => {
    if (opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    }
  };
  document.addEventListener('keydown', escape, true);
  const keys = bb.Blockbench.on('press_key', (data: any) => {
    if (opened && !data.input_in_focus && !['Enter', 'Escape', 'Tab'].includes(data.event.key))
      data.capture();
  });
  picker.jq.on('show.spectrum', () => {
    opened = true;
    key = ctx.key();
    initial = read();
    shown = picker.get().toHex8String();
  });
  // Blockbench's Spectrum emits change while typing AND on close. Commit only the final color.
  picker.onChange = () => {};
  picker.jq.on('hide.spectrum', () => {
    if (!opened) return;
    opened = false;
    const next = picker.get().toHex8String();
    try {
      if (!cancelling && ctx.enabled() && key === ctx.key() && read() === initial && next !== shown)
        write(next);
    } catch (error) {
      ctx.report(error);
    }
    last = '';
    refresh();
  });
  const refresh = () => {
    if (opened && (key !== ctx.key() || !ctx.enabled() || read() !== initial)) cancel();
    const value = read();
    text.textContent = value === undefined ? '混合' : value.toUpperCase();
    root.style.pointerEvents = ctx.enabled() ? '' : 'none';
    root.setAttribute('aria-label', label + '：' + text.textContent);
    if (!opened && (last !== value || key !== ctx.key())) {
      picker.set(value ?? '#ffffffff');
      last = value ?? '';
    }
  };
  ctx.update.push(refresh);
  ctx.cleanup.push(() => {
    cancel();
    document.removeEventListener('keydown', escape, true);
    keys.delete();
    picker.delete();
  });
  return root;
}
