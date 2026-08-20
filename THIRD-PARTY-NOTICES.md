# Third-party notices

Loupe ships a static bundle. Everything listed under *Shipped in the bundle* is
served to the browser from this project's own image, so its notice travels with
the distribution. Build-time tooling is listed separately because it is not
distributed; it is recorded anyway so the list matches `package.json`.

Licence texts are reproduced in full at the end of this file and referenced by
name, rather than repeated once per component.

## Ported work

### the-commons-project/shc-web-reader

This project takes FHIR display groundwork from `shc-web-reader`: the shape of
its per-resource renderer registry, and the set of display primitives it
accumulated over years of real payloads (date-precision handling, the
`effective[x]` choice-element mess, quantity, range, ratio, dosage and timing
rendering, person-name and address formatting). Loupe's equivalents in
`src/ui/fhir/` are written fresh in TypeScript rather than copied line for line,
but they are derived from that work, and its notice is retained accordingly.

> MIT License
>
> Copyright (c) 2023 The Commons Project

Source: <https://github.com/the-commons-project/shc-web-reader>. Licence: MIT
(text below).

## Shipped in the bundle

| Component | Version | Licence | Copyright |
| --- | --- | --- | --- |
| [react](https://github.com/facebook/react) | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [react-dom](https://github.com/facebook/react) | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT | Copyright (c) 2019 Paul Henschel |
| [clsx](https://github.com/lukeed/clsx) | 2.1.1 | MIT | Copyright (c) Luke Edwards |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | 3.6.0 | MIT | Copyright (c) 2021 Dany Castillo |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | Copyright (c) 2012 Ryan Day |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.33.0 | ISC | Copyright (c) 2026 Lucide Icons and Contributors |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) | 3.1.3 | MIT | Copyright (c) 2023 Ze-Zheng Wu |
| [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (compiled into `zxing_reader.wasm`) | as bundled by zxing-wasm 3.1.3 | Apache-2.0 | Copyright (c) the zxing-cpp contributors and the ZXing Authors |
| [Geist](https://github.com/vercel/geist-font) (via `@fontsource-variable/geist`) | 5.3.0 | OFL-1.1 | Copyright 2024 The Geist Project Authors |
| [Geist Mono](https://github.com/vercel/geist-font) (via `@fontsource-variable/geist-mono`) | 5.3.0 | OFL-1.1 | Copyright 2024 The Geist Project Authors |

Three of those rows need a sentence each.

**lucide-react** is ISC, not MIT, and the icon set descends from Feather:
*Copyright (c) 2013-present Cole Bemis*. Both notices are kept.

**zxing-cpp** reaches the bundle as a compiled WebAssembly binary inside
`zxing-wasm`, so the Apache-2.0 obligations apply to the shipped `.wasm` even
though nothing in this repository is written in C++. Apache-2.0 requires the
licence to travel with the distribution and requires modifications to be stated:
this project makes none, and compiles nothing, it serves the binary
`zxing-wasm` publishes. The upstream project ships no `NOTICE` file. The full
licence is at <https://www.apache.org/licenses/LICENSE-2.0>.

**The two font families are self-hosted deliberately.** They are `package.json`
devDependencies, but `@fontsource` packages are imported for their side effect and
the font files land in `dist/`, so the SIL Open Font Licence 1.1 applies to what
is distributed. The relevant OFL condition for this use is that the fonts may be
bundled and redistributed with the copyright notice retained, and that the
Reserved Font Name is not used for a modified version. Loupe modifies neither
font. The full licence is at <https://openfontlicense.org>.

## Build-time only, not distributed

`typescript`, `vite`, `@vitejs/plugin-react`, `vitest`, `eslint`,
`typescript-eslint`, `eslint-plugin-react-hooks`, `prettier`, `tailwindcss` and
`@tailwindcss/vite` are MIT, except `@types/*` packages from DefinitelyTyped,
which are also MIT. None of them appears in the output beyond the CSS Tailwind
generates from this project's own classes, which is not a copyrightable part of
Tailwind.

## Terminology: nothing is shipped today

Loupe ships **no** SNOMED CT or LOINC content: no code system snapshot, no value
set expansion, no display-name table. Codes it shows come from the payload being
inspected, and any lookup is a live call to a terminology server the user chose.

Should that ever change, both notices travel with the data and belong here:

- **SNOMED CT.** The SNOMED Global Patient Set is available under a CC BY 4.0
  attribution licence; see <https://www.snomed.org/gps>. Any wider SNOMED CT
  content requires an affiliate licence, and in Australia is covered by the NCTS
  licence rather than by GPS.
- **LOINC.** LOINC is copyright (c) 1995 Regenstrief Institute, Inc. and the
  LOINC Committee, and available at no cost under the licence at
  <http://loinc.org/terms-of-use>.

A pull request that adds a terminology snapshot adds the corresponding notice in
the same change, and states which subset is included.

---

## MIT License

Applies to each component above marked MIT, with that component's own copyright
line.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License

Applies to `lucide-react`, with the copyright lines above.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Apache License 2.0

Applies to `zxing-cpp` as compiled into the bundled WebAssembly binary. The full
text is at <https://www.apache.org/licenses/LICENSE-2.0> and is reproduced in
`node_modules/zxing-wasm`'s upstream repository.

## SIL Open Font License 1.1

Applies to the Geist and Geist Mono font files in `dist/`. The full text ships in
`node_modules/@fontsource-variable/geist/LICENSE` and
`node_modules/@fontsource-variable/geist-mono/LICENSE`, and is published at
<https://openfontlicense.org>.
