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
    app.update(p, (n) => {
      n.layout.width = { kind: 'fixed', value: 160 };
      n.layout.height = { kind: 'fixed', value: 90 };
    });
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

it('编组事务提交失败时恢复逻辑文档和原选区', () => {
  const { app, host } = fixture();
  const a = app.add('image'),
    b = app.add('image');
  app.select([a, b]);
  const before = clone(app.state.doc),
    selection = [...app.state.selection];
  host.commit = () => {
    throw new Error('commit failed');
  };
  expect(app.groupSelection()).toBeNull();
  expect(app.state.doc).toEqual(before);
  expect(app.state.selection).toEqual(selection);
  expect(app.state.error).toBe('commit failed');
  expect(host.cancels).toBe(1);
});

it('旋转多选绕共同中心，不重烘焙，单次Undo；取消恢复角度', () => {
  const { app, host } = fixture(),
    a = app.add('image', null),
    b = app.add('image', null);
  app.update(b, (n) => {
    n.layout.offset.x = 80;
  });
  app.select([a, b]);
  const before = JSON.stringify(app.state.doc),
    renders = host.renders,
    commits = host.commits;
  const r = app.getSelectionBounds()!,
    pivot = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  app.beginGesture('rotate');
  app.rotateSelection(30, pivot);
  app.rotateSelection(90, pivot);
  app.endGesture(true);
  expect(app.state.doc.nodes[a]!.rotation).toBe(90);
  expect(app.state.doc.nodes[b]!.rotation).toBe(90);
  expect(app.state.doc.nodes[a]!.rect.x).toBeCloseTo(app.state.doc.nodes[b]!.rect.x, 6);
  expect(host.renders).toBe(renders);
  expect(host.commits).toBe(commits + 1);
  const rotated = JSON.stringify(app.state.doc);
  app.beginGesture('rotate');
  app.rotateSelection(-15, pivot);
  app.endGesture(false);
  expect(JSON.stringify(app.state.doc)).toBe(rotated);
});

it('旋转绘画图层沿本地右边扩展时，不移动原像素的画布原点', () => {
  const { app } = fixture(),
    id = app.add('image', null);
  app.update(id, (n) => {
    n.rotation = 90;
  });
  app.select([id]);
  const original = app.getSelectionBox()!.rect,
    content = app.state.doc.nodes[id]!.content;
  expect(content?.kind).toBe('paint');
  if (content?.kind !== 'paint') throw new Error('paint fixture');
  const origin = { ...content.origin };
  app.beginGesture('resize rotated paint');
  app.transformSelection(original, {
    ...original,
    x: original.x - 5,
    y: original.y - 5,
    width: original.width + 10,
  });
  app.endGesture(true);
  const updated = app.state.doc.nodes[id]!.content;
  if (updated?.kind !== 'paint') throw new Error('paint fixture');
  expect(updated.origin).toEqual(origin);
});
it('多个Stack流式子项保持布局约束，单个子项或整Frame仍可拖转', () => {
  const { app } = fixture(),
    frame = app.add('frame', null),
    a = app.add('image', frame),
    b = app.add('image', frame);
  app.update(frame, (n) => {
    n.frame!.direction = 'row';
    n.frame!.engineType = 'stack_panel';
  });
  app.select([a, b]);
  expect(app.rotationGestureAllowed()).toBe(false);
  app.select([a]);
  expect(app.rotationGestureAllowed()).toBe(true);
  app.select([frame]);
  expect(app.rotationGestureAllowed()).toBe(true);
});

it('精确居中允许半像素位置，移动预览不写文档，子元素跟随且不重烘焙', () => {
  const { app, host } = fixture(),
    root = app.add('frame', null),
    child = app.add('image', root),
    inside = app.add('image', child);
  app.update(child, (n) => {
    n.layout.width = { kind: 'fixed', value: 31 };
  });
  const before = JSON.stringify(app.state.doc),
    x = app.state.doc.nodes[child]!.rect.x,
    otherX = app.state.doc.nodes[inside]!.rect.x;
  const renders = host.renders,
    commits = host.commits;
  app.select([child]);
  app.beginGesture('snap', true);
  app.previewMove(0.5, 0, true);
  expect(JSON.stringify(app.state.doc)).toBe(before);
  app.finishMove(0.5, 0, null, true);
  expect(app.state.doc.nodes[child]!.rect.x).toBe(x + 0.5);
  expect(app.state.doc.nodes[inside]!.rect.x).toBe(otherX + 0.5);
  expect(host.renders).toBe(renders);
  expect(host.commits).toBe(commits + 1);
});

