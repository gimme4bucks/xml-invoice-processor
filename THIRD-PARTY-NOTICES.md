# Third-party notices

This project uses the third-party software and artifacts below to validate Peppol BIS Billing 3.0
invoices ([ADR 0001](docs/adr/0001-peppol-bis-billing-3-official-rules-saxonjs.md)). npm packages
under permissive open-source licences are listed in `pnpm-lock.yaml`; this file covers the
components whose licences ask for a notice or that are not ordinary dependencies.

`apps/service/validation-artifacts/manifest.json` lists the source URL and sha256 of every
artifact.

## SaxonJS (`saxon-js`, `xslt3`), Saxonica Ltd

`saxon-js` 2.7.0 runs the Schematron rules (runtime dependency); `xslt3` 2.7.0 compiles them to
SEF at build time. Both are free of charge but proprietary, not open source. They are installed
from npm as dependencies and are never vendored in this repository. A container image may contain
them unmodified, as part of this application. The notice and disclaimer below are reproduced from
their `LICENSE.txt` ("Version 1.0, June 2020"), as its redistribution condition 1 requires.

> Copyright: The copyright in the Software belongs to Saxonica Ltd, except for third-party
> components listed in the documentation that are distributed under license.
>
> DISCLAIMER. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS." ANY
> EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
> COPYRIGHT HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
> EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
> GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
> ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
> OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

The full licence text is in `node_modules/saxon-js/LICENSE.txt` after `pnpm install`.

## OASIS Universal Business Language (UBL) 2.1

The runtime schemas in `apps/service/validation-artifacts/ubl-2.1/xsdrt/` (the Invoice and
CreditNote main schemas and the common schemas they import) are copied unmodified from the UBL 2.1
OASIS Standard. Copyright © OASIS Open 2001-2013. All Rights Reserved. The OASIS
notice is reproduced in `apps/service/validation-artifacts/ubl-2.1/NOTICE.txt`.

## CEN EN 16931 validation artifacts 1.3.16 (EUPL-1.2)

`apps/service/validation-artifacts/en16931-ubl-1.3.16/EN16931-UBL-validation.xslt` is copied
unmodified from the CEN/TC 434 validation artifacts release `validation-1.3.16`
(https://github.com/ConnectingEurope/eInvoicing-EN16931). It is licensed under the European Union
Public Licence 1.2; the licence text is in `LICENSE-EUPL-1.2.txt` next to it.

## SchXslt2 1.11.2 (MIT)

Used at build time only, to transpile the Peppol Schematron to XSLT. It is downloaded by
`apps/service/scripts/validation/fetch-and-compile.sh` and not committed.

> MIT License
>
> Copyright (c) David Maus
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## OpenPeppol BIS Billing 3.0 rules (3.0.22)

`PEPPOL-EN16931-UBL.sch` is published by OpenPeppol AISBL without a licence. It is therefore not
committed to this repository: `fetch-and-compile.sh` downloads it at build time from a pinned URL,
verifies its sha256 and compiles it, unmodified, into a SEF under
`apps/service/validation-artifacts/generated/` (gitignored). The business terms in it are
"reproduced with permission from CEN".

## libxml2-wasm (MIT)

`libxml2-wasm` 0.7.2 (MIT, Copyright (c) 2023 James Lan) parses invoices and validates them
against the UBL XSD. It bundles libxml2 (MIT, Copyright (C) 1998-2012 Daniel Veillard and the
Libxml2 Contributors); both licence texts ship with the npm package.
