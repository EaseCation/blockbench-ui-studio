import { describe, it, expect } from 'vitest';
import { Studio } from '../../src/application/studio';
import type { HostPort, ImagePort, NativeSnapshot } from '../../src/application/ports';
import { clone } from '../../src/domain/document';
import type { UiDocument, ResolvedScene, Pixels } from '../../src/domain/types';
class MemoryHost implements HostPort {
  doc: UiDocument | null = null;
  saves = 0;
  begins = 0;
  cancels = 0;
  commits = 0;
  renders = 0;
  bitmaps: Record<string, Pixels> = {};
  read() {
    return this.doc;
  }
  write(doc: UiDocument) {
    this.doc = clone(doc);
  }
  snapshots() {
    return {} as Record<string, NativeSnapshot>;
  }
  scene(doc: UiDocument) {
    return { nodes: this.snapshots(), roots: doc.roots, selection: [] };
  }
  unmanaged() {
    return [];
  }
  apply(doc: UiDocument, _scene: ResolvedScene, bitmaps: Record<string, Pixels>) {
    for (const id of Object.keys(doc.nodes)) doc.bindings[id] ??= { elementId: id, textureId: id };
    this.renders += Object.keys(bitmaps).length;
    Object.assign(this.bitmaps, bitmaps);
  }
  select() {}
  pixels(id: string) {
    return this.bitmaps[id] ?? null;
  }
  retainPaintLayers() {}
  beginPaint() {}
  message() {}
  begin() {
    this.begins++;
  }
  commit() {
    this.commits++;
  }
  cancel() {
    this.cancels++;
  }
}
function fixture() {
  let id = 0;
  const images: ImagePort = {
    id: () => `id${++id}`,
    encode: (p) => JSON.stringify({ width: p.width, height: p.height, data: Array.from(p.data) }),
    decode: async (png) => {
      const p = JSON.parse(png);
      return { ...p, data: new Uint8ClampedArray(p.data) };
    },
  };
  const host = new MemoryHost();
  return { host, app: Studio.fresh(host, images) };
}
describe('应用事务', () => {
  it('移动或改层级不会重烘焙', () => {
    const { app, host } = fixture(),
      id = app.add('layer');
    const count = host.renders;
    app.update(id, (n) => {
      n.layout.offset.x = 10;
    });
    expect(host.renders).toBe(count);
  });
  it('一次拖拽只提交一条 Undo', () => {
    const { app, host } = fixture(),
      id = app.add('layer');
    const count = host.commits;
    app.beginGesture('move');
    for (let i = 0; i < 8; i++)
      app.previewGesture((d) => {
        d.nodes[id]!.layout.offset.x = i;
      });
    app.endGesture(true);
    expect(host.commits - count).toBe(1);
  });
  it('非法布局在事务之前被拒绝', () => {
    const { app, host } = fixture(),
      p = app.add('frame'),
      id = app.add('layer', p);
    const count = host.begins;
    app.execute('invalid', (d) => {
      d.nodes[p]!.layout.width = { kind: 'hug' };
      d.nodes[id]!.layout.width = { kind: 'fill' };
    });
    expect(host.begins).toBe(count);
    expect(app.state.error).toMatch(/循环/);
  });
  it('缩放扩展源图原点、移动不改变源图原点', () => {
    const { app } = fixture(),
      id = app.add('layer');
    app.execute('left', (d) => {
      app.changeRects(d, { [id]: { x: 4, y: 8, width: 36, height: 32 } });
    });
    expect(app.state.doc.nodes[id]!.content).toMatchObject({ origin: { x: -4, y: 0 } });
    app.execute('move', (d) =>
      app.changeRects(d, { [id]: { x: 14, y: 8, width: 36, height: 32 } }),
    );
    expect(app.state.doc.nodes[id]!.content).toMatchObject({ origin: { x: -4, y: 0 } });
  });
  it('复制拥有独立节点并可共享只读源图', () => {
    const { app } = fixture(),
      id = app.add('layer');
    app.select([id]);
    app.duplicate();
    const copy = app.state.doc.nodes[app.state.selection[0]!]!;
    expect(copy.id).not.toBe(id);
    expect(copy.content?.source).toBe(app.state.doc.nodes[id]!.content?.source);
  });
});

describe('宿主事务桥', () => {
  it('加入当前事务不会嵌套开启或提交 Undo', () => {
    const { app, host } = fixture(),
      id = app.add('layer');
    const begins = host.begins,
      commits = host.commits;
    expect(
      app.executeWithinHostEdit('native', (doc) => {
        doc.nodes[id]!.layout.width = { kind: 'fixed', value: 64 };
      }),
    ).toBe(true);
    expect(app.state.doc.nodes[id]!.rect.width).toBe(64);
    expect(host.begins).toBe(begins);
    expect(host.commits).toBe(commits);
  });
  it('非法宿主属性取消当前编辑并保留旧数据', () => {
    const { app, host } = fixture(),
      id = app.add('layer');
    expect(
      app.executeWithinHostEdit('invalid', (doc) => {
        doc.nodes[id]!.layout.width = { kind: 'expression', percent: 1, pixels: 0 };
      }),
    ).toBe(false);
    expect(app.state.doc.nodes[id]!.rect.width).toBe(32);
    expect(host.cancels).toBe(1);
  });
});

describe('百分比位置拖动', () => {
  it('拖动保留百分比，只修改像素分量', () => {
    const { app } = fixture(),
      p = app.add('frame'),
      id = app.add('layer', p);
    app.update(id, (n) => {
      n.layout.offsetPercent = { x: 0.5, y: 0 };
      n.layout.offset.x = -8;
    });
    const rect = app.state.doc.nodes[id]!.rect;
    app.execute('move', (d) => app.changeRects(d, { [id]: { ...rect, x: rect.x + 10 } }));
    expect(app.state.doc.nodes[id]!.layout.offsetPercent!.x).toBe(0.5);
    expect(app.state.doc.nodes[id]!.layout.offset.x).toBe(2);
  });
});
