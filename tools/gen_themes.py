#!/usr/bin/env python3
"""Writes web/themes.css: the colour tokens of every look, scheme and mode.

Two looks:
  flat      the default: a flat component style with several colour schemes
            (data-scheme) and an optional accent colour (presets below).
  nachtzug  the tactile look: paper and brick by day, ember by night.

Each palette has a light and a dark variant. Light is the default; dark applies
with data-theme="dark", or with the system's dark mode unless data-theme="light".

Every palette is checked for WCAG contrast before anything is written; the
script exits non-zero and lists the failing token pairs if one falls short.
Edit the palettes here, then run: python3 tools/gen_themes.py
"""
import sys
from pathlib import Path

# ------------------------------------------------------------------ fonts
# Sizes are in rem so the Text size setting (the root font size) scales them.
LOOK_FONTS = {
    "flat":     {"ui": "var(--f-system)", "prose": "var(--ui)", "head": "var(--ui)",
                 "ui-size": ".875rem", "prose-size": ".9375rem", "prose-lh": "1.6", "code-em": ".875em"},
    "nachtzug": {"ui": "var(--f-grotesk)", "prose": "var(--f-antiqua)", "head": "var(--f-antiqua)",
                 "ui-size": ".875rem", "prose-size": "1.09375rem", "prose-lh": "1.55", "code-em": ".8em"},
}
# Interface font choices (data-ui-font): family, reply size, line height, inline code size.
# Not set: the look's own fonts. A chosen font is used for replies and headings too.
UI_FONTS = {
    "system":   ("var(--f-system)", ".9375rem", "1.6", ".875em"),
    "inter":    ("var(--f-inter)", ".9375rem", "1.6", ".875em"),
    "atkinson": ("var(--f-atkinson)", "1rem", "1.6", ".875em"),
    "grotesk":  ("var(--f-grotesk)", "1rem", "1.55", ".875em"),
    "maple":    ("var(--f-maple)", ".90625rem", "1.65", ".92em"),
    "serif":    ("var(--f-antiqua)", "1.09375rem", "1.55", ".8em"),
}
# Code font choices (data-code-font). Not set: Maple Mono.
CODE_FONTS = {"maple": "var(--f-maple)", "jetbrains": "var(--f-jetbrains)", "system": "var(--f-system-mono)"}
TEXT_SIZES = [90, 100, 112, 125]

# ------------------------------------------------------------------ palettes
# bg: transcript canvas · panel: sidebar/topbar/drawer · well: sunk fields · raise: cards, composer, key face
# key-top/key-bot/key-deep: a tactile key's face gradient and its lip (unused by Flat)
NACHTZUG = {
    "light": dict(
        bg="#f5f2eb", panel="#ece8df", well="#e5dfd2", raise_="#fbf8f1", fg="#2b2623", dim="#665c54", faint="#70675e",
        line="#d9d0c1", line_strong="#c9bfae", accent="#a9270a", accent_ink="#fff8ee", accent_hi="#c72e0c", accent_deep="#711a07",
        link="#ab4c25", ok="#5a6b24", warn="#b8801f", err="#a9270a", violet="#3d5a80",
        add_bg="rgba(90,107,36,.13)", add_fg="#4a5a1c", del_bg="rgba(169,39,10,.10)", del_fg="#a9270a",
        user_bg="#e8dcc6", code_bg="#efeadf", key_top="#f3eee4", key_bot="#e2dacb", key_deep="#8e8274", shade="rgba(110,90,65,.16)",
        heading="#a9270a", scheme="light"),
    "dark": dict(
        bg="#1a1614", panel="#2b2623", well="#141110", raise_="#2f2925", fg="#f3ece0", dim="#c2b3a1", faint="#a18d7e",
        line="#3a322c", line_strong="#57483c", accent="#ed9d24", accent_ink="#2b2623", accent_hi="#ffb33f", accent_deep="#9e6918",
        link="#e9d5a1", ok="#b9c27a", warn="#e9d5a1", err="#e2643b", violet="#d79a8c",
        add_bg="rgba(185,194,122,.13)", add_fg="#c9d08f", del_bg="rgba(226,100,59,.14)", del_fg="#f08a68",
        user_bg="#2f2925", code_bg="#141110", key_top="#3a322c", key_bot="#2f2925", key_deep="#0e0b0a", shade="rgba(0,0,0,.4)",
        heading="#ed9d24", scheme="dark"),
}


