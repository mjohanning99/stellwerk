// Stellwerk: sets the stored appearance on <html> before the first paint, so the page
// does not flash in the default look. A classic script because the CSP forbids inline ones.
// It mirrors applyAppearance() in theme.js (the source of truth); keep the two in step.
(function () {
  var root = document.documentElement, d = root.dataset;
  function read(k, def) {
    try { var v = localStorage.getItem('sw.' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
  }
  function pick(v, ok) { return ok.indexOf(v) >= 0 ? v : null; }
  try {
    var look = read('look', 'flat');
    look = typeof look === 'string' && (look === 'nachtzug' || look === 'brick' || look.indexOf('hexa') === 0) ? 'nachtzug' : 'flat';
    d.look = look;
    var mode = pick(read('theme', null), ['light', 'dark']);
    if (mode) d.theme = mode;
    if (look === 'flat') {
      var scheme = pick(read('scheme', null), ['neutral', 'harbour', 'moss', 'plum', 'contrast']);
      d.scheme = scheme || (matchMedia('(prefers-contrast: more)').matches ? 'contrast' : 'neutral');
      var accent = read('accent', null), s = root.style;
      if (pick(accent, ['blue', 'teal', 'green', 'amber', 'red', 'violet'])) {
        s.setProperty('--accent', 'var(--acc-' + accent + ')');
        s.setProperty('--accent-ink', 'var(--acc-' + accent + '-ink)');
      } else if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) {
        var lum = [1, 3, 5].map(function (i) {
          var v = parseInt(accent.substr(i, 2), 16) / 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        var L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
        // white or #111 (luminance .0056), whichever contrasts more
        s.setProperty('--accent', accent);
        s.setProperty('--accent-ink', 1.05 / (L + 0.05) >= (L + 0.05) / 0.0556 ? '#ffffff' : '#111111');
      }
      if (accent && s.getPropertyValue('--accent')) {
        s.setProperty('--accent-hi', 'color-mix(in srgb, var(--accent) 88%, var(--fg))');
        s.setProperty('--accent-deep', 'color-mix(in srgb, var(--accent) 72%, #000)');
      }
    }
    var ui = pick(read('uiFont', null), ['system', 'inter', 'atkinson', 'grotesk', 'maple', 'serif']);
    if (ui) d.uiFont = ui;
    var code = pick(read('codeFont', null), ['jetbrains', 'system']);
    if (code) d.codeFont = code;
    var size = pick(read('textSize', 100), [90, 112, 125]);
    if (size) d.textSize = String(size);
  } catch (e) { d.look = d.look || 'flat'; d.scheme = d.scheme || 'neutral'; }
}());