it('居中锚点与百分比抵消偏移时，精确吸附仍保留半像素位置', () => {
  const { app } = fixture(),
    root = app.add('frame', null),
    id = app.add('image', root);
  app.update(root, (n) => {
    n.layout.width = { kind: 'fixed', value: 100 };
  });
  app.update(id, (n) => {
    n.layout.width = { kind: 'fixed', value: 31 };
    n.layout.anchorFrom = [0.5, 0];
    n.layout.anchorTo = [0.5, 0];
    n.layout.offset = { x: 0, y: 10 };
  });
  const dx = 34.5 - app.state.doc.nodes[id]!.rect.x;
  app.select([id]);
  app.beginGesture('center', true);
  app.finishMove(dx, 0, null, true);
  expect(app.state.doc.nodes[id]!.rect.x).toBe(34.5);
});

it('普通移动保留default与受约束的相对尺寸公式，不重写像素项', () => {
  const { app } = fixture(),
    root = app.add('frame', null),
    a = app.add('image', root),
    b = app.add('image', root);
  app.update(root, (n) => {
    n.layout.width = { kind: 'fixed', value: 160 };
    n.layout.height = { kind: 'fixed', value: 90 };
  });
  app.update(b, (n) => {
    n.layout.width = { kind: 'fixed', value: 80 };
  });
  app.update(a, (n) => {
    n.layout.width = { kind: 'expression', unit: '%sm', percent: 1, pixels: 8 };
    n.layout.maxWidth = 60;
    n.layout.height = { kind: 'default' };
  });
  const before = JSON.stringify([
    app.state.doc.nodes[a]!.layout.width,
    app.state.doc.nodes[a]!.layout.height,
  ]);
  app.select([a]);
  app.beginGesture('move', true);
  app.finishMove(10, 12, null);
  expect(
    JSON.stringify([app.state.doc.nodes[a]!.layout.width, app.state.doc.nodes[a]!.layout.height]),
  ).toBe(before);
  app.update(a, (n) => {
    delete n.layout.maxWidth;
  });
  expect(app.state.doc.nodes[a]!.rect.width).toBe(88);
});

