import { clone } from '../../domain/document';
import type { GeneratedRecipe, UiDocument } from '../../domain/types';
import { contentProviders } from '../../application/content';
import type { HostObject } from './runtime';
const safe = (id: string) =>
  /^[a-z][a-z0-9_]{1,63}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
const generated = (value: unknown): value is GeneratedRecipe =>
  !!value && (value as GeneratedRecipe).kind === 'generated';
/** Recipe data is an in-memory draft; its persisted authority is the native surface. */
export function hydrateContents(doc: UiDocument, project: HostObject) {
  for (const [id, n] of Object.entries(doc.nodes)) {
    const cubeId = doc.bindings[id]?.surfaceId;
    const cube = project.elements.find((e: HostObject) => e.uuid === cubeId);
    for (const c of [n.content, n.originalContent]) {
      if (!generated(c) || !safe(c.provider)) continue;
      const value =
        cube?.[c.provider] ?? project.unhandled_root_fields?.[c.provider]?.entries?.[cubeId ?? ''];
      if (value) {
        c.data = clone(value);
        delete c.data!.inactive;
      }
    }
  }
}
export function persistContents(doc: UiDocument, project: HostObject): UiDocument {
  const saved = clone(doc);
  delete saved.contentResources;
  project.unhandled_root_fields ??= {};
  const previous: UiDocument | undefined = project.unhandled_root_fields.mcui_studio?.document;
  for (const [id, n] of Object.entries(doc.nodes)) {
    const cubeId = doc.bindings[id]?.surfaceId;
    if (!cubeId) continue;
    const cube = project.elements.find((e: HostObject) => e.uuid === cubeId);
    const recipes = [n.content, n.originalContent].filter(generated);
    const prior = [previous?.nodes[id]?.content, previous?.nodes[id]?.originalContent].filter(
      generated,
    );
    for (const provider of new Set([...recipes, ...prior].map((c) => c.provider))) {
      if (!safe(provider)) continue;
      const store = (project.unhandled_root_fields[provider] ??= { version: 1, entries: {} });
      store.entries ??= {};
      const c = recipes.find((c) => c.provider === provider);
      if (c?.data && cube) {
        if (c === n.content && !n.suspended)
          Object.assign(c.data, contentProviders.get(provider)?.seal?.(cubeId, c.data));
        const value = clone(c.data);
        if (c !== n.content) value.inactive = true;
        cube[provider] = value;
        store.entries[cubeId] = clone(value);
      } else if (!c) {
        if (cube) cube[provider] = null;
        delete store.entries[cubeId];
      }
    }
    for (const c of [saved.nodes[id]?.content, saved.nodes[id]?.originalContent])
      if (generated(c)) delete c.data;
  }
  return saved;
}
export function contentMetadata(project: HostObject) {
  const doc: UiDocument | undefined = project.unhandled_root_fields.mcui_studio?.document;
  const names = new Set(contentProviders.keys());
  for (const n of Object.values(doc?.nodes ?? {}))
    for (const c of [n.content, n.originalContent])
      if (generated(c) && safe(c.provider)) names.add(c.provider);
  return Object.fromEntries(
    [...names].map((key) => [key, clone(project.unhandled_root_fields?.[key] ?? null)]),
  );
}
