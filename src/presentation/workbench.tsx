import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Studio } from '../application/studio';
import type { Id, UiNode, SizeRule, ImageMode } from '../domain/types';
import { defaultFrame } from '../domain/types';
import { parseSize, formatSize } from '../domain/expression';
import styles from './workbench.css';

export interface WorkbenchActions {
  changeView(value: '2d' | '3d'): void;
  changeInteraction(value: 'figma' | 'native'): void;
  importImage(): void;
  pasteNew(): void;
}
function Numeric({
  label,
  value,
  onChange,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label class="mcui-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}
function SizeInput({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: SizeRule;
  onChange: (r: SizeRule) => void;
  onError: (e: unknown) => void;
}) {
  return (
    <label class="mcui-field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={formatSize(value)}
        defaultValue={formatSize(value)}
        onChange={(e) => {
          try {
            onChange(parseSize(e.currentTarget.value));
          } catch (error) {
            onError(error);
            e.currentTarget.value = formatSize(value);
          }
        }}
      />
    </label>
  );
}
function App({ studio, actions }: { studio: Studio; actions: WorkbenchActions }) {
  const [, rerender] = useState(0);
  useEffect(() => studio.subscribe(() => rerender((n) => n + 1)), [studio]);
  const { doc, selection, interaction, view, busy, error } = studio.state;
  const node = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  const update = (fn: (n: UiNode) => void) => {
    if (node) studio.update(node.id, fn);
  };
  const parent = node?.kind === 'layer' ? node.parent : (node?.id ?? null);
  const [tab, setTab] = useState<'layers' | 'properties'>('layers');
  const row = (id: Id, depth = 0): preact.JSX.Element | null => {
    const n = doc.nodes[id];
    if (!n) return null;
    return (
      <div key={id}>
        <div
          class={`mcui-layer ${selection.includes(id) ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={(e) => {
            studio.select([id], e.shiftKey);
          }}
          onDblClick={() => n.kind === 'layer' && studio.paint(id)}
        >
          <span class="mcui-kind">{n.kind === 'frame' ? '▣' : n.kind === 'group' ? '▤' : '▧'}</span>
          <span class="mcui-layer-name">
            {n.name}
            {n.suspended ? ' ⚠' : ''}
          </span>
          <button
            title={n.visible ? '隐藏' : '显示'}
            onClick={(e) => {
              e.stopPropagation();
              studio.update(id, (n) => {
                n.visible = !n.visible;
              });
            }}
          >
            {n.visible ? '◉' : '○'}
          </button>
          <button
            title={n.locked ? '解锁' : '锁定'}
            onClick={(e) => {
              e.stopPropagation();
              studio.update(id, (n) => {
                n.locked = !n.locked;
              });
            }}
          >
            {n.locked ? '🔒' : '◇'}
          </button>
        </div>
        {n.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };
  return (
    <div class="mcui-workbench">
      <style>{styles}</style>
      <div class="mcui-toolbar">
        <select
          aria-label="交互风格"
          value={interaction}
          onChange={(e) => actions.changeInteraction(e.currentTarget.value as 'figma' | 'native')}
        >
          <option value="figma">Figma 风格</option>
          <option value="native">Blockbench 原生</option>
        </select>
        <select
          aria-label="视图"
          value={view}
          onChange={(e) => actions.changeView(e.currentTarget.value as '2d' | '3d')}
        >
          <option value="2d">2D 顶视图</option>
          <option value="3d">3D 透视</option>
        </select>
      </div>
      <div class="mcui-toolbar">
        <button onClick={() => studio.add('layer', parent)}>＋图层</button>
        <button onClick={() => studio.add('frame', parent)}>＋Frame</button>
        <button onClick={() => studio.add('group', parent)}>＋组</button>
        <button onClick={() => actions.importImage()}>导入图片</button>
      </div>
      <div class="mcui-tabs">
        <button class={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>
          图层
        </button>
        <button class={tab === 'properties' ? 'active' : ''} onClick={() => setTab('properties')}>
          属性 {selection.length ? `(${selection.length})` : ''}
        </button>
      </div>
      {busy && <p>正在加载源图…</p>}
      {error && (
        <p class="mcui-error" role="alert">
          {error}
        </p>
      )}
      {tab === 'layers' && (
        <>
          <div class="mcui-layer-list">{doc.roots.map((id) => row(id))}</div>
          <div class="mcui-toolbar">
            <button disabled={!selection.length} onClick={() => studio.duplicate()}>
              复制
            </button>
            <button disabled={!selection.length} onClick={() => studio.deleteSelection()}>
              删除
            </button>
            <button onClick={() => actions.pasteNew()}>粘贴为新图层</button>
          </div>
        </>
      )}
      {tab === 'properties' &&
        (!node ? (
          <p class="mcui-hint">选择一个图层编辑属性；多选可整体移动、缩放和测距。</p>
        ) : (
          <>
            <label class="mcui-field">
              <span>名称</span>
              <input
                aria-label="图层名称"
                key={node.id + node.name}
                defaultValue={node.name}
                onChange={(e) =>
                  update((n) => {
                    n.name = e.currentTarget.value;
                  })
                }
              />
            </label>
            <label class="mcui-field">
              <span>父级</span>
              <select
                aria-label="父级"
                value={node.parent ?? ''}
                onChange={(e) => studio.reparent(node.id, e.currentTarget.value || null)}
              >
                <option value="">根目录</option>
                {Object.values(doc.nodes)
                  .filter((n) => n.kind !== 'layer' && n.id !== node.id)
                  .map((n) => (
                    <option value={n.id}>{n.name}</option>
                  ))}
              </select>
            </label>
            {node.suspended && (
              <div class="mcui-warning">
                {node.suspended}
                <div class="mcui-toolbar">
                  <button onClick={() => studio.adopt(node.id)}>采用当前结果</button>
                  <button onClick={() => studio.regenerate(node.id)}>按规则重新生成</button>
                </div>
              </div>
            )}
            <div class="mcui-grid">
              <Numeric
                label="X 偏移"
                value={node.layout.offset.x}
                onChange={(v) =>
                  update((n) => {
                    n.layout.offset.x = v;
                  })
                }
              />
              <Numeric
                label="Y 偏移"
                value={node.layout.offset.y}
                onChange={(v) =>
                  update((n) => {
                    n.layout.offset.y = v;
                  })
                }
              />
              <SizeInput
                label="宽度"
                value={node.layout.width}
                onChange={(v) =>
                  update((n) => {
                    n.layout.width = v;
                  })
                }
                onError={(e) => studio.report(e)}
              />
              <SizeInput
                label="高度"
                value={node.layout.height}
                onChange={(v) =>
                  update((n) => {
                    n.layout.height = v;
                  })
                }
                onError={(e) => studio.report(e)}
              />
              <Numeric
                label="最小宽"
                value={node.layout.minWidth}
                min={1}
                onChange={(v) =>
                  update((n) => {
                    n.layout.minWidth = v;
                  })
                }
              />
              <Numeric
                label="最小高"
                value={node.layout.minHeight}
                min={1}
                onChange={(v) =>
                  update((n) => {
                    n.layout.minHeight = v;
                  })
                }
              />
              {(['maxWidth', 'maxHeight'] as const).map((key, i) => (
                <label class="mcui-field">
                  <span>{i ? '最大高' : '最大宽'}</span>
                  <input
                    aria-label={i ? '最大高' : '最大宽'}
                    type="number"
                    min={1}
                    placeholder="不限"
                    value={node.layout[key] ?? ''}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      update((n) => {
                        n.layout[key] = value === '' ? undefined : Number(value);
                      });
                    }}
                  />
                </label>
              ))}
            </div>
            <p class="mcui-hint">
              实际 {node.rect.width} × {node.rect.height}px · 支持 100% - 16px、fill、hug
            </p>
            <label class="mcui-field">
              <span>定位</span>
              <select
                aria-label="定位"
                value={node.layout.positioning}
                onChange={(e) =>
                  update((n) => {
                    n.layout.positioning = e.currentTarget.value as 'flow' | 'absolute';
                  })
                }
              >
                <option value="flow">参与布局</option>
                <option value="absolute">绝对定位</option>
              </select>
            </label>
            <div class="mcui-grid">
              {(['anchorFrom', 'anchorTo'] as const).map((key, i) => (
                <label class="mcui-field">
                  <span>{i ? '自身锚点' : '父锚点'}</span>
                  <select
                    aria-label={i ? '自身锚点' : '父锚点'}
                    value={node.layout[key].join(',')}
                    onChange={(e) => {
                      const values = e.currentTarget.value.split(',').map(Number);
                      update((n) => {
                        n.layout[key] = [values[0]!, values[1]!];
                      });
                    }}
                  >
                    {[0, 0.5, 1].flatMap((y, yi) =>
                      [0, 0.5, 1].map((x, xi) => (
                        <option value={`${x},${y}`}>
                          {['上', '中', '下'][yi]}
                          {['左', '中', '右'][xi]}
                        </option>
                      )),
                    )}
                  </select>
                </label>
              ))}
            </div>
            <div class="mcui-toolbar">
              <button onClick={() => studio.reorder(node.id, 1)}>上移一层</button>
              <button onClick={() => studio.reorder(node.id, -1)}>下移一层</button>
            </div>
            {node.kind !== 'layer' && (
              <>
                <hr />
                <label class="mcui-field">
                  <span>自动布局</span>
                  <select
                    aria-label="自动布局"
                    value={node.frame?.direction ?? 'free'}
                    onChange={(e) =>
                      update((n) => {
                        n.frame ??= defaultFrame();
                        n.frame.direction = e.currentTarget.value as 'row' | 'column' | 'free';
                      })
                    }
                  >
                    <option value="free">自由布局</option>
                    <option value="row">横向</option>
                    <option value="column">纵向</option>
                  </select>
                </label>
                <Numeric
                  label="间距"
                  value={node.frame?.gap ?? 8}
                  min={0}
                  onChange={(v) =>
                    update((n) => {
                      n.frame!.gap = v;
                    })
                  }
                />
                <div class="mcui-grid">
                  {['上', '右', '下', '左'].map((name, i) => (
                    <Numeric
                      label={`${name}内边距`}
                      value={node.frame?.padding[i] ?? 0}
                      min={0}
                      onChange={(v) =>
                        update((n) => {
                          n.frame!.padding[i] = v;
                        })
                      }
                    />
                  ))}
                </div>
                <label class="mcui-field">
                  <span>主轴</span>
                  <select
                    aria-label="主轴对齐"
                    value={node.frame?.justify}
                    onChange={(e) =>
                      update((n) => {
                        n.frame!.justify = e.currentTarget.value as
                          | 'start'
                          | 'center'
                          | 'end'
                          | 'space-between';
                      })
                    }
                  >
                    <option value="start">起点</option>
                    <option value="center">居中</option>
                    <option value="end">终点</option>
                    <option value="space-between">两端分布</option>
                  </select>
                </label>
                <label class="mcui-field">
                  <span>交叉轴</span>
                  <select
                    aria-label="交叉轴对齐"
                    value={node.frame?.align}
                    onChange={(e) =>
                      update((n) => {
                        n.frame!.align = e.currentTarget.value as 'start' | 'center' | 'end';
                      })
                    }
                  >
                    <option value="start">起点</option>
                    <option value="center">居中</option>
                    <option value="end">终点</option>
                  </select>
                </label>
              </>
            )}
            {node.content && (
              <>
                <hr />
                <div class="mcui-toolbar">
                  <button onClick={() => studio.paint(node.id)}>
                    {node.content.kind === 'paint' ? '绘制贴图' : '编辑源图'}
                  </button>
                  <button onClick={() => studio.makeNine(node.id)}>九宫格</button>
                  <button onClick={() => studio.flatten(node.id)}>转为绘画图层</button>
                </div>
                {node.originalContent && (
                  <button onClick={() => studio.restoreSource(node.id)}>恢复原始来源</button>
                )}
                {node.content.kind === 'paint' && (
                  <label class="mcui-field">
                    <span>尺寸变化</span>
                    <select
                      aria-label="尺寸变化"
                      value={node.content.mode}
                      onChange={(e) =>
                        update((n) => {
                          if (n.content?.kind === 'paint')
                            n.content.mode = e.currentTarget.value as 'extend' | 'scale';
                        })
                      }
                    >
                      <option value="extend">扩展画布（保持像素）</option>
                      <option value="scale">缩放内容</option>
                    </select>
                  </label>
                )}
                {node.content.kind === 'image' && (
                  <>
                    <label class="mcui-field">
                      <span>图片适配</span>
                      <select
                        aria-label="图片适配"
                        value={node.content.mode}
                        onChange={(e) =>
                          update((n) => {
                            if (n.content?.kind === 'image')
                              n.content.mode = e.currentTarget.value as ImageMode;
                          })
                        }
                      >
                        <option value="stretch">拉伸 Stretch</option>
                        <option value="fit">完整显示 Fit</option>
                        <option value="fill">铺满 Fill</option>
                        <option value="crop">手动裁切 Crop</option>
                        <option value="original">原始像素</option>
                      </select>
                    </label>
                    {node.content.mode === 'crop' && (
                      <div class="mcui-grid">
                        <Numeric
                          label="图片倍率"
                          value={node.content.scale}
                          min={0.01}
                          step={0.1}
                          onChange={(v) =>
                            update((n) => {
                              if (n.content?.kind === 'image') n.content.scale = v;
                            })
                          }
                        />
                        <button
                          onClick={() =>
                            update((n) => {
                              if (n.content?.kind === 'image')
                                n.content.scale = Math.max(1, Math.round(n.content.scale));
                            })
                          }
                        >
                          整数倍率
                        </button>
                        <Numeric
                          label="图片 X"
                          value={node.content.offset.x}
                          onChange={(v) =>
                            update((n) => {
                              if (n.content?.kind === 'image') n.content.offset.x = v;
                            })
                          }
                        />
                        <Numeric
                          label="图片 Y"
                          value={node.content.offset.y}
                          onChange={(v) =>
                            update((n) => {
                              if (n.content?.kind === 'image') n.content.offset.y = v;
                            })
                          }
                        />
                      </div>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={node.content.onlyDownscale}
                        onChange={(e) =>
                          update((n) => {
                            if (n.content?.kind === 'image')
                              n.content.onlyDownscale = e.currentTarget.checked;
                          })
                        }
                      />
                      只允许缩小
                    </label>
                    <label class="mcui-field">
                      <span>图片锚点</span>
                      <select
                        aria-label="图片锚点"
                        value={node.content.anchor.join(',')}
                        onChange={(e) => {
                          const a = e.currentTarget.value.split(',').map(Number);
                          update((n) => {
                            if (n.content?.kind === 'image') n.content.anchor = [a[0]!, a[1]!];
                          });
                        }}
                      >
                        {[0, 0.5, 1].flatMap((y, yi) =>
                          [0, 0.5, 1].map((x, xi) => (
                            <option value={`${x},${y}`}>
                              {['上', '中', '下'][yi]}
                              {['左', '中', '右'][xi]}
                            </option>
                          )),
                        )}
                      </select>
                    </label>
                  </>
                )}
                {node.content.kind === 'nine-slice' && (
                  <>
                    <div class="mcui-grid">
                      {['上边距', '右边距', '下边距', '左边距'].map((name, i) => (
                        <Numeric
                          label={name}
                          min={0}
                          value={node.content?.kind === 'nine-slice' ? node.content.insets[i]! : 0}
                          onChange={(v) =>
                            update((n) => {
                              if (n.content?.kind === 'nine-slice') n.content.insets[i] = v;
                            })
                          }
                        />
                      ))}
                    </div>
                    <label class="mcui-field">
                      <span>九宫格模式</span>
                      <select
                        aria-label="九宫格模式"
                        value={node.content.mode}
                        onChange={(e) =>
                          update((n) => {
                            if (n.content?.kind === 'nine-slice')
                              n.content.mode = e.currentTarget.value as 'stretch' | 'tile';
                          })
                        }
                      >
                        <option value="stretch">拉伸</option>
                        <option value="tile">平铺</option>
                      </select>
                    </label>
                    <div class="mcui-source-preview">
                      <img src={doc.assets[node.content.source]?.png} />
                      {(() => {
                        const c = node.content;
                        if (c.kind !== 'nine-slice') return null;
                        const a = doc.assets[c.source]!;
                        return (
                          <svg viewBox={`0 0 ${a.width} ${a.height}`} preserveAspectRatio="none">
                            <path
                              d={`M ${c.insets[3]} 0 V ${a.height} M ${a.width - c.insets[1]} 0 V ${a.height} M 0 ${c.insets[0]} H ${a.width} M 0 ${a.height - c.insets[2]} H ${a.width}`}
                              stroke="#ff536e"
                              stroke-width="0.4"
                            />
                          </svg>
                        );
                      })()}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        ))}
      <p class="mcui-hint">Shift 等比 · Option 对称／测距 · 空格／中键平移 · 双击绘画</p>
    </div>
  );
}
export function mountWorkbench(root: HTMLElement, studio: Studio, actions: WorkbenchActions) {
  render(<App studio={studio} actions={actions} />, root);
  return () => render(null, root);
}