it('图片粘贴保留所选Image及子项、外观和几何，多张显式新建属于同一次事务', async () => {
  const { app, host } = fixture(),
    parent = app.add('image'),
    child = app.add('image', parent);
  app.update(parent, (n) => {
    n.opacity = 0.5;
    n.appearance = {
      fill: 'solid',
      color: '#ff0000ff',
      endColor: '#ffffffff',
      angle: 0,
      strokeWidth: 2,
      strokeColor: '#ffffffff',
    };
  });
  app.select([parent]);
  const before = clone(app.state.doc),
    count = host.commits;
  const pixels = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(255) };
  expect(app.pasteImages([{ name: 'external', pixels }])).toBe(true);
  expect(Object.keys(app.state.doc.nodes)).toEqual(Object.keys(before.nodes));
  expect(app.state.doc.nodes[parent]!.children).toEqual([child]);
  expect(app.state.doc.nodes[parent]!.layout).toEqual(before.nodes[parent]!.layout);
  expect(app.state.doc.nodes[parent]!.appearance).toEqual(before.nodes[parent]!.appearance);
  expect(app.state.doc.nodes[parent]!.opacity).toBe(0.5);
  expect(host.commits).toBe(count + 1);
  expect(
    app.pasteImages([
      { name: 'a', pixels },
      { name: 'b', pixels },
    ]),
  ).toBe(true);
  expect(app.state.doc.nodes[parent]!.children).toHaveLength(3);
  expect(host.commits).toBe(count + 2);
});
it('样式快照独立、批量复制图片填充不改变层级和显示边界，像素源分别独立', async () => {
  const { copyStyle } = await import('../../src/application/clipboard');
  const { app, host } = fixture(),
    source = app.add('image'),
    one = app.add('image'),
    two = app.add('image');
  app.update(source, (n) => {
    n.opacity = 0.4;
    n.appearance = {
      fill: 'linear',
      color: '#ff0000ff',
      endColor: '#0000ffff',
      angle: 90,
      strokeWidth: 2,
      strokeColor: '#ffffffff',
    };
  });
  app.update(one, (n) => {
    n.layout.width = { kind: 'hug' };
    n.layout.height = { kind: 'fixed', value: 20 };
  });
  app.update(two, (n) => {
    n.layout.offset.x = 100;
    n.layout.width = { kind: 'fixed', value: 60 };
  });
  const properties = copyStyle(app.state.doc, source),
    before = clone(app.state.doc),
    pixels = await app.images.decode(properties.fill!.png),
    count = host.commits;
  app.update(source, (n) => (n.opacity = 0.8));
  expect(app.pasteProperties(properties, pixels, [one, two])).toBe(true);
  for (const id of [one, two]) {
    const n = app.state.doc.nodes[id]!;
    expect(n.rect).toEqual(before.nodes[id]!.rect);
    expect(n.opacity).toBe(0.4);
    expect(n.name).toBe(before.nodes[id]!.name);
    expect(n.parent).toBe(before.nodes[id]!.parent);
  }
  expect(app.state.doc.nodes[one]!.content!.source).not.toBe(
    app.state.doc.nodes[two]!.content!.source,
  );
  expect(host.commits).toBe(count + 2);
});
it('异步图片解码期间改变选区会取消粘贴，不会填入另一Image', async () => {
  const { app, host } = fixture(),
    a = app.add('image'),
    b = app.add('image');
  let resolve!: (p: Pixels) => void;
  app.images.decode = () => new Promise((r) => (resolve = r));
  app.select([a]);
  const before = clone(app.state.doc),
    count = host.commits;
  const pending = app.paste({ name: 'late', png: 'pending', width: 1, height: 1 });
  app.select([b]);
  resolve({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) });
  await pending;
  expect(app.state.doc).toEqual(before);
  expect(host.commits).toBe(count);
});
it('多选前后排序为一次Undo且不烘焙，边界不产生空历史', () => {
  const { app, host } = fixture(),
    a = app.add('image'),
    b = app.add('image'),
    c = app.add('image');
  app.select([a, b]);
  const commits = host.commits,
    renders = host.renders;
  expect(app.reorderSelection('forward')).toBe(true);
  expect(app.state.doc.roots).toEqual([c, a, b]);
  expect(host.commits).toBe(commits + 1);
  expect(host.renders).toBe(renders);
  expect(app.reorderSelection('front')).toBe(false);
  expect(host.commits).toBe(commits + 1);
});

it('普通新增和编组默认Auto；拖绘固定；移动子项只提交一次且不重烘焙', () => {
  const { app, host } = fixture();
  const frame = app.add('frame'),
    a = app.add('image', frame),
    b = app.add('image', frame);
  expect(app.state.doc.nodes[frame]!.layout.width.kind).toBe('auto');
  app.update(b, (n) => {
    n.layout.offset.x = 64;
  });
  const before = clone(app.state.doc),
    commits = host.commits,
    renders = host.renders;
  app.select([a]);
  app.beginGesture('move', true);
  app.finishMove(-30, -20, null);
  expect(app.state.doc.nodes[b]!.rect).toEqual(before.nodes[b]!.rect);
  expect(app.state.doc.nodes[a]!.rect.x).toBe(before.nodes[a]!.rect.x - 30);
  expect(host.commits - commits).toBe(1);
  expect(host.renders).toBe(renders);
  expect(host.doc!.nodes[frame]!.layout.width.kind).toBe('auto');
  expect(host.doc!.nodes[a]!.layout.offset).toEqual(app.state.doc.nodes[a]!.layout.offset);
  const drawn = app.createDrawn({
    kind: 'frame',
    rect: { x: 200, y: 200, width: 100, height: 80 },
    target: null,
  })!;
  expect(app.state.doc.nodes[drawn]!.layout.width).toEqual({ kind: 'fixed', value: 100 });
  app.select([a, b]);
  const group = app.groupSelection()!;
  expect(app.state.doc.nodes[group]!.layout.width.kind).toBe('auto');
});