def flat(scheme, **p):
    """Flat palettes: the key-* tokens just repeat raise/line so shared rules stay sane."""
    p.setdefault("heading", p["fg"])
    p.setdefault("key_top", p["raise_"])
    p.setdefault("key_bot", p["raise_"])
    p.setdefault("key_deep", p["line_strong"])
    p["scheme"] = scheme
    return p


# Flat colour schemes: (id, name) → light, dark
FLAT = {
    ("neutral", "Neutral"): {
        "light": flat("light",
            bg="#ffffff", panel="#f6f6f7", well="#eeeef0", raise_="#ffffff", fg="#1b1b1f", dim="#4b4b53", faint="#65656e",
            line="#e4e4e7", line_strong="#cfcfd4", accent="#2c5bd0", accent_ink="#ffffff", accent_hi="#3a68dd", accent_deep="#1f449f",
            link="#2552c2", ok="#1d7a3d", warn="#975f00", err="#c3283a", violet="#6a45c0",
            add_bg="rgba(29,122,61,.10)", add_fg="#196b35", del_bg="rgba(195,40,58,.08)", del_fg="#b0222f",
            user_bg="#f3f3f5", code_bg="#f6f6f7", shade="rgba(20,20,30,.10)"),
        "dark": flat("dark",
            bg="#18181b", panel="#1f1f23", well="#121215", raise_="#25252a", fg="#ececef", dim="#b6b6be", faint="#9a9aa4",
            line="#2d2d33", line_strong="#41414a", accent="#7ca3ff", accent_ink="#0e1320", accent_hi="#93b4ff", accent_deep="#4d72cc",
            link="#91b3ff", ok="#62c585", warn="#e1b04c", err="#ff7c87", violet="#b89eff",
            add_bg="rgba(98,197,133,.12)", add_fg="#7ad69a", del_bg="rgba(255,124,135,.11)", del_fg="#ff929b",
            user_bg="#25252a", code_bg="#131316", shade="rgba(0,0,0,.45)"),
    },
    ("harbour", "Harbour"): {
        "light": flat("light",
            bg="#f7f9fb", panel="#edf1f5", well="#e4eaf0", raise_="#ffffff", fg="#13202d", dim="#415267", faint="#566679",
            line="#d9e1ea", line_strong="#c0ccd9", accent="#0d6b88", accent_ink="#ffffff", accent_hi="#117a9a", accent_deep="#094e64",
            link="#1a5ca3", ok="#1b7651", warn="#8c5c00", err="#b6313e", violet="#5a4eb3",
            add_bg="rgba(27,118,81,.10)", add_fg="#176845", del_bg="rgba(182,49,62,.08)", del_fg="#a72b37",
            user_bg="#e9eff5", code_bg="#eef2f6", shade="rgba(15,35,60,.10)"),
        "dark": flat("dark",
            bg="#0f1720", panel="#141e29", well="#0a1118", raise_="#192532", fg="#e2eaf2", dim="#a9b8c8", faint="#8e9fb2",
            line="#223142", line_strong="#33475d", accent="#4cc0d8", accent_ink="#06171c", accent_hi="#6ccde1", accent_deep="#2c8ea3",
            link="#80b9ff", ok="#5bc99a", warn="#e5b65a", err="#ff8088", violet="#a9a2ff",
            add_bg="rgba(91,201,154,.12)", add_fg="#74d6ab", del_bg="rgba(255,128,136,.11)", del_fg="#ff969c",
            user_bg="#192532", code_bg="#0b1219", shade="rgba(0,0,0,.45)"),
    },
    ("moss", "Moss"): {
        "light": flat("light",
            bg="#f7f8f4", panel="#eef0e8", well="#e5e8dc", raise_="#fdfdfb", fg="#1b2119", dim="#465142", faint="#5b6656",
            line="#dce0d2", line_strong="#c4cab8", accent="#3a7529", accent_ink="#ffffff", accent_hi="#43832f", accent_deep="#2a561e",
            link="#2c6385", ok="#2f7524", warn="#876000", err="#b0392d", violet="#694b9b",
            add_bg="rgba(47,117,36,.11)", add_fg="#2a6920", del_bg="rgba(176,57,45,.09)", del_fg="#a33428",
            user_bg="#ebeee3", code_bg="#eff1ea", shade="rgba(30,40,20,.10)"),
        "dark": flat("dark",
            bg="#141812", panel="#1a1f17", well="#0e110c", raise_="#20261d", fg="#e5ebde", dim="#b1bba7", faint="#97a28c",
            line="#283023", line_strong="#3a4431", accent="#9ccd6c", accent_ink="#141a0d", accent_hi="#afd887", accent_deep="#6d9c42",
            link="#8cc3e2", ok="#8fd06f", warn="#e2bb5c", err="#ff8a78", violet="#c3a6ef",
            add_bg="rgba(143,208,111,.12)", add_fg="#a2da86", del_bg="rgba(255,138,120,.11)", del_fg="#ff9f90",
            user_bg="#20261d", code_bg="#0f120d", shade="rgba(0,0,0,.45)"),
    },
    ("plum", "Plum"): {
        "light": flat("light",
            bg="#faf8fb", panel="#f3eff5", well="#ebe5ee", raise_="#ffffff", fg="#221a29", dim="#53475d", faint="#695d73",
            line="#e3dbe8", line_strong="#cdc1d5", accent="#8a3ea7", accent_ink="#ffffff", accent_hi="#984ab6", accent_deep="#652d7b",
            link="#5a47be", ok="#2b7a4e", warn="#915f0a", err="#bf2f4e", violet="#7944ae",
            add_bg="rgba(43,122,78,.10)", add_fg="#246a43", del_bg="rgba(191,47,78,.08)", del_fg="#ac2945",
            user_bg="#f1ecf4", code_bg="#f4f0f6", shade="rgba(40,20,50,.10)"),
        "dark": flat("dark",
            bg="#1a1520", panel="#211a28", well="#130f18", raise_="#271f2f", fg="#f0e9f4", dim="#c1b4ca", faint="#a596b0",
            line="#33293b", line_strong="#473a52", accent="#d29bef", accent_ink="#1f1029", accent_hi="#dcb0f3", accent_deep="#9c66bb",
            link="#b4aaff", ok="#6fcf98", warn="#e8bb63", err="#ff8299", violet="#d9a8ff",
            add_bg="rgba(111,207,152,.12)", add_fg="#86d9aa", del_bg="rgba(255,130,153,.11)", del_fg="#ff98ab",
            user_bg="#271f2f", code_bg="#140f19", shade="rgba(0,0,0,.45)"),
    },
    ("contrast", "High contrast"): {
        "light": flat("light",
            bg="#ffffff", panel="#f2f2f2", well="#ffffff", raise_="#ffffff", fg="#000000", dim="#1f1f1f", faint="#363636",
            line="#5c5c5c", line_strong="#000000", accent="#0038b8", accent_ink="#ffffff", accent_hi="#0030a0", accent_deep="#00226f",
            link="#0033a8", ok="#005e1b", warn="#6e4200", err="#a8001e", violet="#4e1a9e",
            add_bg="rgba(0,94,27,.12)", add_fg="#00561a", del_bg="rgba(168,0,30,.09)", del_fg="#9a001b",
            user_bg="#f2f2f2", code_bg="#f5f5f5", shade="rgba(0,0,0,.25)"),
        "dark": flat("dark",
            bg="#000000", panel="#0e0e0e", well="#000000", raise_="#141414", fg="#ffffff", dim="#e8e8e8", faint="#cfcfcf",
            line="#a8a8a8", line_strong="#ffffff", accent="#8ab8ff", accent_ink="#000000", accent_hi="#a8caff", accent_deep="#5a8fe0",
            link="#94c6ff", ok="#72e890", warn="#ffd45c", err="#ff8a8a", violet="#ccadff",
            add_bg="rgba(114,232,144,.16)", add_fg="#7ff09a", del_bg="rgba(255,138,138,.15)", del_fg="#ffa0a0",
            user_bg="#141414", code_bg="#0a0a0a", shade="rgba(0,0,0,.6)"),
    },
}
HIGH_CONTRAST = {"contrast"}

