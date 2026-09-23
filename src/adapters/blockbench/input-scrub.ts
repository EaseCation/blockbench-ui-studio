export interface ScrubSession {
  preview(value: string): boolean;
  finish(commit: boolean): void;
}
const starters = new WeakMap<HTMLInputElement, (event: PointerEvent, label?: boolean) => void>();
const activeScrubs = new Set<() => void>();
export function cancelScrubs() {
  for (const cancel of [...activeScrubs]) cancel();
}

export function scrubLabel(input: HTMLInputElement, label: HTMLElement) {
  const start = starters.get(input);
  if (!start) return;
  label.style.cursor = 'ew-resize';
  label.title = '左右拖动调整数值；上下移动切换速度。也可 Option/Alt 拖动输入框。';
  label.addEventListener('pointerdown', (event) => start(event, true));
}

/** One pointer gesture, one transaction. No document-wide interception outside an active scrub. */
export function bindScrub(
  input: HTMLInputElement,
  options: {
    key(): string;
    enabled(): boolean;
    step(value: string, delta: number): string;
    begin(): ScrubSession;
    refresh(): void;
    report(error: unknown): void;
  },
) {
  let cancel: (() => void) | undefined;
  const start = (event: PointerEvent, label = false) => {
    if (
      event.button !== 0 ||
      (!label && !event.altKey) ||
      event.ctrlKey ||
      event.metaKey ||
      input.disabled ||
      input.readOnly ||
      !options.enabled()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const initial = input.value,
      key = options.key();
    try {
      options.step(initial, 0);
    } catch (error) {
      options.report(error);
      return;
    }
    cancel?.();
    let session: ScrubSession | undefined,
      total = 0,
      lastX = event.clientX,
      changed = false;
    let lastValue = initial,
      ended = false;
    const hint = document.createElement('div');
    hint.textContent = '1×';
    hint.style.cssText =
      'position:fixed;bottom:38px;left:50%;transform:translateX(-50%);z-index:10000;pointer-events:none;padding:5px 10px;background:var(--color-back);color:var(--color-text);border:1px solid var(--color-border);border-radius:4px';
    const valid = () => input.isConnected && options.key() === key && options.enabled();
    const done = (commit: boolean) => {
      if (ended) return;
      ended = true;
      activeScrubs.delete(abort);
      cancel = undefined;
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', abort, true);
      input.removeEventListener('lostpointercapture', abort);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', abort);
      clearInterval(watch);
      if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
      hint.remove();
      session?.finish(commit && changed && valid());
      options.refresh();
    };
    const abort = () => done(false);
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!valid()) {
        abort();
        return;
      }
      const dy = e.clientY - event.clientY;
      const speed = dy < -40 ? 2 : dy > 80 ? 0.25 : dy > 40 ? 0.5 : 1;
      if (session) hint.textContent = `${speed}× · ${lastValue}`;
      total += (e.clientX - lastX) * speed;
      lastX = e.clientX;
      if (!session && Math.abs(e.clientX - event.clientX) < 3) return;
      try {
        const value = options.step(initial, Math.trunc(total));
        if (value === lastValue) return;
        session ??= options.begin();
        if (session.preview(value)) {
          lastValue = value;
          changed = value !== initial;
          input.value = value;
          hint.textContent = `${speed}× · ${value}`;
          document.body.append(hint);
        }
      } catch (error) {
        options.report(error);
        abort();
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === event.pointerId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(true);
      }
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        abort();
      } else if (!['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const watch = setInterval(() => {
      if (!valid()) abort();
    }, 50);
    cancel = abort;
    activeScrubs.add(abort);
    input.setPointerCapture(event.pointerId);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', abort, true);
    input.addEventListener('lostpointercapture', abort);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', abort);
  };
  starters.set(input, start);
  const onDown = (e: PointerEvent) => start(e);
  input.addEventListener('pointerdown', onDown);
  input.title += ' · ↑/↓ 加减 1；Option/Alt＋左右拖动调整';
  return () => {
    cancel?.();
    starters.delete(input);
    input.removeEventListener('pointerdown', onDown);
  };
}
