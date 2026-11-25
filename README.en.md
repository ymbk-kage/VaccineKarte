# VaccineKarte

[日本語](README.md)

VaccineKarte is a **read-only** web portal for searching and viewing a vaccine pre-screening form database that lives in a Google Spreadsheet (one row per patient visit), from reception PCs and smartphones. A single static UI (`Public/`) is shared by two interchangeable backends: a **Cloudflare Worker** (`Src/`) that runs behind Cloudflare Access, and a **PHP backend** (`Php/`) for ordinary shared web hosting. The PHP port of the search, normalisation and row-mapping logic is checked against the JavaScript original by a parity suite (1015 cases) that requires byte-for-byte identical JSON output. The portal never writes to the spreadsheet.

The UI text, the sheet headers and the design document are in Japanese.

## Features

- **Normalised search**: differences in full-width/half-width characters (NFKC), letter case and katakana/hiragana are ignored, as are spaces, all common hyphen/dash variants, the long-vowel mark "ー" and slashes. "山田太郎" finds "山田　太郎", and a phone number typed without hyphens finds "090-0000-0001". Free-text terms are space-separated and ANDed, and match across every column plus the notes column.
- **Filters**: vaccine kind (インフルエンザ / コロナ), category (任意 / 公費), visit-date and birth-date ranges, age range, and "flagged only". Sort by visit date (newest or oldest first), furigana, or row number (descending). 50 results per page (the API accepts up to 200).
- **Review flags from cell colours**: red, yellow and orange cell backgrounds (including colours produced by conditional formatting) are shown as dots in the result list and next to each affected field in the detail view. A row's level is its worst flag (red > orange > yellow).
- **Attachments**: Google Drive links placed in cells (whole-cell links, links on part of the text, and smart chips) are fetched by the server with the service account and displayed inline as images or PDFs. Supported types are JPEG, PNG, WebP and PDF, up to 20 MB each. JPEG and PNG are converted to WebP and served as WebP only when that is smaller (Cloudflare Images binding on the Worker, GD on PHP). The browser can only ask for "row number + attachment index", so the server cannot be used as a proxy for arbitrary Drive files. Non-Drive https links are shown as external links.
- Count of other rows sharing the same management number, `tel:` links for phone numbers, keyboard navigation (`/` focuses search, `↑`/`↓`, `Enter`, `Esc`), a bottom sheet on mobile, and light/dark themes.
- **No write access**: the only Google scopes requested are `spreadsheets.readonly` and `drive.readonly`. A leaked key cannot modify the sheet or any file.

## Security design (summary)

See [Docs/Design.md](Docs/Design.md) (in Japanese), especially §1 and §10, for the full threat model and rationale.