# Accent presets for Flat: (id, name) → (light, dark). The text colour on them is
# picked here (white or near-black, whichever reads better) and checked.
ACCENTS = {
    ("blue", "Blue"):     ("#2457d6", "#7aa4ff"),
    ("teal", "Teal"):     ("#0b6e7e", "#3fc4cf"),
    ("green", "Green"):   ("#2c7a35", "#6fd27c"),
    ("amber", "Amber"):   ("#9a5800", "#f0b13c"),
    ("red", "Red"):       ("#c0263c", "#ff7f8c"),
    ("violet", "Violet"): ("#7040c4", "#b597ff"),
}
INK_LIGHT, INK_DARK = "#ffffff", "#111111"


# ------------------------------------------------------------------ contrast
def _rgb(hexcol):
    h = hexcol.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def luminance(hexcol):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in _rgb(hexcol))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def ink_for(col):
    return max((INK_LIGHT, INK_DARK), key=lambda ink: contrast(col, ink))


def check(name, p, high=False):
    """Returns a list of failures: (pair, ratio, needed)."""
    bad = []

    def need(fg, bg, ratio):
        r = contrast(p[fg], p[bg])
        if r < ratio:
            bad.append((f"{fg.rstrip('_')} on {bg.rstrip('_')}", r, ratio))

    text = 7.0 if high else 4.5
    for bg in ("bg", "panel", "raise_"):
        for fg in ("fg", "dim", "faint"):
            need(fg, bg, text)
        need("link", bg, 4.5)
    # the active sidebar row and code wells sit on `well`; their secondary text is dim
    for fg in ("fg", "dim"):
        need(fg, "well", text)
    need("accent", "bg", 3.0)
    need("accent_ink", "accent", 4.5)
    need("add_fg", "bg", 4.5)
    need("del_fg", "bg", 4.5)
    return [(name, *b) for b in bad]


