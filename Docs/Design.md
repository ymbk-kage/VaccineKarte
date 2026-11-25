# ワクチン予診票データベース 検索ポータル 設計書（v1）

対象: リポジトリ直下（`VaccineKarte/`）．Worker 版は `Src/`＋`Public/`，共用 PHP サーバ版は `Php/`＋`Public/`．

## 0. 結論（一枚要約）

- **何を作るか**: Google スプレッドシートのワークシート（既定名 `患者管理`．設定で変更可）にある予診票DBを，受付PCとスマホから検索・閲覧するだけの読み取り専用Webアプリ．スプレッドシートの見た目を一切持ち込まない．
- **どこで動くか**: Cloudflare Workers（`vaccine.example.org`，Custom Domain）．静的画面も API も同じ Worker が配り，`run_worker_first = true` で全リクエストを認証ゲートに通す．Workers を使えない環境向けに，同じ API を PHP に移植した共用レンタルサーバ版（Apache の Basic 認証の背後で動く）も用意する（§6-2）．
- **誰が入れるか**: Cloudflare Access（メールOTP，許可リスト）．加えて Worker 内で `Cf-Access-Jwt-Assertion` を検証する二重化．設定未完了なら全拒否（fail-closed）．
- **データはどう流れるか**: Worker がサービスアカウントで Sheets API を読み，60秒だけアイソレート内メモリに保持．検索はサーバ側で行い，ブラウザには一致分（1ページ50件の要約）しか渡さない．
- **検索の仕様**: スプレッドシート上の検索用シートで行う程度の検索と同等以上（AND・空欄無視・正規化部分一致・日付/年齢範囲・種別/区分完全一致）＋全項目横断キーワード＋「要確認のみ」．
- **検証**: `node --test` の単体テスト（I/O を持たない純関数を網羅）＋ PHP の単体テストと JS⇔PHP のパリティテスト＋ Playwright(Python) の E2E（合成データのフィクスチャモード．実PIIを使わない．Worker 版・PHP 版の両方）．
- **v1.1 追補（§10）**: セルに貼られた Google ドライブのリンク（予診票の写真・PDF）を，Worker がサービスアカウントで代理取得してドロワー内に表示する．職員側の追加共有は不要．スコープは読み取り専用のまま．

## 1. 脅威モデルと安全設計

### 1-1. 守るもの・想定する敵

| 資産 | 氏名・ふりがな・生年月日・住所・電話番号・保護者署名（要配慮に準ずる個人情報，数千件/シーズン） |
|---|---|
| 敵1 | URL を知った外部者（検索エンジン・リンク漏れ・workers.dev 推測） |
| 敵2 | 退職者など許可リストから外れた元職員 |
| 敵3 | 設定ミス（Access 未適用・変数未設定）によって偶然開いてしまう状態 |
| 敵4 | 職員端末のブラウザ履歴・キャッシュ・共用PCからの覗き見 |

### 1-2. 多層防御の確定事項

1. **Access を前段に置く**（敵1・2）．Application は hostname `vaccine.example.org` 全パス，Policy は Allow / Emails(許可リスト)，セッション 24h．
2. **Worker 内で JWT を再検証する**（敵3）．`Cf-Access-Jwt-Assertion` ヘッダを RS256 で検証する．Cookie `CF_Authorization` は読まない（ヘッダは Access を経由した証拠であり，Cookie は偽装余地が広いため）．
   - JWKS: `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`（アイソレート内メモリで1時間保持．未知の `kid` なら1回だけ再取得）．
   - 検査: `alg=RS256`／`iss === https://${ACCESS_TEAM_DOMAIN}`／`aud` 配列に `ACCESS_AUD` を含む／`exp > now`／`nbf,iat` は60秒の許容．利用者メールは `email` クレームから取る（`Cf-Access-Authenticated-User-Email` ヘッダは信用しない）．
   - **`ACCESS_TEAM_DOMAIN` または `ACCESS_AUD` が未設定なら 503 `access_not_configured` で全拒否**．静的ファイルも含む．
