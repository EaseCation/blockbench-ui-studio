import { BindingIndex } from './binding-index';
import { fields as all, type Field } from './property-fields';
import { InspectorPanels } from './inspector-panels';
import { stepExpression } from '../../domain/expression';
import { inputStep } from './input-step';
import { bindScrub, scrubLabel, cancelScrubs } from './input-scrub';
import type { Studio } from '../../application/studio';
import type { Id, UiDocument, UiNode } from '../../domain/types';
import { topSelection } from '../../domain/document';
import { FIELD_PREFIX, ROLE_MARKER, SOURCE_MARKER } from './native-fields';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

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
  private bindings = new BindingIndex();

  private panels: HostObject[] = [];
  private inspector: InspectorPanels;
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
    for (const event of ['unselect_project', 'unselect_mode'])
      this.life.add(bb.Blockbench.on(event, cancelScrubs));
    this.life.add(cancelScrubs);
    this.registerDraft();
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
    this.inspector = new InspectorPanels(bb, current, () => this.targets());
    this.panels = this.inspector.panels;
    this.life.add(() => this.inspector.dispose());
  }
  showLayout() {
    this.inspector.showLayout();
  }
  targets(): UiNode[] {
    const app = this.current();
    if (!app) return [];
    const lookup = this.bindings.get(app.state.doc);
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
      // Undo constructs temporary Groups with a UUID but without hydrated markers.
      // Resolve those through a document-scoped index as well as live objects.
      const id = this.bindings.get(app.state.doc).get(node.uuid);
      const n =
        id && app.state.doc.bindings[id]?.containerId === node.uuid
          ? app.state.doc.nodes[id]
          : undefined;
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
    const selectionInfo = `已选择 ${this.targets().length} 个对象；显示首个值，修改统一应用`;
    const objects = new Map<string, HostObject>(
      [...(this.bb.Project?.elements ?? []), ...(this.bb.Project?.groups ?? [])].map(
        (e: HostObject) => [e.uuid, e],
      ),
    );
    for (const [id, binding] of Object.entries(doc.bindings)) {
      const object = objects.get(binding.containerId);
      const node = doc.nodes[id];
      if (!object || !node) continue;
      object[SOURCE_MARKER] = id;
      object[ROLE_MARKER] = 'container';
      const surface = objects.get(binding.surfaceId ?? '');
      if (surface) {
        surface[SOURCE_MARKER] = id;
        surface[ROLE_MARKER] = 'content';
      }
      for (const f of all) object[FIELD_PREFIX + f.id] = f.read(node) ?? '';
      object[FIELD_PREFIX + 'selection_info'] = selectionInfo;
    }
  }
  refresh(autoSelect = true) {
    if (this.refreshing || this.disposed) return;
    const app = this.current();
    if (!app) {
      this.inspector.refresh();
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
      this.inspector.refresh();
      const tabsKey = targets.map((n) => `${n.id}:${n.kind}:${n.content?.kind ?? ''}`).join('|');
      const tabsChanged = tabsKey !== this.tabsKey;
      if (tabsChanged) {
        this.tabsKey = tabsKey;
        (panel.getHostPanel?.() ?? panel).update();
      }
      if (autoSelect && key && key !== this.selectionKey && this.bb.Modes.edit)
        this.inspector.selectPreferredTab();
      // Tab availability can reattach native panel nodes; finish the entire docking pass.
      if (tabsChanged) this.bb.updateInterfacePanels();
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
      scrubCleanup: (() => void)[] = [];
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
          const kind = axis === 'w' || axis === 'h' ? 'size' : 'offset';
          const field = all.find((f) => this.id.endsWith('__' + FIELD_PREFIX + f.id))!;
          this.scrubCleanup.push(
            bindScrub(input, {
              key: () => bridge.current()?.state.doc.id + ':' + this.key(),
              enabled: () =>
                !!bridge.current() && !bridge.current()?.state.busy && !!bridge.bb.Modes.edit,
              step: (value, delta) => stepExpression(value, delta, kind),
              report: (error) =>
                bridge.bb.Blockbench.showQuickMessage(
                  String(error instanceof Error ? error.message : error),
                  4000,
                ),
              refresh: () => bridge.refresh(false),
              begin: () => {
                const app = bridge.current()!,
                  ids = bridge.targets().map((n) => n.id),
                  index = this.inputs.indexOf(input);
                this.dirty = false;
                app.beginGesture('拖动调整 UI 数值');
                return {
                  preview: (value) =>
                    app.previewGesture((doc) => {
                      const values: any = [0, 0];
                      values[index] = value;
                      values.changedAxis = index;
                      for (const id of ids) field.write!(doc.nodes[id]!, values, doc);
                    }) === true,
                  finish: (commit) => {
                    app.endGesture(commit);
                    bridge.refresh(false);
                  },
                };
              },
            }),
          );
          scrubLabel(input, label);
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
            const delta = inputStep(e);
            if (delta !== null) {
              if (input.disabled || input.readOnly) return;
              if (this.selection !== this.key()) {
                this.dirty = false;
                this.setValue(this.committed);
                return;
              }
              try {
                const kind = axis === 'w' || axis === 'h' ? 'size' : 'offset';
                const next = stepExpression(input.value, delta, kind);
                if (next === input.value) return;
                input.value = next;
                this.dirty = true;
                this.commit(this.inputs.indexOf(input));
              } catch (error) {
                input.setAttribute('aria-invalid', 'true');
                bridge.bb.Blockbench.showQuickMessage(
                  String(error instanceof Error ? error.message : error),
                  4000,
                );
              }
              return;
            }
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
      commit(axis?: number) {
        if (!this.dirty) return;
        if (this.selection !== this.key()) {
          this.dirty = false;
          this.setValue(this.committed);
          return;
        }
        const values = this.inputs.map((input, i) =>
          axis === undefined || axis === i ? input.value : this.committed[i]!,
        ) as string[] & { changedAxis?: number };
        const changed = values
          .map((v, i) => (v !== this.committed[i] ? i : -1))
          .filter((i) => i >= 0);
        values.changedAxis = axis ?? (changed.length === 1 ? changed[0] : undefined);
        try {
          bridge.validate(this.id, values);
          this.changedAxis = values.changedAxis;
          this.committed = values;
          this.dirty = false;
          const app = bridge.current()!;
          const field = all.find((f) => this.id.endsWith('__' + FIELD_PREFIX + f.id))!;
          const ids = bridge.targets().map((n) => n.id);
          app.execute(field.label, (doc) => {
            for (const id of ids) field.write!(doc.nodes[id]!, values, doc);
          });
          bridge.refresh(false);
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
      delete() {
        for (const dispose of this.scrubCleanup) dispose();
        super.delete();
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
