# Third-Party Notices

## Mozilla PDF.js 5.6.205

Hana Paper Reader includes a bundled browser module at `assets/pdfjs.mjs` derived from Mozilla PDF.js 5.6.205 (build `ada343803`). It is used only to render the user-selected local PDF as an original-page visual reference and fallback crop source.

PDF.js is developed by Mozilla and PDF.js contributors:

- Project: <https://github.com/mozilla/pdf.js>
- Version: 5.6.205
- License: Apache License 2.0
- License copy: `licenses/PDFJS-APACHE-2.0.txt`

The bundled file is a minified/bundled distribution form. Hana Paper Reader does not claim ownership of PDF.js. Apache License 2.0 terms continue to apply to that component.

No PaperQuay source code is included in this version.

## Hana Paper Reader v2 App components

The v2 candidate in apps/hana-paper-reader retains the OpenHanako/HanaAgent 0.1050.9 App SDK distribution, under Apache License 2.0.
Upstream: https://github.com/liliMozi/openhanako.
See apps/hana-paper-reader/sdk/LICENSE, sdk/NOTICE, sdk/THIRD_PARTY_NOTICES.txt and the retained .LEGAL.txt files.

The v2 PDF renderer also uses Mozilla PDF.js 5.6.205. Its matching CMap and standard-font distribution files retain their individual license files, including the CMap, Foxit and Liberation notices.
The Apache license copy is also included under apps/hana-paper-reader/assets/licenses/PDFJS-APACHE-2.0.txt.
The compiled App UI bundle retains ui/assets/THIRD_PARTY_NOTICES.txt and app-ui.js.LEGAL.txt.