def run_checks():
    failures, report = [], []

    def one(name, p, high=False):
        f = check(name, p, high)
        failures.extend(f)
        worst = min(contrast(p[t], p["bg"]) for t in ("fg", "dim", "faint"))
        report.append(f"  {'FAIL' if f else 'ok  '} {name:<24} faint/bg {contrast(p['faint'], p['bg']):.2f}  "
                      f"worst text/bg {worst:.2f}  accent/bg {contrast(p['accent'], p['bg']):.2f}")

    for mode, p in NACHTZUG.items():
        one(f"nachtzug {mode}", p)
    for (sid, _), modes in FLAT.items():
        for mode, p in modes.items():
            one(f"flat {sid} {mode}", p, sid in HIGH_CONTRAST)
    # accent presets: ≥ 3:1 on every Flat background of that mode, text on them ≥ 4.5:1
    for (aid, _), cols in ACCENTS.items():
        for mode, col in zip(("light", "dark"), cols):
            ink = ink_for(col)
            if contrast(ink, col) < 4.5:
                failures.append((f"accent {aid} {mode}", f"ink on {col}", contrast(ink, col), 4.5))
            for (sid, _), modes in FLAT.items():
                r = contrast(col, modes[mode]["bg"])
                if r < 3.0:
                    failures.append((f"accent {aid} {mode}", f"{col} on flat {sid} bg", r, 3.0))
    return failures, report


