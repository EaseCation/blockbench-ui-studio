import type { SizeRule } from './types';
export function parseOffset(value: string): { percent: number; pixels: number } {
  const text = value.trim().toLowerCase();
  if (/^[+-]?\d+(?:\.\d+)?(?:px)?$/.test(text))
    return { percent: 0, pixels: Number.parseFloat(text) };
  const match = /^([+-]?\d+(?:\.\d+)?)%\s*(?:([+-])\s*(\d+(?:\.\d+)?)px)?$/.exec(text);
  if (!match) throw new Error('坐标应为像素或父级百分比±像素，例如 50% - 8px；不支持 fill/hug');
  return {
    percent: Number(match[1]) / 100,
    pixels: match[3] ? Number(match[3]) * (match[2] === '-' ? -1 : 1) : 0,
  };
}
export function formatOffset(percent: number, pixels: number): string {
  if (!percent) return `${pixels}px`;
  return `${Math.round(percent * 10000) / 100}%${pixels ? ` ${pixels < 0 ? '-' : '+'} ${Math.abs(pixels)}px` : ''}`;
}
export function parseSize(text: string): SizeRule {
  const s = text.trim().toLowerCase();
  if (s === 'fill' || s === 'hug') return { kind: s };
  if (/^\d+(?:\.\d+)?(?:px)?$/.test(s)) return { kind: 'fixed', value: Number.parseFloat(s) };
  const m = /^(\d+(?:\.\d+)?)%\s*(?:([+-])\s*(\d+(?:\.\d+)?)px)?$/.exec(s);
  if (!m) throw new Error('尺寸应为像素、百分比±像素、Fill 或 Hug，例如 100% - 16px');
  return {
    kind: 'expression',
    percent: Number(m[1]) / 100,
    pixels: m[3] ? Number(m[3]) * (m[2] === '-' ? -1 : 1) : 0,
  };
}
export function formatSize(rule: SizeRule): string {
  if (rule.kind === 'fixed') return `${rule.value}px`;
  if (rule.kind === 'expression')
    return `${Math.round(rule.percent * 10000) / 100}%${rule.pixels ? ` ${rule.pixels < 0 ? '-' : '+'} ${Math.abs(rule.pixels)}px` : ''}`;
  return rule.kind;
}
export function resizeRule(rule: SizeRule, delta: number, size: number): SizeRule {
  return rule.kind === 'expression'
    ? { ...rule, pixels: rule.pixels + delta }
    : { kind: 'fixed', value: size };
}

/** Input nudging changes pixels, never the relative percentage or a dynamic sizing rule. */
export function stepExpression(text: string, delta: number, kind: 'size' | 'offset'): string {
  const add = (value: number) => Math.round((value + delta) * 1e6) / 1e6;
  if (kind === 'offset') {
    const value = parseOffset(text);
    return formatOffset(value.percent, add(value.pixels));
  }
  const rule = parseSize(text);
  if (rule.kind === 'fill' || rule.kind === 'hug')
    throw new Error('填充／包裹由布局计算，请先切换为固定或百分比尺寸');
  return formatSize(
    rule.kind === 'fixed'
      ? { kind: 'fixed', value: Math.max(1, add(rule.value)) }
      : { ...rule, pixels: add(rule.pixels) },
  );
}
