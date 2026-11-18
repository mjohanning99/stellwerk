// Stellwerk: appearance. Look, colour scheme, mode, accent, fonts and text size,
// stored per browser (localStorage, "sw." keys holding JSON) and applied as attributes
// and variables on <html>; themes.css (tools/gen_themes.py) and style.css do the rest.
// theme-boot.js repeats applyAppearance() before the first paint: keep the two in step.

export const LOOKS = [
  { id: 'flat', name: 'Flat', title: 'Flat: plain surfaces, a colour scheme and an accent of your choice' },
  { id: 'nachtzug', name: 'Nachtzug', title: 'Nachtzug: paper and brick by day, ember by night; keys with depth' },
];
export const DEFAULT_LOOK = 'flat';
export const MODES = [{ id: null, name: 'System' }, { id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }];
// The palettes live in tools/gen_themes.py; these ids must match it.
export const SCHEMES = [
  { id: 'neutral', name: 'Neutral' },
  { id: 'harbour', name: 'Harbour' },
  { id: 'moss', name: 'Moss' },
  { id: 'plum', name: 'Plum' },
  { id: 'contrast', name: 'High contrast' },
];
export const DEFAULT_SCHEME = 'neutral';
export const ACCENTS = [
  { id: 'blue', name: 'Blue' }, { id: 'teal', name: 'Teal' }, { id: 'green', name: 'Green' },
  { id: 'amber', name: 'Amber' }, { id: 'red', name: 'Red' }, { id: 'violet', name: 'Violet' },
];
export const UI_FONTS = [
  { id: null, name: 'Theme default' },
  { id: 'system', name: 'System' },
  { id: 'inter', name: 'Inter' },
  { id: 'atkinson', name: 'Atkinson Hyperlegible' },
  { id: 'grotesk', name: 'Nachtzug Grotesk' },
  { id: 'maple', name: 'Maple Mono' },
  { id: 'serif', name: 'Nachtzug Antiqua (serif)' },
];
export const CODE_FONTS = [
  { id: null, name: 'Maple Mono' },
  { id: 'jetbrains', name: 'JetBrains Mono' },
  { id: 'system', name: 'System monospace' },
];
export const TEXT_SIZES = [90, 100, 112, 125].map((n) => ({ id: n, name: `${n} %` }));

const HEX = /^#[0-9a-f]{6}$/i;
const valid = (list, v) => list.some((o) => o.id === v);

// Older names of the looks: the Nachtzug look was called brick (and, before that,
// a name starting with "hexa"); every other old look becomes Flat.
export function normalizeLook(v) {
  if (typeof v !== 'string') return DEFAULT_LOOK;
  if (v === 'nachtzug' || v === 'brick' || v.startsWith('hexa')) return 'nachtzug';
  return 'flat';
}

const read = (k, d) => { try { const v = localStorage.getItem('sw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };

export function readPrefs() {
  const accent = read('accent', null);
  return {
    look: normalizeLook(read('look', DEFAULT_LOOK)),
    mode: valid(MODES, read('theme', null)) ? read('theme', null) : null,
    scheme: valid(SCHEMES, read('scheme', null)) ? read('scheme', null) : null,   // null: not picked
    accent: valid(ACCENTS, accent) || (typeof accent === 'string' && HEX.test(accent)) ? accent : null,
    uiFont: valid(UI_FONTS, read('uiFont', null)) ? read('uiFont', null) : null,
    codeFont: valid(CODE_FONTS, read('codeFont', null)) ? read('codeFont', null) : null,
    textSize: valid(TEXT_SIZES, read('textSize', 100)) ? read('textSize', 100) : 100,
  };
}

export const prefersContrast = () => matchMedia('(prefers-contrast: more)').matches;
// Not picked: High contrast when the system asks for more contrast, else Neutral.
export const resolveScheme = (scheme) => scheme || (prefersContrast() ? 'contrast' : DEFAULT_SCHEME);

// ------------------------------------------------------------ contrast (WCAG 2)
export function parseColor(s) {
  s = String(s || '').trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
export function luminance(c) {
  const rgb = Array.isArray(c) ? c : parseColor(c);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Text on an accent: white or near-black, whichever reads better.
export const inkFor = (col) => ((contrast(col, '#ffffff') || 0) >= (contrast(col, '#111111') || 0) ? '#ffffff' : '#111111');

// The variables a chosen accent sets inline on <html> (null: the scheme's own).
export function accentVars(accent) {
  if (!accent) return null;
  const base = HEX.test(accent)
    ? { '--accent': accent, '--accent-ink': inkFor(accent) }
    : { '--accent': `var(--acc-${accent})`, '--accent-ink': `var(--acc-${accent}-ink)` };
  return {
    ...base,
    '--accent-hi': 'color-mix(in srgb, var(--accent) 88%, var(--fg))',
    '--accent-deep': 'color-mix(in srgb, var(--accent) 72%, #000)',
  };
}
const ACCENT_VARS = ['--accent', '--accent-ink', '--accent-hi', '--accent-deep'];

export function applyAppearance(p = readPrefs()) {
  const root = document.documentElement, d = root.dataset;
  d.look = p.look;
  if (p.mode) d.theme = p.mode; else delete d.theme;
  const flat = p.look === 'flat';
  if (flat) d.scheme = resolveScheme(p.scheme); else delete d.scheme;
  if (p.uiFont) d.uiFont = p.uiFont; else delete d.uiFont;
  if (p.codeFont) d.codeFont = p.codeFont; else delete d.codeFont;
  if (p.textSize && p.textSize !== 100) d.textSize = String(p.textSize); else delete d.textSize;
  for (const k of ACCENT_VARS) root.style.removeProperty(k);
  const vars = flat ? accentVars(p.accent) : null;
  if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

// Current value of a colour token as the page shows it now.
export const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