- **Fail-closed when authentication is not configured**: the Worker answers every request, static files included, with 503 `access_not_configured` if `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty. The PHP backend does the same when Basic authentication did not run (missing or broken `.htaccess`).
- **JWT re-verification inside the Worker**: in addition to Cloudflare Access in front, the Worker itself verifies the `Cf-Access-Jwt-Assertion` header (RS256; `iss`, `aud`, `exp` checked). It does not trust the cookie or the `Cf-Access-Authenticated-User-Email` header. `workers.dev` and preview URLs are disabled.
- **Local development bypass needs two conditions**: the bypass flags (`DEV_BYPASS_ACCESS` / `DEV_BYPASS_AUTH`) and fixture mode only take effect when the flag is set **and** the hostname is `localhost` / `127.0.0.1`. On PHP these flags are read only under PHP's built-in server.
- **Search terms never appear in URLs**: search criteria are sent only in the JSON body of `POST /api/search`, so request-URL logging cannot capture patient names. A non-JSON `Content-Type` gets 400 and a cross-origin `Origin` header gets 403.
- **Only matching rows are returned**: searching happens on the server. The list returns summary fields only and details are fetched one record at a time; the whole database is never sent to the browser.
- **Read-only Google scopes**, as above.
- **Strict response headers**: a strict Content-Security-Policy (no inline scripts or inline styles), `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`, `nosniff`, HSTS and more. Attachments are served with a neutral file name and, for images, a `sandbox` CSP.
- **No identifiers in logs**: the one-line-per-request JSON log never contains search terms, patient fields, row numbers or Drive file IDs.
- **Caching**: the Worker keeps data only in isolate memory for 60 seconds (no KV, no Cache API). The PHP backend encrypts its on-disk cache with AES-256-GCM.
- **Double deny on PHP `Private/`**: `Private/.htaccess` (`Require all denied`, repeated inside an `<If>` block) and the root `.htaccess` rule `RewriteRule ^Private(/|$) - [F]` both return 403, even to authenticated users. The service-account key is stored as a `.php` file, so it can never be served as a static file even if a deny rule breaks.
- **HTTPS only**: the PHP backend redirects plain HTTP to HTTPS before it asks for the password.

## Expected spreadsheet columns

Row 1 of a single worksheet (named `患者管理` by default; configurable) must contain these 19 headers in columns A–S, **in this order and with exactly this text**. Otherwise the portal returns 503 `sheet_layout_changed` rather than showing misaligned data.

| Col | Header | Col | Header |
|---|---|---|---|
| A | 区分 (category) | K | 保護者署名 (guardian signature) |
| B | 管理番号 (management number) | L | 郵便番号 (postal code) |
| C | 種別 (vaccine kind) | M | 住所 (address) |
| D | 受診日 (visit date) | N | 電話番号 (phone) |
| E | 氏名 (name) | O | 希望ワクチン (requested vaccine) |
| F | ふりがな (furigana) | P | 体温 (temperature) |
| G | 生年月日 (birth date) | Q | LOT No. |
| H | 性別 (sex) | R | 60～64歳の方 (aged 60–64) |
| I | 年齢 (age) | S | 自己負担免除対象者 (co-payment exemption) |
| J | 左右 (left/right) | T | 備考 (notes; optional, read only when the header is exactly 「備考」) |

- Category values are `任意` / `公費` and kinds are `インフルエンザ` / `コロナ` (`KINDS` / `CATEGORIES` in `Src/Search.js`).
- Dates are parsed from `2026/10/15`, `2026-10-15`, `2026.10.15` and `20261015`; ages from `13`, `１３` and `13歳`.
- Flag colour thresholds (RGB 0–1): red = r≥0.9, g≤0.25, b≤0.25; yellow = r≥0.9, g≥0.9, b≤0.25; orange = r≥0.9, 0.45≤g≤0.75, b≤0.25. Colours on the header row and the notes column are ignored.
- Rows whose 19 columns are all empty are skipped. Columns from U onwards are not read.

## Quick start with fixture data (no Google account needed)

These run on the 30 synthetic records in `Src/Fixture.js` (no real patient data).

### Worker

Requires Node.js 20+.

```sh
npm ci
cp .dev.vars.sample .dev.vars
# Keep only DEV_BYPASS_ACCESS="1" and FIXTURE_MODE="1" in .dev.vars; delete the GOOGLE_SA_JSON line
npm run dev
```

Open http://localhost:8798 (`npm run dev` runs `wrangler dev --local --port 8798 --env local`). `.dev.vars` is git-ignored.

### PHP

Requires Node.js 20+ (only to export the fixture) and PHP 8.3+ with the `intl`, `mbstring`, `openssl`, `curl` and `gd` (with WebP) extensions.

```sh
node Php/Tools/ExportFixture.mjs        # writes Php/Tests/Fixture/FixtureData.json
```

Then start PHP's built-in server with the environment variables listed in the header comment of `Php/Tools/DevRouter.php`:

```sh
# bash
FIXTURE_MODE=1 DEV_BYPASS_AUTH=1 FIXTURE_DATA_PATH=Php/Tests/Fixture/FixtureData.json \
  php -S 127.0.0.1:8799 Php/Tools/DevRouter.php
