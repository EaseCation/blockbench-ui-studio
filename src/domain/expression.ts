import type { SizeRule } from './types';
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
