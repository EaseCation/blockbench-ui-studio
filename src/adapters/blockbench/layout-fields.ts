import { Disposables, type HostRuntime } from './runtime';

/** Small registered native FormElements; layout decisions remain in PropertyBridge/application. */
export function registerLayoutFields(bb: HostRuntime, selectionKey: () => string) {
  const life = new Disposables();
  const style = document.createElement('style');
  style.textContent = `
    .mcui-matrix-wrap{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .mcui-matrix{display:grid;grid-template-columns:repeat(3,28px);gap:3px;padding:5px;border:1px solid var(--color-border);border-radius:5px;background:var(--color-back)}
    .mcui-matrix button{min-width:0!important;margin:0;display:flex;align-items:center;justify-content:center;width:28px;height:25px;padding:3px;border-radius:3px;background:transparent;color:var(--color-subtle_text);border:1px solid transparent}
    .mcui-matrix button:hover,.mcui-matrix button:focus-visible{border-color:var(--color-accent)}
    .mcui-matrix button[aria-pressed=true]{background:var(--color-accent);color:var(--color-accent_text)}
    .mcui-matrix .mcui-bars{display:flex;gap:2px;align-items:center}
    .mcui-matrix .mcui-bars i{display:block;background:currentColor;width:3px;height:11px}
    .mcui-matrix[data-direction=column] .mcui-bars{flex-direction:column}
    .mcui-matrix[data-direction=column] .mcui-bars i{width:11px;height:3px}
    .mcui-distribute{min-width:0!important;max-width:85px;white-space:normal;padding:5px}
    .mcui-distribute[aria-pressed=true]{background:var(--color-accent);color:var(--color-accent_text)}
    .mcui-padding{display:grid;grid-template-columns:48px 48px 48px;grid-template-rows:28px 32px 28px;gap:3px;padding:5px;border:1px solid var(--color-border);border-radius:5px;position:relative}
    .mcui-padding input{width:48px!important;min-width:0;text-align:center;margin:0}
    .mcui-padding button{padding:0;font-size:12px;min-width:0!important;width:48px;margin:0}
    .mcui-padding button[aria-pressed=true]{color:var(--color-accent)}
    .mcui-padding [aria-invalid=true]{outline:1px solid #ee6677}
    #panel_mcui_layout .form_inline_select{display:flex;flex-wrap:nowrap}
    #panel_mcui_layout .form_inline_select li{min-width:0;flex:1;padding:4px 3px;white-space:nowrap;font-size:12px}
    #panel_mcui_layout [data-mcui-unavailable]{opacity:.35;cursor:not-allowed}
    .mcui-mixed{font-size:11px;color:var(--color-subtle_text)}
  `;
  document.head.append(style);
  life.add(() => style.remove());
  const Base = bb.FormElement;
  class Matrix extends Base {
    value: any = '0,0';
    grid!: HTMLElement;
    buttons: HTMLButtonElement[] = [];
    spread?: HTMLButtonElement;
    build(bar: HTMLElement) {
      super.build(bar);
      const wrap = document.createElement('div');
      wrap.className = 'mcui-matrix-wrap';
      this.grid = document.createElement('div');
      this.grid.className = 'mcui-matrix';
      this.grid.setAttribute('role', 'group');
      this.grid.setAttribute('aria-label', this.options.label);
      wrap.append(this.grid);
      bar.append(wrap);
      const alignment = this.options.type === 'mcui_alignment';
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++) {
          const button = document.createElement('button');
          button.type = 'button';
          const label = `${this.options.label}：${['上', '中', '下'][y]}${['左', '中', '右'][x]}`;
          button.title = label;
          button.setAttribute('aria-label', label);
          if (alignment) {
            const bars = document.createElement('span');
            bars.className = 'mcui-bars';
            for (let i = 0; i < 3; i++) bars.append(document.createElement('i'));
            button.append(bars);
            button.style.justifyContent = ['flex-start', 'center', 'flex-end'][x]!;
            button.style.alignItems = ['flex-start', 'center', 'flex-end'][y]!;
          } else button.textContent = '•';
          button.onclick = () => {
            this.setValue(alignment ? [x, y, this.value[2], this.value[3]] : `${x / 2},${y / 2}`);
            this.change();
          };
          button.onkeydown = (e) => {
            const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
            if (!dx && !dy) return;
            e.preventDefault();
            e.stopPropagation();
            const target =
              this.buttons[Math.max(0, Math.min(2, y + dy)) * 3 + Math.max(0, Math.min(2, x + dx))];
            target?.focus();
            target?.click();
          };
          this.buttons.push(button);
          this.grid.append(button);
        }
      if (alignment) {
        this.spread = document.createElement('button');
        this.spread.type = 'button';
        this.spread.textContent = '两端分布';
        this.spread.className = 'mcui-distribute';
        this.spread.title = '将剩余空间分配到子项之间；间距为最小间距。再次点击恢复九点对齐。';
        this.spread.setAttribute('aria-label', '两端分布');
        this.spread.onclick = () => {
          this.setValue([this.value[0], this.value[1], !this.value[2], this.value[3]]);
          this.change();
        };
        wrap.append(this.spread);
      }
    }
    getDefault() {
      return this.options.type === 'mcui_alignment' ? [0, 0, false, 'row'] : '0,0';
    }
    getValue() {
      return Array.isArray(this.value) ? [...this.value] : this.value;
    }
    setValue(value: any) {
      this.value = value ?? this.getDefault();
      const alignment = this.options.type === 'mcui_alignment';
      const [x, y] = alignment
        ? this.value
        : String(this.value)
            .split(',')
            .map((v: string) => Number(v) * 2);
      this.grid?.setAttribute('data-direction', alignment ? this.value[3] : 'anchor');
      this.buttons.forEach((b, i) => {
        const selected =
          alignment && this.value[2]
            ? this.value[3] === 'row'
              ? Math.floor(i / 3) === y
              : i % 3 === x
            : i % 3 === x && Math.floor(i / 3) === y;
        b.setAttribute('aria-pressed', String(selected));
      });
      if (this.spread) {
        this.spread.setAttribute('aria-pressed', String(!!this.value[2]));
        this.spread.textContent = '两端分布';
      }
    }
  }
  class Padding extends Base {
    value = [0, 0, 0, 0];
    changedSide?: number;
    inputs: HTMLInputElement[] = [];
    linked = true;
    key = '';
    dirty = -1;
    link!: HTMLButtonElement;
    build(bar: HTMLElement) {
      super.build(bar);
      const wrap = document.createElement('div');
      wrap.className = 'mcui-padding';
      bar.append(wrap);
      const positions = [
        [2, 1],
        [3, 2],
        [2, 3],
        [1, 2],
      ];
      for (let i = 0; i < 4; i++) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.className = 'focusable_input';
        input.style.gridColumn = String(positions[i]![0]);
        input.style.gridRow = String(positions[i]![1]);
        input.setAttribute('aria-label', ['上内边距', '右内边距', '下内边距', '左内边距'][i]!);
        input.title = `${input.getAttribute('aria-label')}（px）`;
        input.onfocus = () => {
          this.key = selectionKey();
        };
        input.oninput = () => {
          this.dirty = i;
          input.removeAttribute('aria-invalid');
        };
        const commit = () => {
          if (this.dirty !== i) return;
          if (this.key !== selectionKey()) {
            this.dirty = -1;
            this.setValue(this.value);
            return;
          }
          const n = Number(input.value);
          if (input.value.trim() === '' || !Number.isSafeInteger(n) || n < 0) {
            input.setAttribute('aria-invalid', 'true');
            return;
          }
          const next = this.linked ? [n, n, n, n] : this.value.map((v, j) => (j === i ? n : v));
          this.dirty = -1;
          this.value = next;
          this.changedSide = this.linked ? undefined : i;
          this.inputs.forEach((el, j) => {
            el.value = String(next[j]);
          });
          this.change();
        };
        input.onchange = commit;
        input.onblur = commit;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.dirty = -1;
            this.setValue(this.value);
          }
        };
        this.inputs.push(input);
        wrap.append(input);
      }
      this.link = document.createElement('button');
      this.link.type = 'button';
      this.link.style.gridArea = '2 / 2';
      this.link.setAttribute('aria-label', '联动四边内边距');
      this.link.title = '切换四边联动；启用后下一次输入统一四边，不立即覆盖现有数值。';
      this.link.onclick = () => {
        this.linked = !this.linked;
        this.updateLink();
      };
      wrap.append(this.link);
      this.updateLink();
    }
    updateLink() {
      this.link.textContent = this.linked ? '联动' : '独立';
      this.link.setAttribute('aria-pressed', String(this.linked));
    }
    getDefault() {
      return [0, 0, 0, 0];
    }
    getValue() {
      return Object.assign([...this.value], { changedSide: this.changedSide });
    }
    setValue(value: number[]) {
      const key = selectionKey();
      if (this.dirty >= 0 && this.key === key) return;
      if (this.key !== key) {
        this.key = key;
        this.linked = !!value?.every((v) => v === value[0]);
        this.updateLink();
      }
      this.dirty = -1;
      this.changedSide = undefined;
      this.value = Array.isArray(value) ? [...value] : [0, 0, 0, 0];
      this.inputs.forEach((el, i) => {
        el.value = String(this.value[i]);
        el.removeAttribute('aria-invalid');
      });
    }
  }
  for (const [name, type] of [
    ['mcui_anchor', Matrix],
    ['mcui_alignment', Matrix],
    ['mcui_padding', Padding],
  ] as const) {
    const previous = bb.FormElement.types[name];
    bb.FormElement.registerType(name, type);
    life.add(() => {
      if (previous) bb.FormElement.types[name] = previous;
      else delete bb.FormElement.types[name];
    });
  }
  return life;
}