```

```powershell
# PowerShell
$env:FIXTURE_MODE = "1"; $env:DEV_BYPASS_AUTH = "1"; $env:FIXTURE_DATA_PATH = "Php/Tests/Fixture/FixtureData.json"
php -S 127.0.0.1:8799 Php/Tools/DevRouter.php
```

Open http://localhost:8799. The encrypted cache and logs go to `Php/Private/Cache/` and `Php/Private/Logs/` by default (both git-ignored); set `VACCINE_CACHE_DIR` / `VACCINE_LOG_DIR` to put them elsewhere. On a PHP install without a php.ini, load the extensions explicitly with `-d extension_dir=... -d extension=intl ...` (`Tests/E2E/RunE2E.py` does this automatically).

## Testing

| Command | What it checks |
|---|---|
| `npm test` | JavaScript unit tests (`node --test Tests/Unit/*.test.js`, no extra dependencies) |
| `php Php/Tests/Unit/RunUnitTests.php` | PHP I/O layer unit tests (cache, auth gate, routing, image variants, headers; no network; exit code = number of failures) |
| `node Php/Tests/Parity/GenerateGolden.mjs` then `php Php/Tests/Parity/RunParity.php` | Byte-for-byte JSON parity between the JS and PHP pure logic (see [Php/Tests/Parity/README.md](Php/Tests/Parity/README.md), Japanese) |
| `python Tests/E2E/RunE2E.py [--backend php]` | Browser end-to-end tests in fixture mode (Worker by default, PHP with `--backend php`) |

The E2E suite needs Playwright for Python (`pip install playwright`) and an installed Google Chrome (`--channel chromium` uses Playwright's bundled Chromium instead). Other options: `--port` (default 8798), `--headed`, `--only 1,3,7`, `--keep-server`. Run `node Php/Tools/ExportFixture.mjs` before using `--backend php`. On failure, HTML and screenshots are saved under `logs/`; the exit code is the number of failed scenarios.

## Google setup (both backends)

1. Create a Google Cloud project and enable the **Google Sheets API** and the **Google Drive API**.
2. Create a service account and download its JSON key. Never commit the key.
3. Share the spreadsheet with the service account's email address (`...@<project>.iam.gserviceaccount.com`) as **Viewer**.
4. If you use attachments, share the Drive folder holding the photos/PDFs with the same service account as **Viewer**. Do not use "Anyone with the link". The service account can read only what is shared with it. HEIC images cannot be displayed; save them as JPEG.

## Deploying the Cloudflare Worker

1. In **Cloudflare Access** (Zero Trust), create a self-hosted application covering every path of your hostname (e.g. `vaccine.example.org`), with an Allow policy such as a list of permitted email addresses. Note the **Application Audience (AUD) Tag**.
2. Edit `wrangler.jsonc`:
   - Change `vaccine.example.org` in `routes` to your own domain (the Custom Domain is created on the first deploy).
   - Set `SHEET_ID` (spreadsheet ID), `SHEET_NAME` (worksheet name), `ACCESS_TEAM_DOMAIN` (e.g. `<team>.cloudflareaccess.com`) and `ACCESS_AUD` (AUD tag) under `vars`. None of these are secrets.
   - **Never** put `DEV_BYPASS_ACCESS` or `FIXTURE_MODE` in `wrangler.jsonc`; they belong in `.dev.vars` only.
3. Store the service-account key as a secret:

   ```sh
   npx wrangler secret put GOOGLE_SA_JSON     # paste the contents of the key JSON
   ```

4. Make sure `npm test` and `npm run e2e` pass, then run `npm run deploy`.
5. **Post-deploy checks (required)**: none of these may return **200**.

   ```sh
   curl -I https://vaccine.example.org/                              # 302 to the Access login
   curl -I https://vaccine.example.org/api/meta                      # 302 / 401 / 403
   curl -I https://vaccine.example.org/api/records/2/attachments/0   # 302
   curl -I https://vaccine-search-portal.<account>.workers.dev/      # DNS failure or 404 / 403
   ```

   Then sign in with a permitted email, confirm that `/api/me` returns your address, and confirm in Workers Logs that no search terms are recorded.

## Deploying on shared PHP hosting

Requires Apache with `.htaccess`, `mod_rewrite`, `mod_headers` and `<If>` support, HTTPS, and PHP 8.3+ with `intl`, `mbstring`, `openssl`, `curl` and `gd` (with WebP).

1. **Upload the files** into the site directory (e.g. the document root of `vaccine.example.org`): `.htaccess`, `Api.php` and `Private/` from `Php/`, plus the files inside `Public/` (`index.html`, `App.js`, `Api.js`, `Render.js`, `Styles.css`, `Favicon.svg`, `Icons.svg`, `Logo.svg`), **all at the same level**. Do not upload `Php/Tests/` or `Php/Tools/`.

   ```
   <site directory>/
   ├─ .htaccess         (Php/.htaccess)
   ├─ Api.php           (Php/Api.php; every /api/* path is rewritten to it)
   ├─ index.html, App.js, Api.js, Render.js, Styles.css, Favicon.svg, Icons.svg, Logo.svg   (contents of Public/)
   └─ Private/
      ├─ .htaccess      (Php/Private/.htaccess)
      ├─ Config.php
      ├─ Lib/*.php
      ├─ .htpasswd      (step 3)
      └─ ServiceAccount.php   (step 4)
   ```

2. Set **`AuthUserFile`** in `.htaccess` to the absolute server path of `Private/.htpasswd` (the placeholder is `/path/to/site/Private/.htpasswd`).
3. **Create `Private/.htpasswd` with bcrypt**, for example:

   ```sh
   htpasswd -B -c Private/.htpasswd <user>
   # without htpasswd
   php -r 'echo "<user>:" . password_hash("<password>", PASSWORD_BCRYPT) . PHP_EOL;' > Private/.htpasswd
   ```

   The Basic-auth user name is what the UI and the logs show as the signed-in user.
4. **Create `Private/ServiceAccount.php` from the key** (do not upload the `.json`):

   ```sh
   php Php/Tools/MakeServiceAccountPhp.php <key.json> > Php/Private/ServiceAccount.php
   ```

   Upload the generated `ServiceAccount.php` into `Private/`. The file is git-ignored.
5. **Point at the spreadsheet**: set `sheetId` in `Private/Config.php`. It reads the `VACCINE_SHEET_ID` environment variable; if your host does not let you set environment variables, write the ID into `Config.php` directly. Change `sheetName` too if your worksheet is not named `患者管理`.
6. Share the spreadsheet and the attachment folder with the service account as **Viewer** (see "Google setup").
7. `Private/Cache/` and `Private/Logs/` are created on first use; PHP needs write permission there.
8. **Post-deploy checks (required)**:

   ```sh
   curl -I http://vaccine.example.org/                         # 301 to HTTPS (before any password prompt)
   curl -I https://vaccine.example.org/                        # 401 (no credentials)
   curl -I https://vaccine.example.org/api/meta                # 401
   curl -I -u <user>:<password> https://vaccine.example.org/Private/Config.php           # 403
   curl -I -u <user>:<password> https://vaccine.example.org/Private/ServiceAccount.php   # 403
   curl -I https://vaccine.example.org/.htaccess               # 401 or 403
   ```

   **Make sure everything under `Private/` returns 403 even with valid credentials.** Then sign in with a browser and check that search and the detail view work.

## Reporting security issues

Please do not open a public issue for vulnerabilities. Follow the process in [SECURITY.md](SECURITY.md).

## Disclaimer

This software is not a certified medical device or an electronic health record (EHR) system and is not intended for clinical decision-making. It handles patient personal data; operators are solely responsible for complying with the privacy laws and healthcare information-security guidelines that apply in their jurisdiction. The software is provided without warranty.

## License

[MIT License](LICENSE)
