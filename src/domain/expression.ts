import type { SizeRule, SizeTerm, SizeUnit } from './types';
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
export const sizeUnits: Record<SizeUnit, string> = {
  '%': '父级同轴',
  '%c': '子项合计',
  '%cm': '最大可见子项',
  '%sm': '最大同级',
  '%x': '自身宽度',
  '%y': '自身高度',
};
const numberText = (n: number) => {
  const text = String(Number(n.toPrecision(12)));
  if (!text.includes('e')) return text;
  const [coefficient, exponent] = text.split('e'),
    negative = coefficient!.startsWith('-'),
    body = coefficient!.replace('-', '');
  const [whole, fraction = ''] = body.split('.'),
    digits = whole! + fraction,
    point = whole!.length + Number(exponent);
  const decimal =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  return (negative ? '-' : '') + decimal;
};
export function sizeTerms(rule: SizeRule): SizeTerm[] {
  return rule.kind === 'expression'
    ? [{ unit: rule.unit ?? '%', percent: rule.percent }]
    : rule.kind === 'sum'
      ? rule.terms
      : [];
}
export function composeSize(terms: SizeTerm[], pixels: number): SizeRule {
  if (
    !Number.isFinite(pixels) ||
    terms.some((t) => !Number.isFinite(t.percent) || !Object.hasOwn(sizeUnits, t.unit))
  )
    throw new Error('尺寸项必须是有限数值和有效单位');
  const merged: SizeTerm[] = [];
  for (const t of terms) {
    const found = merged.find((v) => v.unit === t.unit);
    if (found) found.percent += t.percent;
    else merged.push({ ...t });
  }
  if (merged.some((t) => !Number.isFinite(t.percent))) throw new Error('尺寸数值超出范围');
  if (!merged.length) return { kind: 'fixed', value: pixels };
  if (merged.length === 1) {
    const t = merged[0]!;
    return {
      kind: 'expression',
      percent: t.percent,
      pixels,
      ...(t.unit === '%' ? {} : { unit: t.unit }),
    };
  }
  return { kind: 'sum', terms: merged, pixels };
}
export function parseSize(text: string): SizeRule {
  const s = text.trim().toLowerCase();
  if (['fill', 'hug', 'default', 'auto'].includes(s))
    return { kind: s as 'fill' | 'hug' | 'default' | 'auto' };
  if (!s) throw new Error('请输入尺寸，例如 32px、100%cm + 8px 或 fill');
  const tokens = /([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)\s*(%cm|%sm|%c|%x|%y|%|px)?/gy;
  const terms: SizeTerm[] = [];
  let pixels = 0,
    pos = 0,
    first = true;
  while (pos < s.length) {
    tokens.lastIndex = pos;
    const m = tokens.exec(s);
    if (!m || (!first && !m[1]))
      throw new Error('尺寸表达式无法解析；支持 px、%、%c、%cm、%sm、%x、%y 与加减号');
    const v = Number(m[2]) * (m[1] === '-' ? -1 : 1),
      unit = m[3];
    if (!Number.isFinite(v)) throw new Error('尺寸数值超出范围');
    if (unit?.startsWith('%')) terms.push({ unit: unit as SizeUnit, percent: v / 100 });
    else pixels += v;
    pos = tokens.lastIndex;
    while (/\s/.test(s[pos] ?? '') && pos < s.length) pos++;
    first = false;
  }
  return composeSize(terms, pixels);
}
export function formatSize(rule: SizeRule): string {
  if (rule.kind === 'fixed') return `${numberText(rule.value)}px`;
  if (rule.kind !== 'expression' && rule.kind !== 'sum') return rule.kind;
  const parts = sizeTerms(rule).map((t) => ({ value: t.percent * 100, unit: t.unit as string }));
  if (rule.pixels) parts.push({ value: rule.pixels, unit: 'px' });
  return parts
    .map(
      (t, i) =>
        `${i ? (t.value < 0 ? ' - ' : ' + ') : t.value < 0 ? '-' : ''}${numberText(Math.abs(t.value))}${t.unit}`,
    )
    .join('');
}
export function resizeRule(rule: SizeRule, delta: number, size: number): SizeRule {
  return rule.kind === 'expression' || rule.kind === 'sum'
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
  if (
    rule.kind === 'fill' ||
    rule.kind === 'hug' ||
    rule.kind === 'default' ||
    rule.kind === 'auto'
  )
    throw new Error('此规则由布局计算；请选择像素或带参照的公式后调整偏移');
  return formatSize(
    rule.kind === 'fixed'
      ? { kind: 'fixed', value: Math.max(0, add(rule.value)) }
      : { ...rule, pixels: add(rule.pixels) },
  );
}

export function validSizeRule(value: unknown): value is SizeRule {
  if (!value || typeof value !== 'object') return false;
  const r = value as SizeRule;
  const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const term = (t: SizeTerm) => !!t && numeric(t.percent) && Object.hasOwn(sizeUnits, t.unit);
  if (r.kind === 'fixed') return numeric(r.value);
  if (r.kind === 'expression')
    return (
      numeric(r.percent) &&
      numeric(r.pixels) &&
      (r.unit === undefined || Object.hasOwn(sizeUnits, r.unit))
    );
  if (r.kind === 'sum')
    return numeric(r.pixels) && Array.isArray(r.terms) && r.terms.length > 0 && r.terms.every(term);
  return r.kind === 'default' || r.kind === 'fill' || r.kind === 'hug' || r.kind === 'auto';
}
