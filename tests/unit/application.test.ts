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
  selection() {
    return [];
  }
  unmanaged() {
    return [];
  }
  apply(doc: UiDocument, _scene: ResolvedScene, bitmaps: Record<string, Pixels>) {
    for (const id of Object.keys(doc.nodes))
      doc.bindings[id] ??= { containerId: id, textureId: id };
    this.renders += Object.keys(bitmaps).length;
    Object.assign(this.bitmaps, bitmaps);
  }
  select() {}
  previewMove() {}
  clearPreview() {}
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
      id = app.add('image');
    const count = host.renders;
    app.update(id, (n) => {
      n.layout.offset.x = 10;
    });
    expect(host.renders).toBe(count);
  });
  it('一次拖拽只提交一条 Undo', () => {
    const { app, host } = fixture(),
      id = app.add('image');
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
      id = app.add('image', p);
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
      id = app.add('image');
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
      id = app.add('image');
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
      id = app.add('image');
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
      id = app.add('image');
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
      id = app.add('image', p);
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

describe('独立纹理分辨率与外观', () => {
  it('等比手势保持像素与渲染缓存，改回跟随才重采样', () => {
    const { app, host } = fixture(),
      id = app.add('image');
    app.select([id]);
    const before = host.bitmaps[id],
      count = host.renders;
    const original = { ...app.state.doc.nodes[id]!.rect };
    app.beginGesture('缩放');
    app.transformSelection(original, { ...original, width: 16, height: 16 }, true);
    app.endGesture(true);
    expect(app.state.doc.nodes[id]!.rect.width).toBe(16);
    expect(host.renders).toBe(count);
    expect(host.bitmaps[id]).toBe(before);
    app.update(id, (n) => {
      delete n.rasterSize;
    });
    expect(host.bitmaps[id]!.width).toBe(16);
  });
  it('栅格化保留填充描边且不重复叠加，后续缩放保持分辨率', () => {
    const { app, host } = fixture(),
      id = app.add('image');
    app.update(id, (n) => {
      n.opacity = 0.5;
      n.appearance = {
        fill: 'solid',
        color: '#ff0000ff',
        endColor: '#000000ff',
        angle: 0,
        strokeColor: '#00ff00ff',
        strokeWidth: 2,
      };
    });
    const data = Array.from(host.bitmaps[id]!.data);
    app.flatten(id);
    expect(app.state.doc.nodes[id]!.appearance).toBeUndefined();
    expect(Array.from(host.bitmaps[id]!.data)).toEqual(data);
    app.update(id, (n) => {
      n.layout.width = { kind: 'fixed', value: 8 };
    });
    expect(host.bitmaps[id]!.width).toBe(32);
  });
});

describe('快捷自动布局', () => {
  it('包装同父级选区，推断横向和间距，固定子项尺寸且只提交一次', () => {
    const { app, host } = fixture();
    const a = app.add('image'),
      b = app.add('image');
    app.update(a, (n) => {
      n.layout.offset = { x: 10, y: 20 };
    });
    app.update(b, (n) => {
      n.layout.offset = { x: 50, y: 20 };
    });
    const parent = app.state.doc.nodes[a]!.parent;
    app.select([b, a]);
    const commits = host.commits,
      renders = host.renders;
    const id = app.wrapAutoLayout()!;
    const frame = app.state.doc.nodes[id]!;
    expect(frame.parent).toBe(parent);
    expect(frame.frame!.direction).toBe('row');
    expect(frame.frame!.gap).toBe(8);
    expect(frame.children).toEqual([a, b]);
    expect(frame.rect).toMatchObject({ x: 10, y: 20, width: 72, height: 32 });
    expect(app.state.doc.nodes[a]!.layout.width).toEqual({ kind: 'fixed', value: 32 });
    expect(host.commits - commits).toBe(1);
    expect(host.renders).toBe(renders);
    expect(app.state.selection).toEqual([id]);
  });
  it('跨父级或锁定选区拒绝包装，不产生部分修改', () => {
    const { app, host } = fixture();
    const a = app.add('image'),
      frame = app.add('frame'),
      b = app.add('image', frame);
    app.select([a, b]);
    const doc = JSON.stringify(app.state.doc),
      commits = host.commits;
    expect(app.wrapAutoLayout()).toBeNull();
    expect(JSON.stringify(app.state.doc)).toBe(doc);
    expect(host.commits).toBe(commits);
    app.update(a, (n) => {
      n.locked = true;
    });
    app.select([a]);
    expect(app.wrapAutoLayout()).toBeNull();
  });
});

describe('v0.5 移动事务', () => {
  it('移动预览不写文档、不重烘焙、不创建 Undo，松手原子换父级', () => {
    const { app, host } = fixture(),
      a = app.add('image'),
      b = app.add('image');
    app.select([b]);
    const doc = JSON.stringify(app.state.doc),
      saved = JSON.stringify(host.doc),
      begins = host.begins,
      renders = host.renders,
      commits = host.commits;
    app.beginGesture('移动', true);
    app.previewMove(16, 24);
    app.previewMove(20, 30);
    expect(JSON.stringify(app.state.doc)).toBe(doc);
    expect(JSON.stringify(host.doc)).toBe(saved);
    expect(host.begins).toBe(begins);
    expect(host.renders).toBe(renders);
    app.finishMove(20, 30, { parentId: a });
    expect(app.state.doc.nodes[b]!.parent).toBe(a);
    expect(host.begins).toBe(begins + 1);
    expect(host.commits).toBe(commits + 1);
    expect(host.renders).toBe(renders);
  });
  it('非法循环放入回滚整次操作，保留所有层级和位置', () => {
    const { app, host } = fixture(),
      a = app.add('image'),
      b = app.add('image', a);
    app.select([a]);
    const before = JSON.stringify(app.state.doc),
      commits = host.commits;
    app.beginGesture('移动', true);
    app.previewMove(100, 100);
    app.finishMove(100, 100, { parentId: b });
    expect(JSON.stringify(app.state.doc)).toBe(before);
    expect(host.commits).toBe(commits);
    expect(app.state.error).toContain('后代');
  });
});

it('取消纯显示预览后继续移动不会使贴图缓存失效', () => {
  const { app, host } = fixture(),
    id = app.add('image');
  app.select([id]);
  const renders = host.renders;
  app.beginGesture('移动', true);
  app.previewMove(30, 40);
  app.endGesture(false);
  app.beginGesture('移动', true);
  app.previewMove(10, 10);
  app.finishMove(10, 10, null);
  expect(host.renders).toBe(renders);
  expect(app.state.doc.nodes[id]!.rect.x).toBe(18);
});

it('拖绘创建按目标尺寸分配透明贴图，所有对象只占一次事务', () => {
  const { app, host } = fixture(),
    parent = app.add('image'),
    commits = host.commits;
  const id = app.createDrawn({
    kind: 'image',
    rect: { x: 20, y: 22, width: 45, height: 27 },
    target: { parentId: parent },
  })!;
  expect(app.state.doc.nodes[id]!.parent).toBe(parent);
  expect(app.state.doc.nodes[id]!.rect).toEqual({ x: 20, y: 22, width: 45, height: 27 });
  expect([host.bitmaps[id]!.width, host.bitmaps[id]!.height]).toEqual([45, 27]);
  expect(host.bitmaps[id]!.data.every((n) => n === 0)).toBe(true);
  expect(host.commits).toBe(commits + 1);
  const old = JSON.stringify(app.state.doc);
  expect(
    app.createDrawn({
      kind: 'image',
      rect: { x: 0, y: 0, width: 100000, height: 100000 },
      target: null,
    }),
  ).toBeNull();
  expect(JSON.stringify(app.state.doc)).toBe(old);
});

describe('内容提供者事务', () => {
  it('重新渲染不改写复制图层共享的旧源，移动不重新生成文字', async () => {
    const { contentProviders } = await import('../../src/application/content');
    let renders = 0;
    contentProviders.set('text', {
      id: 'text',
      title: 'Text',
      icon: 'text_fields',
      prepare: async () => {},
      ready: () => true,
      key: (data) => String(data.text),
      measure: () => ({ width: 20, height: 10 }),
      render: (data) => {
        renders++;
        return {
          width: 1,
          height: 1,
          data: new Uint8ClampedArray([String(data.text).length, 0, 0, 255]),
        };
      },
      edit: () => {},
    });
    try {
      const { app, host } = fixture();
      const id = app.createContent('text', { text: 'one', sizing: 'auto' })!;
      const source = app.state.doc.nodes[id]!.content!.source;
      app.update(id, (n) => {
        n.layout.offset.x += 3;
      });
      expect(renders).toBe(1);
      app.duplicate();
      const copy = app.state.selection[0]!;
      app.execute('text', (doc) =>
        app.editContentNode(doc.nodes[copy]!, { text: 'longer', sizing: 'auto' }),
      );
      expect(app.state.doc.nodes[id]!.content!.source).toBe(source);
      expect(app.state.doc.nodes[copy]!.content!.source).not.toBe(source);
      expect(host.bitmaps[id]!.data[0]).toBe(3);
      expect(host.bitmaps[copy]!.data[0]).toBe(6);
    } finally {
      contentProviders.delete('text');
    }
  });
});