3. **ローカル開発の迂回は二重条件**: `.dev.vars` に `DEV_BYPASS_ACCESS="1"` が **かつ** リクエストの hostname が `localhost` / `127.0.0.1` のときだけ，固定の疑似利用者 `dev@localhost` として通す．`wrangler.jsonc` の `vars` にはこの名前を書かない（本番に紛れ込む経路を作らない）．本番 hostname は決して localhost にならないため，仮に秘密として誤登録されても効かない．
4. **認証なしURLを作らない**: `workers_dev: false`・`preview_urls: false`．ルートは Custom Domain のみ．
5. **ブラウザ側の痕跡を残さない**（敵4）: HTML と API は `Cache-Control: no-store`．検索語は URL に載せない（`history.replaceState` もしない）．`localStorage` に保存するのはテーマ設定だけ．
6. **セキュリティヘッダ**（全応答に `Src/Http.js` が付与）:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'
Cache-Control: no-store            X-Robots-Tag: noindex, nofollow, noarchive
Referrer-Policy: no-referrer       X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```
   インラインスクリプト・インラインスタイル属性は使わない（CSP で禁止．`Public/index.html` は外部ファイル参照のみ）．
7. **ログの原則**: 1リクエスト1行の JSON（`route, status, email, resultCount, ms, cacheHit`）．**検索語・患者項目・rowNumber の値は書かない**．Sheets API の失敗は HTTP 状態と Google のエラー `status` 文字列のみ．
8. **DB全体をブラウザに渡さない**: 検索はサーバ側．一覧は要約フィールドだけ（§4）．詳細は1件ずつ取得．空クエリは「受診日の新しい順に50件」を返す（受付の典型作業が当日分の照合であり，件数0の画面より実用的．認証済み職員にしか見えないため許容）．

### 1-3. 秘密と設定の置き場

| 名前 | 種別 | 内容 |
|---|---|---|
| `GOOGLE_SA_JSON` | secret | サービスアカウント鍵 JSON の中身そのまま（1秘密で済む） |
| `ACCESS_TEAM_DOMAIN` | var | 例 `<team>.cloudflareaccess.com`（秘密ではない．棚卸しできるよう `wrangler.jsonc` に置く） |
| `ACCESS_AUD` | var | Access Application の AUD タグ（同上） |
| `SHEET_ID` / `SHEET_NAME` | var | スプレッドシート ID（既定は空＝未設定）／ワークシート名（既定 `患者管理`） |
| `ATTACHMENT_FOLDER_NAME` | var | 添付ファイルを置く Drive フォルダの名前（既定 `""`）．`attachment_unavailable` の画面文言にだけ使う（§10-3）．空なら文言はフォルダ名を出さない一般形になる |
| `DEV_BYPASS_ACCESS` / `FIXTURE_MODE` | `.dev.vars` のみ | §1-2(3)・§7-3 |

PHP 版（§6-2）の置き場は次のとおり．`Php/Private/Config.php` が環境変数を読み，未設定なら既定値を使う（サーバで環境変数を設定できなければ `Config.php` に直接書く）．

| 名前（`Config.php` のキー） | 環境変数 | 内容 |
|---|---|---|
| `sheetId` | `VACCINE_SHEET_ID` | スプレッドシート ID（既定 `''`＝未設定） |
| `sheetName` | `VACCINE_SHEET_NAME` | ワークシート名（既定 `患者管理`） |
| `attachmentFolder` | `VACCINE_ATTACHMENT_FOLDER` | Worker の `ATTACHMENT_FOLDER_NAME` と同じ意味（既定 `''`） |
| `serviceAccountPath` | `VACCINE_SA_JSON_PATH` | サービスアカウント鍵（既定 `Private/ServiceAccount.php`．鍵 JSON を返す `.php` ファイルにして，拒否規則が壊れても静的配信されないようにする．`Php/Tools/MakeServiceAccountPhp.php` で作る） |
| `cacheDir` / `logDir` | `VACCINE_CACHE_DIR` / `VACCINE_LOG_DIR` | 暗号化キャッシュとログの置き場（既定 `Private/Cache`・`Private/Logs`） |
| 認証 | （`.htaccess` の `AuthUserFile`） | Basic 認証の `Private/.htpasswd`（bcrypt） |
| `DEV_BYPASS_AUTH` / `FIXTURE_MODE` / `FIXTURE_DATA_PATH` | PHP 組み込みサーバのみ | Worker の迂回フラグ・フィクスチャモードに相当．`Php/Tools/DevRouter.php` 経由で localhost のときだけ効き，Apache 上では読まれない |

## 2. データアクセス

### 2-1. Google 認証（`Src/GoogleAuth.js`）

- SA JSON から `client_email` と `private_key`(PEM) を取り，PEM→DER→`crypto.subtle.importKey("pkcs8", …, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"})`．
- JWT: `{iss: client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat, exp: iat+3600}` を署名し，`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` で `https://oauth2.googleapis.com/token` へ POST．
- アクセストークンは `exp-60s` までアイソレート内メモリに保持．スコープは readonly 固定（v1 は書かない．鍵が漏れても書き換えられない）．

### 2-2. Sheets API 呼び出し（`Src/SheetSource.js`）

**`spreadsheets.get` 1回で値と背景色を同時に取る**（`values.get` では色が取れず，要確認フラグが出せない）．

```
GET https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}
  ?ranges='{SHEET_NAME}'!A1:T&includeGridData=true
  &fields=sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))
```

- `formattedValue` を使う（値は RAW で書かれた文字列なので表示値＝実値．数値化された電話番号も文字列で返る）．
- `effectiveFormat.backgroundColor` は条件付き書式の結果を含むため，年齢の橙も取れる．
- 範囲は A:T（A〜S の固定19列＋T列の備考）．U列以降は読まない．シート名は単引用符で囲み（内部の `'` は `''`），どんな文字を含んでも A1 表記として安全にする．

### 2-3. 見出し検証と行マッピング（`Src/Records.js`，純関数）

```js
export const HEADERS = ["区分","管理番号","種別","受診日","氏名","ふりがな","生年月日","性別","年齢","左右","保護者署名",
  "郵便番号","住所","電話番号","希望ワクチン","体温","LOT No.","60～64歳の方","自己負担免除対象者"];
export const NOTE_HEADER = "備考";                // 20列目（T列）．任意
export function validateHeader(firstRow)          // -> {ok:true} | {ok:false, reason}
export function classifyColor(bg)                 // -> "red"|"yellow"|"orange"|null
export function mapRows(gridRows)                 // -> VaccineRecord[]
```

- `validateHeader`: 先頭19セルを trim して `HEADERS` と完全一致でなければ拒否する（列ずれ防護．理由は `header_mismatch_at_<列番号>`．例: `性別` の無い表は `header_mismatch_at_8`，`左右` の無い表は `header_mismatch_at_10`）．20列目は `備考` のときだけ備考として扱い，それ以外の見出しなら備考は `null`．
- `classifyColor` の閾値（0–1 の RGB）: red = r≥0.9 ∧ g≤0.25 ∧ b≤0.25／yellow = r≥0.9 ∧ g≥0.9 ∧ b≤0.25／orange = r≥0.9 ∧ 0.45≤g≤0.75 ∧ b≤0.25／それ以外 `null`．見出し行と備考列の色は無視．
- `VaccineRecord`:

```ts
{ rowNumber: number,            // シートの行番号（1始まり．空行を飛ばしても変わらない安定ID）
  category, managementNumber, kind, visitDate, name, furigana, birthDate, gender, age, side, guardianName,
  postalCode, address, phone, desiredVaccine, temperature, lotNumber, disability6064, copayExemption: string,
  note: string|null,
  visitDateIso: string|null, birthDateIso: string|null, ageNumber: number|null,   // parseDate / parseInt の結果
  flags: { [field]: "red"|"yellow"|"orange" },  // 色が付いた固定19列のみ
  flagLevel: "red"|"yellow"|"orange"|null,      // 行の最悪値（red > orange > yellow）
  searchText: string }                          // 固定19列＋備考を normalizeText して "|" で連結
```
- 固定19列すべて空の行は捨てる．`gender`（性別）は「男」「女」または空（公費の行だけ記入される）．`side`（左右）は職員が記入する文字列をそのまま持つ．

### 2-4. キャッシュ方針

- アイソレート内メモリのみ．`{records, fetchedAt, headerOk}` を **TTL 60秒**．期限切れ後の最初のリクエストが再取得し，同時到来は1本の Promise を共有する．
- 再取得に失敗したら **10分まで**は古いデータを返し，`meta.stale=true` を付ける（受付中に Google 側の瞬断で検索が止まらないため）．10分超なら 503．
- Cache API・KV・D1 には置かない（PII をアイソレート外に残さない．規模は数千行＝数MB未満でメモリで足りる）．

### 2-5. エラーの対応表（`Src/Http.js` の `errorResponse(code)`）

| code | HTTP | 画面文言（日本語） |
|---|---|---|
| `access_not_configured` | 503 | 認証の設定が完了していません．管理者に連絡してください． |
| `unauthorized` | 401 | ログインが確認できません．ページを再読み込みしてください． |
| `forbidden` | 403 | このアカウントには閲覧権限がありません． |
| `sheet_layout_changed` | 503 | データベースの列構成が変わっています．管理者に連絡してください． |
| `sheet_unavailable` | 503 | データベースに接続できません．しばらくしてから再試行してください． |
| `not_found` | 404 | 該当する記録がありません． |
| `bad_request` | 400 | 検索条件の形式が正しくありません． |
| `attachment_unavailable` | 404 | 設定したフォルダ名の有無で文言が変わる（§10-3）．例: 添付ファイルを開けません．ファイルが Google ドライブの共有フォルダにあり，サービスアカウントに共有されているか確認してください． |
| `attachment_unsupported` / `attachment_too_large` | 415 / 413 | §10-3 |

PHP 版は `Php/Private/Lib/Http.php` に同じ code・HTTP 状態・文言の表を持つ．

## 3. 検索の仕様（`Src/Normalize.js`・`Src/Search.js`，純関数）

### 3-1. 正規化

```js
export function normalizeText(s)   // NFKC → 小文字 → カタカナ(U+30A1–30F6)→ひらがな(-0x60)
                                   // → [空白, -‐‑‒–—―−, ー, /, ／] を除去
export function parseDate(s)       // "2026/10/15" | "2026-10-15" | "2026.10.15" | "20261015" → "2026-10-15" | null
export function parseAge(s)        // "13" | "１３" | "13歳" → 13 | null
```
- 長音「ー」も除去する（手書きふりがなは長音の有無が揺れるため．部分一致の取りこぼしより過剰一致の方が安い）．
- NFKC で旧字体（U+FA1A 祥 など）は統一される．姓名の間の空白は除去されるので「山田太郎」で「山田　太郎」に当たる．

### 3-2. 検索条件と評価

```js
/** @typedef Query {
 *   q?: string,                 // 自由語．空白区切りの各語を AND，各語は searchText の部分一致
 *   name?, furigana?, phone?, address?, managementNumber?, lotNumber?, vaccine?: string, // 正規化部分一致
 *   kind?: "インフルエンザ"|"コロナ", category?: "任意"|"公費",                        // 完全一致
 *   visitFrom?, visitTo?, birthFrom?, birthTo?: "YYYY-MM-DD",                          // 両端含む
 *   ageMin?, ageMax?: number,
 *   flagged?: boolean,          // true なら flagLevel !== null のみ
 *   sort?: "visitDesc"|"visitAsc"|"furigana"|"rowDesc",   // 既定 visitDesc
 *   page?: number, pageSize?: number }                     // 既定 1 / 50，pageSize 上限 200
 */
export function parseQuery(body)                         // JSON本文のオブジェクト → Query | {error}
export function matches(record, query)                   // boolean（空の条件は無視＝AND の単位要素が真）
export function sortRecords(records, sort)               // 新配列を返す
export function searchRecords(records, query)            // -> { total, page, pageSize, items: VaccineRecord[] }
export function toSummary(record)                        // -> ListItem（§4-1）
```
- 日付・年齢の範囲条件は，対象項目が解析不能な行を**除外**する（条件を付けた以上，不明行を混ぜない）．条件が無ければ含める．
- 並び順は `visitDateIso` 降順→`rowNumber` 降順．解析不能な日付は末尾．`furigana` は正規化後の文字列昇順．
- 同一管理番号の別人は別行としてそのまま出す（管理番号は一意キーではない）．詳細画面に「同じ管理番号: N件」を出す（§5）．

## 4. API

すべて同一オリジン．認証通過後のみ．応答は `application/json; charset=utf-8`，`no-store`．

### 4-1. `POST /api/search`（本文は §3-2 の Query をそのまま JSON で送る）

検索条件を `GET /api/records?q=…` のように URL に載せない理由: Workers Logs（observability）や Web サーバのアクセスログはリクエストURLを自動記録するため，アプリのログ原則と無関係に検索語（患者名）がログに残る．検索条件は URL に載せず JSON 本文で送る．`parseQuery` は URLSearchParams でなく本文のオブジェクトを受ける．`Content-Type: application/json` 以外は 400，`Origin` ヘッダがあり自オリジンと違えば 403（CSRF 対策）．`GET` 以外を許すのはこの経路だけ．

```json
{ "total": 128, "page": 1, "pageSize": 50, "sort": "visitDesc",
  "items": [ { "rowNumber": 23, "name": "山田 太郎", "furigana": "やまだ たろう", "visitDate": "2026/10/15",
               "kind": "インフルエンザ", "category": "任意", "age": "13", "flagLevel": "yellow",
               "managementNumber": "20260012" } ],
  "meta": { "fetchedAt": "2026-10-16T00:53:00Z", "stale": false } }
```
- 400: 条件不正（日付形式・数値でない年齢・pageSize 超過・JSONでない本文）．

### 4-2. `GET /api/records/:rowNumber`

`VaccineRecord` から `searchText` を除いた全項目＋ `sameNumberCount`（同じ管理番号の行数，空番号は0）．404: 行が無い／空行．

### 4-3. `GET /api/meta`

```json
{ "total": 128, "flagged": 9, "fetchedAt": "...", "stale": false,
  "kinds": ["インフルエンザ","コロナ"], "categories": ["任意","公費"],
  "visitDateRange": { "min": "2026-10-01", "max": "2026-10-15" },
  "attachmentFolder": "VaccineFormFiles" }
```

- `attachmentFolder` は設定値（Worker は `ATTACHMENT_FOLDER_NAME`，PHP 版は `attachmentFolder`）をそのまま返す．未設定なら空文字列．集計関数 `computeMeta`（純関数）には入れず，App 層（`Src/App.js`・`Php/Private/Lib/App.php`）が応答に足す．画面側（`Public/Api.js`）はこの値から `attachment_unavailable` の文言を組み立てる（§10-3）．

### 4-4. `GET /api/me` → `{ "email": "staff@example.com", "mode": "access" | "dev" | "basic" }`

`basic` は PHP 版で Basic 認証のユーザー名を利用者名とするとき．

### 4-5. その他
- `GET /` と `Public/` 配下: 認証通過後に `env.ASSETS.fetch` で配信し，§1-2(6) のヘッダを上書き付与．PHP 版では Apache が Basic 認証の後に静的ファイルを直接配り，同じヘッダを `.htaccess` で付ける（PHP を通るのは `/api/*` だけ）．
- 未知の `/api/*`: 404 `not_found`．`POST /api/search` 以外で `GET` 以外: 405．

## 5. UI/UX

### 5-1. 方針

- **道具は素の HTML/CSS/ES modules**（フレームワーク無し＝依存ゼロ・CSP を素直に満たす・リポジトリ慣例に合う）．
- **一覧は「整えた行」，カードにしない**．受付は1画面で多数を走査する．行は名前を主役に，メタ情報を1行に畳む．罫線・セル枠・ヘッダ行を持たない（スプレッドシートの気配を消す）．
- **デスクトップは一覧＋右側ドロワーの主従構成，スマホは全画面ボトムシート**．
- **即時検索**: 入力から 250ms デバウンスで `POST /api/search` を呼ぶ．前の応答は `AbortController` で捨てる．
- **要確認はドットのバッジ**で示す（赤・黄・橙＝シートと同じ意味）．詳細では該当項目の右に同じドット＋短い説明．凡例は詳細の末尾に常設．

### 5-2. 画面構成

```
Desktop (≥ 900px)
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◉ ワクチン予診票データベース                    staff@example.com   ◐ テーマ │
├──────────────────────────────────────────────────────────────────────────────┤
│  ⌕  氏名・ふりがな・電話番号・管理番号などで検索                      [ / ] │
│  (種別 ▾) (区分 ▾) (受診日 ▾) (生年月日 ▾) (年齢 ▾) (要確認のみ)   絞り込みを解除 │
├────────────────────────────────┬─────────────────────────────────────────────┤
│ 128件 · 受診日の新しい順 ▾      │  山田 太郎                           行 23  │
│                                │  やまだ たろう                        [ ✕ ] │
│ ▶ 山田 太郎  やまだ たろう  ●  │                                             │
│   2026/10/15 · インフル · 任意 · 13歳 │  基本情報                                   │
│                                │    管理番号  20260012  (同番号 2件)         │
│   佐藤 花子  さとう はなこ     │    種別      インフルエンザ   区分  任意     │
│   2026/10/15 · コロナ · 公費 · 72歳   │    受診日    2026/10/15                     │
│                                │    生年月日  2013/04/02   年齢  13 ● 年齢不一致 │
│   鈴木 一郎  すずき いちろう  ● │  連絡先                                     │
│   2026/10/14 · インフル · 任意 · 45歳 │    郵便番号  223-0051                       │
│                                │    住所      横浜市港北区…                   │
│   …                            │    電話番号  080-1234-5678   保護者署名  —  │
│                                │  接種                                       │
│                                │    希望ワクチン …   体温 36.5   LOT No. —   │
│                                │  公費関連                                   │
│                                │    60～64歳の方 —   自己負担免除対象者 —    │
│                                │  備考                                       │
│                                │    （人が書いた備考）                        │
│  ‹ 1  2  3 ›                   │  凡例  ● 判断不能  ● 推測  ● 年齢不一致      │
└────────────────────────────────┴─────────────────────────────────────────────┘

Mobile (≤ 480px)                      Detail (bottom sheet, full height)
┌──────────────────────────┐          ┌──────────────────────────┐
│ ◉ 予診票DB            ◐ │          │ ▔▔  山田 太郎        ✕  │
│ ⌕ 検索             (≡)  │          │     やまだ たろう  行 23 │
│ (種別)(区分)(要確認のみ)  │          │ 基本情報                 │
├──────────────────────────┤          │  管理番号  20260012      │
│ 山田 太郎             ● │          │  種別  インフルエンザ    │
│ やまだ たろう            │          │  …                       │
│ 10/15 · インフル · 任意 · 13歳│      │ 連絡先                   │
├──────────────────────────┤          │  電話番号  080-…  [発信] │
│ 佐藤 花子                │          │ …                        │
│ さとう はなこ            │          │ 凡例 ● ● ●               │
│ 10/15 · コロナ · 公費 · 72歳 │       └──────────────────────────┘
│ …                        │          (≡) = 日付・年齢の絞り込みを
│          ‹ 1 2 3 ›       │               ボトムシートで開く
└──────────────────────────┘
```

### 5-3. 部品と振る舞い

| 部品 | 仕様 |
|---|---|
| 検索バー | `role="search"`，`input[type=search]`，プレースホルダに対象項目を列挙．250ms デバウンス．右端に `/` のキーキャップ表示（スマホでは非表示） |
| フィルタチップ | 種別・区分は単一選択ポップオーバー．受診日・生年月日は from/to の2つの `input[type=date]`．年齢は min/max 数値．適用中のチップは塗りで強調し「× 解除」を持つ．「絞り込みを解除」で全消去 |
| 結果ヘッダ | 件数と並び替えセレクト（受診日新しい順／古い順／ふりがな順／登録順） |
| 結果行 | 1行目: 氏名(16px/500)＋ふりがな(13px/muted)＋右端にフラグドット．2行目: `受診日 · 種別 · 区分 · 年齢`．ホバー/フォーカスで面を薄く着色．選択行は左に 3px のアクセントバー |
| 詳細ドロワー | デスクトップ 440px 固定幅，スマホは全画面ボトムシート．見出し5節: 基本情報／連絡先／接種／公費関連／備考．基本情報の `生年月日` の次に `性別` を同じ体裁で置く．各項目は「ラベル(12px muted) ＋ 値(15px)」の縦組み，値が空なら「—」．電話は `tel:` リンク（スマホで発信），住所はコピー用ボタン．同一管理番号が複数なら管理番号の横に「同番号 N件」リンク（押すと管理番号で絞る） |
| ページング | 50件/ページ．上下に出さず末尾のみ．先頭/末尾でボタン無効 |

状態:
- **初期（空クエリ）**: 「最近の受診 50件」をそのまま一覧に（見出し「最近の受診」）．
- **読み込み中**: 行の形をしたスケルトン5本（スピナー不使用）．200ms 以内に返れば出さない．
- **0件**: 「該当する記録がありません．空白やハイフンの有無，ひらがな／カタカナは区別しません．」＋「絞り込みを解除」ボタン．
- **エラー**: §2-5 の文言をバナー（`role="alert"`）で表示．`stale=true` なら「データは MM:SS 時点のものです」を細字で表示．
- **認証失敗**: Worker が返す最小 HTML（外部CSSのみ，スクリプトなし）．

キーボード・操作:
- `/` で検索バーへフォーカス，`Esc` で（詳細が開いていれば）閉じる／（閉じていれば）検索語を消す．
- 一覧で `↑↓` 移動，`Enter` で詳細を開く．詳細内は `Tab` 順．ドロワーはフォーカストラップし，閉じたら元の行へ戻す．
- 詳細の開閉はブラウザ履歴に積まない（戻るで前ページへ飛ばす事故を防ぐ）．

アクセシビリティ: 一覧は `ul > li > button`，ドロワーは `role="dialog" aria-modal="true" aria-labelledby`，フラグドットは `aria-label="判断不能"` 等の文字を持つ．コントラスト比 4.5:1 以上．`prefers-reduced-motion` でアニメーション無効．フォーカスリングは 2px アクセント色で常時表示．

### 5-4. デザイントークン（`Public/Styles.css` の `:root` / `[data-theme=dark]`）

| トークン | Light | Dark | 用途 |
|---|---|---|---|
| `--bg` | `#F4F6F8` | `#0F1317` | ページ地 |
| `--surface` | `#FFFFFF` | `#171C22` | 一覧・ドロワー面 |
| `--surface-2` | `#EEF1F4` | `#1F262E` | チップ・ホバー |
| `--text` | `#1A1F26` | `#E6E9ED` | 本文 |
| `--muted` | `#5B6472` | `#98A2AE` | ラベル・ふりがな |
| `--accent` | `#1E5E8C` | `#6DB0E3` | 選択・リンク・フォーカス |
| `--border` | `#E1E5EA` | `#2A323C` | 区切り（線でなく余白と面差で区切り，border は最小限） |
| `--flag-red` / `--flag-yellow` / `--flag-orange` | `#C62828` / `#B8860B` / `#D9731A` | `#EF5350` / `#E0B341` / `#F08A3E` | 要確認ドット |

- 書体: Google Fonts `Noto Sans JP`（400/500/700）＋ `system-ui` 後退．基本 15px（スマホ 16px），行高 1.6，`font-feature-settings: "tnum"`（数字等幅）．
- 間隔: 4px 刻み（4/8/12/16/24/32）．角丸: チップ 999px，面 12px，入力 8px．影: 面は `0 1px 2px rgba(0,0,0,.06)`，ドロワーは `0 8px 32px rgba(0,0,0,.18)`．
- モーション: 150ms `cubic-bezier(.2,.8,.2,1)`．ドロワーは右（スマホは下）から入る．
- テーマ: OS 設定に追従し，ヘッダの切替で上書き（`localStorage.theme`）．

## 6. ファイル構成と責務

```
VaccineOcrDatabase/SearchPortal/
├─ wrangler.jsonc            Worker 設定（§8-2）
├─ package.json              scripts: dev / deploy / test / e2e．devDependency は wrangler のみ
├─ .dev.vars.sample          DEV_BYPASS_ACCESS / FIXTURE_MODE / GOOGLE_SA_JSON の雛形（.dev.vars は gitignore）
├─ README.md                 使い方・セットアップ手順
├─ Docs/Design.md            本書
├─ Src/
│  ├─ Worker.js              入口．設定検査（fail-closed）→ 認証 → ルーティング → ヘッダ付与．I/O はここと下3つだけ
│  ├─ Access.js              Cf-Access-Jwt-Assertion 検証．JWKS 取得は fetch 関数を引数で受ける（テストで差し替え）
│  ├─ GoogleAuth.js          SA JWT 署名とトークン交換・トークンキャッシュ
│  ├─ SheetSource.js         spreadsheets.get 呼び出し・60秒キャッシュ・stale 制御・Fixture 切替
│  ├─ Fixture.js             合成データ 30件（全フラグ・空番号・同番号別人・解析不能日付を含む）
│  ├─ Records.js             HEADERS・validateHeader・classifyColor・mapRows（純関数）
│  ├─ Normalize.js           normalizeText・parseDate・parseAge（純関数）
│  ├─ Search.js              parseQuery・matches・sortRecords・searchRecords・toSummary（純関数）
│  └─ Http.js                json()/errorResponse()/withSecurityHeaders()/isLocalHost()（純関数）
├─ Public/
│  ├─ index.html             骨格のみ（外部 CSS/JS 参照，インライン無し）
│  ├─ Styles.css             トークン・レイアウト・コンポーネント
│  ├─ App.js                 状態管理（query/results/selected）とイベント配線・キーボード
│  ├─ Api.js                 fetch ラッパ（AbortController・エラー code→文言）
│  ├─ Render.js              一覧行・ドロワー・チップ・状態表示の DOM 生成（テンプレート文字列禁止，createElement で XSS 余地を消す）
│  └─ Icons.svg              シンボル定義（検索・閉じる・コピー・発信）
└─ Tests/
   ├─ Unit/*.test.js         node --test（Normalize / Search / Records / Access / Http / Worker）
   └─ E2E/RunE2E.py          Playwright(Python)．wrangler dev --local をフィクスチャモードで起動して検証
```

I/O を持つのは `Worker.js / Access.js(fetch部) / GoogleAuth.js / SheetSource.js` の4つだけ．残りは引数→戻り値の純関数で，`node --test` から直接 import できる．

## 7. テスト計画

### 7-1. 単体テスト（`node --test Tests/Unit`，Node 20+，追加依存なし）

| ファイル | 検証内容 |
|---|---|
| `Normalize.test.js` | NFKC（全角英数・U+FA1A）／大文字小文字／カタカナ→ひらがな／空白・各種ハイフン・長音・スラッシュ除去／`parseDate` の4形式と不正値／`parseAge` の全角・「歳」付き |
| `Search.test.js` | 空条件で全件／各フィールド部分一致／自由語の AND／日付・年齢の両端含む／解析不能行の除外／種別・区分の完全一致／`flagged`／各ソート／ページング境界／`parseQuery` の 400 判定 |
| `Records.test.js` | 見出し一致・不一致・旧レイアウト・備考あり無し／空行除外と rowNumber 保持／色分類の閾値（赤・黄・橙・白・未指定）／`flagLevel` の優先順位／`searchText` に備考が入る |
| `Access.test.js` | テスト内で生成した RSA 鍵で署名した JWT を使い，正常／`aud` 不一致／期限切れ／`iss` 不一致／署名不正／ヘッダ欠落／未知 kid の再取得1回／JWKS 取得失敗 を判定 |
| `Http.test.js` | 全応答に §1-2(6) のヘッダが付く／`isLocalHost` が `localhost`・`127.0.0.1` だけ真 |
| `Worker.test.js` | `ACCESS_*` 未設定で静的・API とも 503／`DEV_BYPASS_ACCESS=1` でも hostname が本番なら拒否／`/api/me`・`/api/meta`・`POST /api/search`・`/api/records/:n` の形／405・404／ログ行に検索語が含まれない（console を差し替えて検査） |

`SheetSource` は fetch を注入して，キャッシュ TTL・同時取得の一本化・stale 10分の境界を `Worker.test.js` に含める．

### 7-2. E2E（`python Tests/E2E/RunE2E.py`，Playwright Python，`wrangler dev --local --port 8798` を子プロセスで起動）

| # | シナリオ | 期待 |
|---|---|---|
| 1 | 「山田太郎」（空白なし）で検索 | 「山田 太郎」の行が出る |
| 2 | 電話番号をハイフン無しで検索 | 該当行が出る |
| 3 | カタカナ「ヤマダ」で検索 | ふりがな「やまだ」の行が出る |
| 4 | 種別=コロナ＋区分=公費＋年齢 65–100 | 合成データで既知の件数と一致 |
| 5 | 受診日 from/to | 範囲外の行が出ない．解析不能日付の行が出ない |
| 6 | 要確認のみ | フラグ付き行だけ．ドットの `aria-label` が一致 |
| 7 | 行クリック→ドロワー→`Esc` | 開閉し，フォーカスが元の行へ戻る |
| 8 | `/` キー・`↑↓`・`Enter` | 検索バーへフォーカス／行移動／詳細が開く |
| 9 | 存在しない名前 | 0件メッセージと「絞り込みを解除」 |
| 10 | 390×844 のモバイル viewport | ボトムシート表示・横スクロール無し・`tel:` リンクあり |
| 11 | 未認証（`DEV_BYPASS_ACCESS` 無しで起動） | `/` も `/api/meta` も 503 で本文に患者項目を含まない |
| 12 | 任意の応答ヘッダ | CSP・no-store・noindex が付く |

- 失敗時は `logs/E2E-<scenario>-<timestamp>.html/.png` を保存（`logs/` は gitignore 済み）．終了コードは失敗数．
- **データはフィクスチャモード**（§7-3）で供給し，E2E は実PIIを一切使わない．
- 任意のスモーク `--real`: `.dev.vars` の `GOOGLE_SA_JSON` で実シートを読み，`/api/meta` の `total>0` と見出し検証通過だけを確認する（値は出力しない）．

### 7-3. フィクスチャモード

`.dev.vars` に `FIXTURE_MODE="1"` があり **かつ** hostname が localhost のとき，`SheetSource` は Google を呼ばず `Fixture.js` の30件を返す．本番 hostname では無視される（§1-2(3) と同じ柵）．合成データは架空の氏名・住所・電話（`090-0000-00xx`）で構成する．

## 8. デプロイ手順

### 8-1. 利用者が手で行うこと（ダッシュボード）

1. Zero Trust を有効化し，チーム名を決める（例 `example` → `ACCESS_TEAM_DOMAIN = <team>.cloudflareaccess.com`）．
2. Access → Applications → Add → Self-hosted．Application domain = `vaccine.example.org`（パス空＝全体）．Session duration 24h．
3. Policy: Action Allow，Include = Emails（職員のメールを列挙）．Login method は One-time PIN のみ．
4. 作成後の Overview で **Application Audience (AUD) Tag** をコピー → `ACCESS_AUD`．
5. 職員の追加・削除はこの Policy の編集だけで完結する（アプリ側に名簿を持たない）．

### 8-2. 設定とコマンド

```jsonc
// wrangler.jsonc（要点）
{ "name": "vaccine-search-portal", "main": "Src/Worker.js", "compatibility_date": "2026-10-01",
  "workers_dev": false, "preview_urls": false,
  "routes": [{ "pattern": "vaccine.example.org", "custom_domain": true }],
  "assets": { "directory": "./Public", "binding": "ASSETS", "run_worker_first": true },
  "vars": { "SHEET_ID": "", "SHEET_NAME": "シート1",
            "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com", "ACCESS_AUD": "<AUDタグ>" },
  "observability": { "enabled": true } }
```

```powershell
cd VaccineOcrDatabase\SearchPortal
npm install                                            # wrangler のみ
npm test                                               # node --test Tests/Unit
npm run dev                                            # wrangler dev --local --port 8798（.dev.vars で迂回＋フィクスチャ）
python Tests\E2E\RunE2E.py                             # E2E
Get-Content ServiceAccount.json -Raw | npx wrangler secret put GOOGLE_SA_JSON
npm run deploy                                         # wrangler deploy（Custom Domain は初回 deploy で自動作成）
```

`ACCESS_AUD` を toml に入れる前に deploy した場合も，`access_not_configured` で全拒否されるだけで露出しない．

### 8-3. デプロイ後の確認（必須）

1. `curl -I https://vaccine.example.org/` → Access のログイン画面へ 302（本文に DB を含まない）．
2. `curl -I https://vaccine.example.org/api/meta` → 302 または 401/403．200 は不合格．
3. `curl -I https://vaccine-search-portal.<account>.workers.dev/` → 名前解決失敗または 404/403．200 は不合格（`workers_dev: false` の確認）．
4. 許可リストのメールでログイン → `/api/me` が自分のメールを返す．許可リスト外のメールで PIN が届いても拒否されること．
5. Workers Logs で検索語が記録されていないことを1件目視する．

## 9. スコープ

### 9-1. v1 に含めない
- 書き込み（備考編集・色の解除・ステータス変更）．Sheets への権限も readonly のまま．
- ~~予診票画像／PDF の表示．~~ → v1.1 で追加（§10．セルのリンク先を Worker 経由で表示する）．
- 統計・集計・CSV 出力．
- 複数シート（シーズン切替）．v1 は `患者管理`（旧 `シート1`．2026-10-16 時点の実シート名） 固定．
- 検索履歴・お気に入り・オフライン．

### 9-2. v2 候補（優先順）
1. 備考の追記と「確認済み（色解除）」操作（書き込みスコープ・操作ログ・楽観ロック）．
2. シーズン／シート切替（`SHEET_NAME` 複数）と年度横断検索．
3. 同一人物の接種履歴ビュー（氏名＋生年月日で束ねる）．
4. 簡易集計（日別・種別別・公費別件数）とその場の CSV ダウンロード（Access ログに残す）．
5. Access のグループ（Google Workspace IdP）への移行で名簿管理を人事と一本化．

## 10. 添付ファイル（v1.1）

追補日: 2026-10-16／状態: 実装前の確定設計／前提: §1〜§9 は変更しない（本節は追加のみ）．

### 10-1. 背景と結論

- 実シートではセル自体にリンクが貼られる運用が始まった（2026-10-16 時点で1件: 行17の `氏名` セル全体に `https://drive.google.com/file/d/<id>/view?usp=sharing`．リンク先は紙の予診票を撮った JPEG 約 0.9 MB）．受付はこの写真と転記値を見比べたい．
- **Worker が既存のサービスアカウント（以下 SA）で Drive からファイルを代理取得し，ポータルの中に表示する**．職員は Access のログインだけで足り，Drive 側で個人へ共有する必要はない．
- ファイルは My Drive の専用フォルダ **`VaccineFormFiles`** に置き，このフォルダを SA（`<service-account>@<project>.iam.gserviceaccount.com`）へ **閲覧者** で共有する．フォルダ外・未共有のファイルは「開けない」旨を日本語で示し，原本URLへの「Google ドライブで開く」リンクに退避する（画面が壊れない）．
- Google のスコープは `spreadsheets.readonly drive.readonly`（`Src/GoogleAuth.js` の `SHEETS_READONLY_SCOPE` を `GOOGLE_SCOPES` に改名し，空白区切りで2つ）．**書き込み権限は引き続き持たない**．SA が読めるのは共有されたものだけなので，`drive.readonly` を足しても到達範囲は `VaccineFormFiles` に限られる．
- クライアントがファイル ID を指定する経路は作らない．API が受けるのは **行番号＋添付の連番** だけで，ID はキャッシュ済みレコードから Worker が引く（任意の Drive ファイルを読ませるプロキシにしない）．
- JPEG/PNG は配信時に Cloudflare Images で WebP に変換し，**小さくなったときだけ** WebP を返す（§10-4）．Drive 上のファイルは一切書き換えない．

### 10-2. リンクの抽出（`Src/SheetSource.js`・`Src/Attachments.js`・`Src/Records.js`）

`buildSheetUrl` の `fields` マスクを次に替える（19列すべてに対して値・色・3種のリンク情報を同時に取る．`spreadsheets.get` 1回のまま）:

```
fields=sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor),
  hyperlink,textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri,mimeType)))))))
```

- `hyperlink`: セル全体リンク（UI の「リンクを挿入」や `HYPERLINK()`）．行17の実例はこれ．
- `textFormatRuns[].format.link.uri`: 文字列の一部に貼ったリンク（`startIndex` は使わない．リンク先だけ要る）．
- `chipRuns[].chip.richLinkProperties.uri`: スマートチップ（Drive ファイルを `@` で貼ったもの）．`mimeType` は参考情報で，判定には使わない（表示可否は配信時に Drive の実メタデータで決める）．

新規の純関数モジュール `Src/Attachments.js`:

```js
export const DRIVE_HOSTS = ["drive.google.com", "docs.google.com"];
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
export function parseDriveFileId(url)      // -> string|null
export function classifyLink(uri)          // -> {kind:"drive", url, fileId} | {kind:"external", url} | null
export function extractCellLinks(cell)     // -> string[]（hyperlink → textFormatRuns → chipRuns の順，同一 URI は1つ）
export function buildAttachments(cells)    // -> {attachments:[...], fileIds:(string|null)[]}（19列ぶんの CellData[]）
```

- `parseDriveFileId` が **Drive 扱いにする形は3つだけ**: `/file/d/<id>/…`，`/open?id=<id>`，`/uc?id=<id>`（ホストは `DRIVE_HOSTS`，`<id>` は `DRIVE_ID_RE` を満たす）．`/document/d/`・`/spreadsheets/d/`・`/presentation/d/` は Google ドキュメント類で `alt=media` では取れないため **external** とする（新しいタブで開けば足りる）．
- `classifyLink`: `https:` でない URI（`http:`・`mailto:`・`tel:`・`javascript:` 等）は **捨てる**（`null`）．Drive 形でない https は external．
- 重複除去は行単位．Drive は `fileId`，external は URL 文字列（末尾 `/` と `#` 以降を落として比較）をキーにし，**先に現れた列・先に現れた種類を残す**．連番 `index` は除去後に 0 から振る．
- `mapRows`（`Src/Records.js`）が各行で `buildAttachments` を呼び，レコードに次を足す:

```ts
attachments: Array<{ index: number, field: string /* 例 "name"・"note" */, label: string /* 例 "氏名のリンク" */,
                     kind: "drive"|"external", url: string }>,
attachmentFileIds: (string|null)[]     // attachments と同じ並び．external は null．サーバ内専用
```

- `label` は `HEADERS[col] + "のリンク"`（19列目は「備考のリンク」）．同じセルに複数あれば `「氏名のリンク (2)」` のように連番を付ける．
- `toSummary` に `attachmentCount: number` を足す．`toDetail` は `searchText` と同様に **`attachmentFileIds` を落とす**．`url` には ID が含まれるが，それは「Google ドライブで開く」に必要な原本URLであり，API が受けるのは行番号＋連番だけなので，ID を知っていても Worker 経由で任意ファイルを読む経路にはならない．
- `searchText` にリンクは入れない（URL で検索されることはなく，ID 文字列をヒット対象にする理由がない）．

### 10-3. 配信エンドポイント `GET|HEAD /api/records/:rowNumber/attachments/:index`

`Src/App.js` に `ATTACHMENT_PATH = /^\/api\/records\/(\d{1,7})\/attachments\/(\d{1,2})$/` を足し，`RECORD_PATH` より先に判定する．`HEAD` を許すのはこの経路だけ（画面側の事前確認用．`GET` と同じ判定・同じヘッダで本文なし．`alt=media` も WebP 変換も行わない）．

処理順（`Src/DriveSource.js` の `createDriveFileLoader({fetchFn, getToken, now})` が Drive 呼び出しを担当し，`App.js` から注入する）:

1. `loadData` でキャッシュ済みレコードを得る（§2-4 と同じ．stale でも配信する）．行が無い／`index` が範囲外／`kind !== "drive"` → 404 `not_found`．
2. `GET https://www.googleapis.com/drive/v3/files/{fileId}?fields=mimeType,size&supportsAllDrives=true`（Bearer は §2-1 のトークン）．Drive が 403／404 → **404 `attachment_unavailable`**．それ以外の非 2xx → 503 `sheet_unavailable`（上流障害）．メタデータはアイソレート内 `Map<fileId,{mimeType,size,at}>` に **60 秒** だけ保持（HEAD→GET の対で `files.get` を1回に抑える．`name` は取らない＝PII を持たない）．
3. `mimeType` が許可リスト `ATTACHMENT_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }` に無い → **415 `attachment_unsupported`**．HEIC は意図して外す（ブラウザが描画できない．iPhone は「互換性優先」で撮るか JPEG に変換して保存し直す）．`application/vnd.google-apps.*` も同じ扱い．
4. `Number(size) > MAX_ATTACHMENT_BYTES (= 20 * 1024 * 1024)` → **413 `attachment_too_large`**（Images の入力上限 20 MB に揃える）．`size` が数値でない → 415．
5. `GET …/files/{fileId}?alt=media&supportsAllDrives=true` を呼ぶ．**PDF と WebP は `upstream.body` をそのまま返す**（ストリーム透過）．**JPEG/PNG は `arrayBuffer()` で一度バッファし §10-4 の変換を試す**（上限 20 MB 以内なのでメモリに収まる）．`HEAD` ならここを飛ばして 200 空本文．

応答ヘッダ（`Src/Http.js` に `attachmentResponse(body, {mimeType, ext, size, format})` を足し，`SECURITY_HEADERS` を基礎に次で上書き）:

```
Content-Type: <許可リストの正規化文字列>        Content-Length: <実際に返す本文のバイト数>
Content-Disposition: inline; filename="attachment.<ext>"   （行番号・氏名を含めない中立名）
Content-Security-Policy: default-src 'none'; frame-ancestors 'self'; sandbox
Vary: Accept    X-Attachment-Format: webp | original
Cache-Control: no-store    X-Content-Type-Options: nosniff    Referrer-Policy: no-referrer    X-Robots-Tag: noindex, nofollow, noarchive
```

- `Content-Type` は Drive の値をそのまま流さず，許可リストのキー文字列を使う（`nosniff` と組で，HTML を画像と偽る応答を同一オリジンで実行させない）．`sandbox` は仮に本文が文書として解釈されても opaque origin に落とす保険．`frame-ancestors 'self'` でポータル内の `<iframe>`／`<img>` からだけ参照できる（**ページ本体の `frame-ancestors 'none'` は変えない**）．
- `HEAD` の `Content-Length` は原本サイズで，`X-Attachment-Format` は付けない（変換は GET でしか行わない）．
- Chrome は sandbox 化された文脈で PDF ビューアを起動しないことがある．初回公開時の目視確認（§10-9）で PDF が白紙なら，**PDF 応答に限り** CSP を `default-src 'none'; frame-ancestors 'self'` にする（画像応答は `sandbox` を維持）．これ以外の変更はしない．
- **2026-10-16 実装時の修正**: Chrome 内蔵の PDF ビューアは sandbox 化された文書では白紙になるため，目視確認を待たず最初から **PDF 応答の CSP は `default-src 'none'; frame-ancestors 'self'`（`sandbox` なし）** とした．画像応答は `sandbox` を維持（`Src/Http.js` の `ATTACHMENT_IMAGE_CSP` / `ATTACHMENT_PDF_CSP`）．

§2-5 の対応表に追加（`ERRORS`）:

| code | HTTP | 画面文言（日本語） |
|---|---|---|
| `attachment_unavailable` | 404 | 添付ファイルを開けません．ファイルが Google ドライブの「VaccineFormFiles」フォルダにあり，共有されているか確認してください． |
| `attachment_unsupported` | 415 | この形式のファイルは表示できません（JPEG・PNG・WebP・PDF のみ）．HEIC は JPEG に変換して保存し直してください． |
| `attachment_too_large` | 413 | ファイルが大きすぎます（上限 20 MB）．縮小して保存し直してください． |

ログ（§1-2(7) に準拠）: `route` は **テンプレート文字列 `/api/records/:rowNumber/attachments/:index`** 固定．`status, email, ms, cacheHit` に加えて失敗時のみ `upstreamStatus`（Drive の HTTP 状態）を書く．**fileId・行番号・連番・ファイル名・サイズは書かない**．

### 10-4. WebP 変換（`Src/ImageVariant.js`・Cloudflare Images バインディング）

- `wrangler.jsonc` に `"images": { "binding": "IMAGES" }` を足す．WASM エンコーダは使わない（0.9 MB 級の写真で CPU 制限に当たる）．Images は全アカウントで Free プランが既定で有効化手順は無い（月 5,000 ユニーク変換．超過分は新規変換が失敗（エラー 9422）するだけで課金されず，下記の fail-safe で原本が出る）．
- 条件: 原本の `mimeType` が `image/jpeg` または `image/png`，リクエストの `Accept` に `image/webp` を含む，原本が 20 MB 以下．**WebP・PDF・HEIC（そもそも 415）は変換しない**．
- 手順: `env.IMAGES.input(new Blob([bytes]).stream()).output({ format: "image/webp", quality: 80 }).response()` → `arrayBuffer()` でバイト列を得る（生バイトを返す API は無い）→ **原本より小さいときだけ WebP** を返し `X-Attachment-Format: webp`，そうでなければ原本を `original` で返す．常に `Vary: Accept`．変換結果は Cache API・KV に置かない（PII をアイソレート外に残さない．`no-store` のまま）．
- fail-safe: `env.IMAGES` が無い（フィクスチャ／Images 未提供のアカウント），`output()` が例外，**8 秒** の `Promise.race` 超過 → 原本を返し `log({event:"webp_skipped", reason})` を1行．`reason` は `binding_missing | transform_error | timeout | over_input_limit` の固定値のみ（fileId・サイズ・行番号は書かない）．WebP の方が大きかった場合は正常系でありログは書かない．
- モジュール（純関数＋注入）:

```js
export const WEBP_SOURCE_TYPES = ["image/jpeg", "image/png"];
export const WEBP_QUALITY = 80;
export const WEBP_TIMEOUT_MS = 8000;
export function acceptsWebp(acceptHeader)                               // -> boolean
export async function chooseImageVariant({ bytes, mimeType, accept, transform, log, now })
  // transform: (bytes) => Promise<ArrayBuffer>（App.js では env.IMAGES を包んだ関数を渡す．無ければ null）
  // -> { body: ArrayBuffer, mimeType: string, ext: string, format: "webp"|"original" }
```

- フィクスチャモード（`FIXTURE_MODE=1` かつ localhost）では `createApp` が `transform: null` を渡す（`wrangler dev` のオフライン版バインディングは `quality` を無視するため結果が環境依存になる．E2E は決定的に `original` を見る）．

### 10-5. ページ CSP の変更（`Src/Http.js` `SECURITY_HEADERS`）

`frame-src 'self'` を1項目追加する（ドロワー内の `<iframe src="/api/records/…">` のため）．`img-src 'self' data:` は既にあり，`<img src="/api/records/…">` はこのまま通る．`object-src` は明示せず `default-src 'none'` で禁止のまま（`<object>`/`<embed>` は使わない）．`frame-ancestors 'none'`・`connect-src 'self'`・その他は不変．変更後の文字列:

```
default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

### 10-6. フィクスチャモード（`Src/Fixture.js`）

合成30件に添付を4件足す（`ROWS` は触らず，行番号→列→リンク情報の `LINKS` 表を `toGridRow` で合成する）:

| 行 | 氏名 | セル | リンクの形 | 内容 | 期待 |
|---|---|---|---|---|---|
| 2 | 山田　太郎 | 氏名 | `hyperlink`（セル全体） | `https://drive.google.com/file/d/FixturePng0000000000000000000001/view?usp=sharing` | 1×1 PNG（本番行17と同じ形） |
| 15 | 山本　光 | 備考 | `textFormatRuns` | `https://drive.google.com/open?id=FixturePdf0000000000000000000002` | 最小 PDF |
| 17 | 井上　大輔 | 住所 | `hyperlink` | `https://example.com/map/fixture` | external |
| 31 | 長谷川　ハル | 備考 | `chipRuns` | `https://drive.google.com/file/d/FixtureMissing00000000000000003/view` | 未共有＝エラー経路 |

- 本文は **コードで生成**し，リポジトリにバイナリを置かない: PNG は 67 バイトの 1×1 透過 PNG を base64 定数から `Uint8Array` に戻す．PDF は `%PDF-1.4` ヘッダ＋ Catalog/Pages/Page（MediaBox 200×100・内容なし）＋正しい `xref`・`trailer`・`%%EOF` を文字列結合で組む（Chrome・Safari が1ページの白紙として開ける最小構成）．
- `export const FIXTURE_FILES = { FixturePng…: {mimeType:"image/png", bytes}, FixturePdf…: {mimeType:"application/pdf", bytes} }` と `export async function loadFixtureFile(fileId)` → `{mimeType, size, body: ReadableStream}` または `null`．`createApp` は `loadFixtureFile` を注入で受け，**フィクスチャモードでは Drive も OAuth も Images も呼ばない**（`null` は Drive 403 相当→ `attachment_unavailable`）．
- `FIXTURE_EXPECTATIONS` に追加: `attachments: { rowNumbers: [2, 15, 17, 31], total: 4, image: { rowNumber: 2, index: 0, field: "name", label: "氏名のリンク", mimeType: "image/png", format: "original" }, pdf: { rowNumber: 15, index: 0, field: "note", label: "備考のリンク", mimeType: "application/pdf" }, external: { rowNumber: 17, index: 0, url: "https://example.com/map/fixture" }, unavailable: { rowNumber: 31, index: 0, url: "https://drive.google.com/file/d/FixtureMissing00000000000000003/view" } }`．

### 10-7. UI/UX（`Public/Render.js`・`Public/App.js`・`Public/Api.js`・`Public/Styles.css`・`Public/Icons.svg`）

**位置: ドロワー見出し直下，「基本情報」より前に「添付ファイル」節を置く**（`renderDrawerBody` の `SECTIONS` ループの前）．理由: 受付の作業は「紙の写真を見て転記値が合っているか確かめる」であり，原本→転記値の順で読ませるのが自然．スマホの全画面シートでは4節ぶんスクロールしないと写真に届かない配置は使われない．添付が無い行では節ごと描画しない（空の「—」節で場所を取らない）．

| 部品 | 仕様 |
|---|---|
| 一覧行 | `attachmentCount > 0` のとき `.row-aside` のフラグドットの左に 14px のクリップアイコン（`Icons.svg#paperclip`，`role="img" aria-label="添付あり"`，`data-testid="attachment-icon"`）．件数は出さない |
| 画像 | `<button class="attachment-thumb" data-testid="attachment-thumb" aria-label="添付画像を拡大（氏名のリンク）">` の中に `<img src="/api/records/{row}/attachments/{index}" alt="氏名のリンク" loading="lazy">`．`max-height: 200px; width: auto; object-fit: contain`．下に出典キャプション「氏名のリンク」（12px muted）．クリックでライトボックス |
| ライトボックス | `#lightbox`（`index.html` に空の `div` を常設），`role="dialog" aria-modal="true" aria-label="添付画像"`，z-index 45（ドロワー30・シート35・ポップオーバー40より上，トースト50より下）．黒地 `rgba(0,0,0,.92)`，画像は既定 **fit**（`max-width:100vw; max-height:100dvh`）．ツールバー右上: 「原寸」⇄「全体」切替（`aria-pressed`），「閉じる」．画像クリックでも切替．原寸時は外枠が `overflow:auto` でスクロール．スマホのピンチ拡大はブラウザ標準に任せる（`touch-action` を奪わない．`index.html` の viewport に `maximum-scale` を入れない） |
| PDF | `<iframe src="/api/records/{row}/attachments/{index}" title="備考のリンク（PDF）" data-testid="attachment-pdf">` を `height: 60vh; width:100%; border:0; border-radius: var(--radius-input)` で埋め，直下に「新しいタブで開く」（`<a href=同じURL target="_blank" rel="noopener noreferrer">`）．iOS Safari は iframe 内 PDF を1ページ目しか描かないため，このリンクが本線になる |
| external | 代理取得しない．`<a href=url target="_blank" rel="noopener noreferrer" data-testid="attachment-external">` に外部アイコン＋「外部リンク（example.com）」＋出典「住所のリンク」．`Referrer-Policy: no-referrer` は既存 |
| エラーカード | `data-testid="attachment-error"`，`role="alert"`，`.drawer-error` と同じ色．§10-3 の文言＋出典＋「Google ドライブで開く」（原本 `url`，`target="_blank" rel="noopener noreferrer"`）．ネットワーク断は `network` の文言 |
| 読み込み中 | 画像・PDF とも高さ 200px のスケルトン（`.skeleton-bar` 流用）．200ms 以内に返れば出さない（§5-3 と同じ） |

取得の流れ（`Public/Api.js` に `probeAttachment(rowNumber, index, signal)` を追加）: 添付ごとに **`HEAD` を先に送り**，200 なら `<img>`／`<iframe>` を描画，それ以外は状態コードを `{404:"attachment_unavailable", 413:"attachment_too_large", 415:"attachment_unsupported", 401:"unauthorized", 503:"sheet_unavailable"}` で文言に写してエラーカードを出す（`<img onerror>` や iframe では状態が取れないため）．ドロワーの切替・閉鎖で `AbortController` により中断（`drawerState.controller` と同じ寿命）．

キーボード・アクセシビリティ:

- `Esc` の優先順を **ライトボックス > ポップオーバー > フィルタシート > ドロワー > 検索語消去** にする（`onGlobalKeydown` の先頭に追加）．`Tab` はライトボックス内（切替・閉じる・画像の3要素）でトラップ（`trapFocus(el.lightbox, e)`）．閉じたらサムネイルのボタンへフォーカスを返す．
- 開閉はブラウザ履歴に積まない（§5-3 と同じ）．`prefers-reduced-motion` でフェードを切る．
- サムネイルは `button`（キーボードで開ける），`<img alt>` は出典ラベル（氏名は含めない＝読み上げでも PII を増やさない）．ライトボックス表示中は背後を `aria-hidden` にせず `aria-modal` に任せる（既存ドロワーと同じ方針）．
- デスクトップではライトボックスがドロワーも覆う．比較は `Esc` で戻って転記値を見る往復で行う（ライトボックス→サムネイルへ焦点が戻るので往復コストが1キー）．

### 10-8. テスト追加

単体（`node --test Tests/Unit`）:

| ファイル | 検証内容 |
|---|---|
| `Attachments.test.js`（新規） | `parseDriveFileId` の3形式と非対象（Docs/Sheets URL・`http:`・ID が短い）／`classifyLink` の drive・external・捨てる判定／`extractCellLinks` が `hyperlink`・`textFormatRuns`・`chipRuns` の3種から取り，同一 URI を1つにする／`buildAttachments` の行内重複除去（同じ fileId が2列にあれば先の列だけ）・`index` 連番・`label` の列名と連番・`attachmentFileIds` の並び |
| `ImageVariant.test.js`（新規） | WebP が小さい → `webp`／大きい → `original`（ログ無し）／`Accept` 無し・`image/webp` 無し → `original` で `transform` 未呼出／`transform: null` → `original`＋`webp_skipped(binding_missing)`／`transform` が throw → `original`＋`transform_error`／タイムアウト → `timeout`／PDF・WebP・HEIC の入力では `transform` が呼ばれない／20 MB 超は `over_input_limit`／ログ行に数値・ID が無い |
| `Records.test.js` | フィクスチャ4行の `attachments` が §10-6 の表どおり／添付の無い行は `[]`／リンクは `searchText` に入らない |
| `Search.test.js` | `toSummary().attachmentCount`／`toDetail()` に `attachmentFileIds` が無く `attachments[].url` はある |
| `Worker.test.js` | 行なし・連番範囲外・external の連番 → 404 `not_found`／`?id=` やパス末尾の ID を付けても無視される（fetch モックに Drive 呼び出しが **来ない**）／mimeType 不許可 → 415／`size` 超過 → 413／Drive 403・404 → 404 `attachment_unavailable`／Drive 500 → 503／200 の全ヘッダ（Content-Type 正規化・inline の中立 filename・`sandbox` CSP・`Vary: Accept`・`X-Attachment-Format`・no-store・nosniff）／`HEAD` が 200 空本文で `alt=media` と変換を呼ばない／メタデータ 60 秒キャッシュ／フィクスチャモードで `fetchFn` も `transform` も呼ばれず PNG・PDF の先頭バイトが正しい／ログ行に `fileId`・行番号・連番・`attachment.` 以外のファイル名が含まれず `route` がテンプレート文字列 |
| `Http.test.js` | ページ CSP に `frame-src 'self'` があり `frame-ancestors 'none'` のまま／`attachmentResponse` の CSP が `frame-ancestors 'self'` と `sandbox` を含む |
| `GoogleAuth.test.js`（新規） | 署名前の claims の `scope` が `spreadsheets.readonly drive.readonly` の2つで，書き込みスコープを含まない |

E2E（`Tests/E2E/RunE2E.py` に追加．データは §10-6）:

| # | シナリオ | 期待 |
|---|---|---|
| 13 | 行2（山田）を開く | `attachment-thumb` 内の `img` が可視で `naturalWidth > 0`．その応答を捕捉し `X-Attachment-Format: original`・`Vary: Accept`．クリックで `#lightbox[role=dialog]` が可視，「原寸」押下で `aria-pressed=true`，`Esc` で閉じてフォーカスが `attachment-thumb` に戻る |
| 14 | 行15 を開く | `iframe[data-testid=attachment-pdf]` の `src` が `/api/records/15/attachments/0`．同 URL への応答を Playwright で捕捉し `status=200`・`content-type: application/pdf`・CSP に `frame-ancestors 'self'` と `sandbox`・`content-disposition` に氏名を含まない．「新しいタブで開く」の `href` が同 URL |
| 15 | 行31 を開く | `attachment-error` が `role=alert` で可視，本文に「VaccineFormFiles」を含み，「Google ドライブで開く」の `href` が `FIXTURE_EXPECTATIONS.attachments.unavailable.url` と一致し `target=_blank`．`img`・`iframe` は描画されない |
| 16 | 初期一覧（最近の受診．30件全部） | `row-attachment-icon` が **4個**（行 2・15・17・31）で各 `aria-label` が「添付あり」．行17 を開くと `attachment-external` の `href` が `https://example.com/map/fixture`，`rel` に `noopener` |

- シナリオ 12（応答ヘッダ）に「ページ CSP に `frame-src 'self'` を含む」を足す．
- フィクスチャでは WebP のバイト削減を検証しない（`transform: null` で常に `original`）．WebP の実効果は §10-9 の本番確認で見る．
- 失敗時の証跡保存・終了コード・実PII不使用は §7-2 と同じ．

### 10-9. 運用・デプロイ

1. **初回のみ**: Google ドライブ（My Drive）に `VaccineFormFiles` フォルダを作り，共有 → `<service-account>@<project>.iam.gserviceaccount.com` を **閲覧者** で追加（通知は不要）．「リンクを知っている全員」にはしない（PII を含むため）．既存の行17のファイルをこのフォルダへ **移動** する（移動しても URL と fileId は変わらないのでセルは触らなくてよい）．
2. **職員が新しいファイルを足す手順**（README に転記）: 写真・PDF を `VaccineFormFiles` にアップロード → 右クリック「リンクをコピー」（共有設定は変えない） → シートの該当セルを選び，Ctrl+K（リンクを挿入）で貼り付け → 60 秒以内にポータルへ反映．iPhone の写真は HEIC のままだと表示できないので，撮影設定を「互換性優先」にするか JPEG で書き出す．1ファイル 20 MB まで．
3. Cloudflare Images: 有効化手順は不要（Free プラン既定）．使用量はダッシュボード → Images → Transformations で月のユニーク変換数を見る（同じ元画像＋同じパラメータは月1回しか数えない．受付が同じ写真を何度開いても増えない）．5,000 を超えても原本配信に退避するだけで表示は止まらない．
4. デプロイ: `npm test` → `npm run e2e` → `npm run deploy`．`GOOGLE_SA_JSON` の再登録は不要（鍵は同じ．スコープはコード側）．
5. **デプロイ後の確認（必須）**:
   - `curl -I https://vaccine.example.org/api/records/17/attachments/0` → Access の 302（200 なら不合格）．
   - 許可メールでログインし，行17（`氏名` にリンクのある行）を開く → 写真のサムネイルが出て，ライトボックスで原寸に切り替わる．一覧の同行にクリップアイコンがある．
   - 同じ行17の画像応答を DevTools の Network で見る: `X-Attachment-Format: webp`，`Content-Type: image/webp`，`Vary: Accept`，`Content-Length` が `HEAD` の値（原本 約 0.9 MB）より小さい．`original` のままなら Workers Logs の `webp_skipped` の `reason` を見る．
   - 検証用に患者情報を含まない PDF を1つ `VaccineFormFiles` に置き，自分で見つけやすい行の `備考` セルに一時的にリンク → iframe に1ページ目が描画されることを Chrome と iPhone Safari で確認（白紙なら §10-3 の PDF 限定の CSP 緩和を適用）．確認後にリンクと PDF を削除する．
   - Workers Logs で添付ルートの行に `fileId`・行番号が無いことを1件目視する．
6. フォルダから出された／共有を外されたファイルは `attachment_unavailable` になるだけで検索・詳細は動き続ける．原因切り分けは「Google ドライブで開く」で本人が開けるか（フォルダ外）→ SA の閲覧者が残っているか（共有解除）の順．
