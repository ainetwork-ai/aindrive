# Bundled fonts

The existing UI fonts are bundled for builds without network access.
Source: Google Fonts, commit `9710da1eacb3be272583c3224dcb70f9da6eadbb`. Each family includes its SIL Open Font License. License files have trailing
whitespace removed; SHA-256 values below describe the bundled files.

- `Inter-Variable.ttf`: [source](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf); SHA-256 `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`
- `inter-OFL.txt`: [source](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/OFL.txt); SHA-256 `5dd548d31a85f756e01d63e00d7faf1e324103ed3e9102fcbbabf2cc2db6dd39`
- `InstrumentSerif-Regular.ttf`: [source](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/instrumentserif/InstrumentSerif-Regular.ttf); SHA-256 `498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88`
- `InstrumentSerif-Italic.ttf`: [source](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/instrumentserif/InstrumentSerif-Italic.ttf); SHA-256 `08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385`
- `instrumentserif-OFL.txt`: [source](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/instrumentserif/OFL.txt); SHA-256 `b6b2292aa580937fb63796878d65a027a27f8c3db2d97601d0c34d9031f4ca17`

`app/layout.tsx` loads these files with `next/font/local`; neither builds nor
browsers need Google Fonts. Keep the files inside `web/` for the isolated Docker
build. Inter retains its 100–900 weight range; Instrument Serif includes real
normal and italic faces. Both use `display: swap` and Next's measured fallback
metrics (Arial for sans, Times New Roman for display), followed by explicit
system/generic fallbacks. Existing CSS variables and Tailwind consumers stay
unchanged. Missing glyphs, including Korean, fall back to installed system fonts.

The complete TTFs total about 994 KiB before transfer compression, larger than
Google's subset WOFF2s. The same font families are preserved, but exact line
breaks can vary with font revision and installed fallback fonts; check narrow
screens when reviewing typography. Regression coverage lives in
`lib/__tests__/offline-fonts.test.ts` and exercises the actual Next font loader.

Browser regression: from `web/`, run `npm run build`, then
`./node_modules/.bin/playwright test --config offline-fonts.playwright.config.ts`.
The host must already have Playwright Chromium and a Hangul-capable system font
(for example, Noto Sans CJK or WenQuanYi Zen Hei). Linux also requires
Fontconfig (`fc-match`); the suite never downloads dependencies. It starts its
own production Next server on loopback port 3738 and uses isolated data under
`.aindrive/offline-fonts`. No account or running agent is required.

`e2e/offline-fonts.spec.ts` checks the real landing and login pages at 320px and
1280px, both with local fonts and with every font request aborted in a fresh
browser context. All external requests are blocked. It checks text clipping and
horizontal overflow, including the expanded terminal instructions, and attaches
full-page screenshots. The instructions wrap long comments on narrow screens
without changing their copyable text. Typography specimens
inside the landing layout exercise its real CSS variables for Korean and the
normal/italic display faces (the current public-page copy is English and sans).
Chromium's painted-font inspection verifies actual local face selection and
system Hangul/failure fallback, alongside loaded/error FontFace states. On Linux,
`e2e/system-font-coverage.ts` checks the painted system families against Fontconfig
character coverage, requiring every Hangul character in the specimen as well as
the painted glyph count. This accepts capable families without a name allowlist
and rejects missing glyphs or Fontconfig substitutions. Parser regressions live
in `lib/__tests__/system-font-coverage.test.ts`. A missing system font remains a
test failure; it is not skipped or replaced with a test-only web font.
