/** Consume only unmodified vertical arrows, leaving IME and text navigation to the host. */
export function inputStep(event: KeyboardEvent): number | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return null;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;
  event.preventDefault();
  event.stopPropagation();
  return event.key === 'ArrowUp' ? 1 : -1;
}

export function stepNumber(value: string, delta: number, min = -Infinity): string {
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error('请先输入有效数值，再使用 ↑/↓ 微调');
  return String(Math.max(min, Math.round((Number(value) + delta) * 1e6) / 1e6));
}