# ------------------------------------------------------------------ CSS
def tokens(p, indent="  "):
    lines = [f"{indent}--{k.rstrip('_').replace('_', '-')}: {v};" for k, v in p.items() if k != "scheme"]
    lines.append(f"{indent}color-scheme: {p['scheme']};")
    return "\n".join(lines)


def three(sel, light, dark):
    """sel must be a single selector; returns the light, forced-dark and system-dark blocks."""
    return [
        f"{sel} {{\n{light}\n}}",
        f'{sel}[data-theme="dark"] {{\n{dark}\n}}',
        f'@media (prefers-color-scheme: dark) {{\n  {sel}:not([data-theme="light"]) {{\n{dark}\n  }}\n}}',
    ]


def build_css():
    out = ["/* generated by tools/gen_themes.py: do not edit by hand */"]
    for look, f in LOOK_FONTS.items():
        out.append(f':root[data-look="{look}"] {{\n' + "\n".join(f"  --{k}: {v};" for k, v in f.items()) + "\n}")

    out.append("/* ---- Nachtzug */")
    out += three(':root[data-look="nachtzug"]', tokens(NACHTZUG["light"]), tokens(NACHTZUG["dark"], "    "))

    for (sid, sname), modes in FLAT.items():
        out.append(f"/* ---- Flat · {sname} */")
        sel = f':root[data-look="flat"][data-scheme="{sid}"]'
        out.append(f"{sel} {{\n{tokens(modes['light'])}\n}}")
        out.append(f'{sel}[data-theme="dark"] {{\n{tokens(modes["dark"])}\n}}')
        out.append(f'@media (prefers-color-scheme: dark) {{\n  {sel}:not([data-theme="light"]) {{\n{tokens(modes["dark"], "    ")}\n  }}\n}}')

    # accent presets as variables; the page points --accent at one of them (theme.js)
    def acc(mode, indent):
        i = 0 if mode == "light" else 1
        return "\n".join(f"{indent}--acc-{aid}: {c[i]};\n{indent}--acc-{aid}-ink: {ink_for(c[i])};" for (aid, _), c in ACCENTS.items())
    out.append("/* ---- Flat accent presets */")
    sel = ':root[data-look="flat"]'
    out.append(f"{sel} {{\n{acc('light', '  ')}\n}}")
    out.append(f'{sel}[data-theme="dark"] {{\n{acc("dark", "  ")}\n}}')
    out.append(f'@media (prefers-color-scheme: dark) {{\n  {sel}:not([data-theme="light"]) {{\n{acc("dark", "    ")}\n  }}\n}}')

    out.append("/* ---- fonts and text size (Settings → Appearance) */")
    for fid, (fam, size, lh, code) in UI_FONTS.items():
        out.append(f':root[data-ui-font="{fid}"] {{ --ui: {fam}; --prose: {fam}; --head: {fam}; '
                   f'--prose-size: {size}; --prose-lh: {lh}; --code-em: {code}; }}')
    for fid, fam in CODE_FONTS.items():
        out.append(f':root[data-code-font="{fid}"] {{ --mono: {fam}; }}')
    out.append(":root { font-size: 100%; }")
    for s in TEXT_SIZES:
        if s != 100:
            out.append(f':root[data-text-size="{s}"] {{ font-size: {s}%; }}')
    return "\n\n".join(out) + "\n"


def main():
    failures, report = run_checks()
    print("contrast:")
    print("\n".join(report))
    if failures:
        print(f"\n{len(failures)} contrast failure(s):", file=sys.stderr)
        for name, pair, ratio, needed in failures:
            print(f"  {name}: {pair} is {ratio:.2f}:1, needs {needed}:1", file=sys.stderr)
        print("web/themes.css was not written.", file=sys.stderr)
        sys.exit(1)
    Path(__file__).resolve().parent.parent.joinpath("web/themes.css").write_text(build_css())
    print("wrote web/themes.css")


if __name__ == "__main__":
    main()
