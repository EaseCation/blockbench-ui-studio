import type { Id, UiDocument } from '../../domain/types';
/** Bindings are replaced with the document on publish/Undo. Verify roles at each consumer. */
export class BindingIndex {
  private bindings: UiDocument['bindings'] | null = null;
  private ids = new Map<string, Id>();
  get(doc: UiDocument) {
    if (this.bindings !== doc.bindings) {
      this.bindings = doc.bindings;
      this.ids = new Map(
        Object.entries(doc.bindings).flatMap(
          ([id, b]) =>
            [[b.containerId, id], ...(b.surfaceId ? [[b.surfaceId, id]] : [])] as [string, Id][],
        ),
      );
    }
    return this.ids;
  }
}
