# VaccineKarte（ワクチンカルテ）

[English](README.en.md)

VaccineKarte は，Google スプレッドシートで管理しているワクチン予診票データベース（1行＝1回の受診）を，受付の PC やスマートフォンから検索・閲覧するための**読み取り専用**の Web ポータルです．静的な画面（`Public/`）は共通で，サーバ側は2種類から選べます．1つは Cloudflare Access の背後で動く **Cloudflare Worker**（`Src/`），もう1つは一般的な共用レンタルサーバ向けの **PHP 版**（`Php/`）です．PHP 版の検索・正規化・行マッピングのロジックは，JS 版とバイト単位で同じ JSON を返すことをパリティテスト（1015件）で確かめています．スプレッドシートへの書き込み機能はありません．

## 機能

- **正規化検索**: 全角・半角（NFKC），大文字・小文字，カタカナ・ひらがなの違いを吸収し，空白・各種ハイフン・長音「ー」・スラッシュを無視して部分一致します（「山田太郎」で「山田　太郎」に，ハイフンなしの電話番号で「090-0000-0001」に当たります）．自由語は空白区切りで AND 検索し，全項目＋備考を横断します．
- **絞り込み**: 種別（インフルエンザ／コロナ），区分（任意／公費），受診日・生年月日の範囲，年齢の範囲，「要確認のみ」．並び順は受診日の新しい順・古い順，ふりがな順，行番号の降順．1ページ50件（API では最大200件）．
- **要確認フラグ**: セルの背景色（赤・黄・橙．条件付き書式の結果も含む）を読み取り，一覧ではドット，詳細では該当項目ごとに表示します．行の重要度は 赤 ＞ 橙 ＞ 黄 です．
- **添付ファイル**: セルに貼られた Google ドライブのリンク（セル全体のリンク・文字列の一部のリンク・スマートチップ）を，サーバがサービスアカウントで代理取得し，詳細画面内に画像・PDF として表示します．対応形式は JPEG・PNG・WebP・PDF（1ファイル 20 MB まで）．JPEG・PNG は WebP に変換して小さくなったときだけ WebP で返します（Worker は Cloudflare Images バインディング，PHP 版は GD）．ブラウザから指定できるのは「行番号＋添付の連番」だけで，任意の Drive ファイルを読ませるプロキシにはなりません．ドライブ以外の https リンクは外部リンクとして表示します．
- **同じ管理番号の件数表示**，電話番号の `tel:` リンク，キーボード操作（`/` で検索欄，`↑↓`・`Enter`・`Esc`），モバイル用のボトムシート，ライト／ダークテーマ．
- **書き込みなし**: Google のスコープは `spreadsheets.readonly` と `drive.readonly` だけです．鍵が漏れてもシートやファイルは書き換えられません．

## セキュリティ設計（要約）

詳細は [Docs/Design.md](Docs/Design.md)（日本語）の §1・§10 を参照してください．

- **認証が未設定なら全拒否（fail-closed）**: Worker は `ACCESS_TEAM_DOMAIN` か `ACCESS_AUD` が空なら，静的ファイルも含めすべての要求に 503 `access_not_configured` を返します．PHP 版は Basic 認証が実行されていない（`.htaccess` が無い・壊れている）場合に同じく 503 を返します．
- **Worker 内での JWT 再検証**: Cloudflare Access の前段に加え，Worker 自身が `Cf-Access-Jwt-Assertion` ヘッダを RS256 で検証します（`iss`・`aud`・`exp` を検査．Cookie や `Cf-Access-Authenticated-User-Email` ヘッダは信用しません）．`workers.dev` とプレビュー URL は無効です．
- **ローカル開発の迂回は二重条件**: 迂回フラグ（`DEV_BYPASS_ACCESS` / `DEV_BYPASS_AUTH`）とフィクスチャモードは，フラグが立っていて**かつ**ホスト名が `localhost` / `127.0.0.1` のときだけ効きます．PHP 版ではこれらのフラグは PHP 組み込みサーバでしか読まれません．
- **検索語は URL に載せない**: 検索条件は `POST /api/search` の JSON 本文でだけ送ります（URL を自動記録するアクセスログに患者名を残さないため）．`Content-Type: application/json` 以外は 400，別オリジンの `Origin` は 403 です．
- **一致した行だけを返す**: 検索はサーバ側で行い，一覧は要約項目だけ，詳細は1件ずつ返します．DB 全体をブラウザに渡しません．
- **読み取り専用の Google スコープ**: 上記のとおり readonly の2スコープだけです．
- **厳格なレスポンスヘッダ**: 厳しい Content-Security-Policy（インラインスクリプト・インラインスタイルなし），`Cache-Control: no-store`，`X-Robots-Tag: noindex, nofollow, noarchive`，`Referrer-Policy: no-referrer`，`nosniff`，HSTS など．添付の応答は中立的なファイル名と `sandbox` 付き CSP（画像）で返します．
- **ログに ID を書かない**: 1リクエスト1行の JSON ログに，検索語・患者項目・行番号・Drive のファイル ID を書きません．
- **キャッシュ**: Worker はアイソレート内メモリにだけ 60 秒保持します（KV・Cache API は使いません）．PHP 版はディスク上のキャッシュを AES-256-GCM で暗号化します．
- **PHP 版の `Private/` は二重に拒否**: `Private/.htaccess` の `Require all denied`（`<If>` 内にも重ねて記述）と，ルート `.htaccess` の `RewriteRule ^Private(/|$) - [F]` の2段で，認証済みの利用者にも 403 を返します．サービスアカウント鍵は `.php` ファイルとして置くため，仮に拒否規則が壊れても中身が静的ファイルとして配信されることはありません．
- **HTTPS のみ**: PHP 版は HTTP を先に HTTPS へリダイレクトしてからパスワードを求めます．

## 想定するスプレッドシートの列

1枚のワークシート（既定の名前は `患者管理`．設定で変更可）の1行目が見出しで，A〜S 列の19見出しが**この順・この文字列で完全一致**している必要があります．一致しない場合は 503 `sheet_layout_changed` を返し，列ずれしたデータは表示しません．

| 列 | 見出し | 列 | 見出し |
|---|---|---|---|
| A | 区分 | K | 保護者署名 |
| B | 管理番号 | L | 郵便番号 |
| C | 種別 | M | 住所 |
| D | 受診日 | N | 電話番号 |
| E | 氏名 | O | 希望ワクチン |
| F | ふりがな | P | 体温 |
| G | 生年月日 | Q | LOT No. |
| H | 性別 | R | 60～64歳の方 |
| I | 年齢 | S | 自己負担免除対象者 |
| J | 左右 | T | 備考（任意．見出しが「備考」のときだけ読む） |

- 区分は `任意` / `公費`，種別は `インフルエンザ` / `コロナ` を想定しています（`Src/Search.js` の `KINDS` / `CATEGORIES`）．
- 日付は `2026/10/15`・`2026-10-15`・`2026.10.15`・`20261015` を解釈します．年齢は `13`・`１３`・`13歳` を解釈します．
- 要確認フラグの色の判定（RGB 0–1）: 赤 = r≥0.9・g≤0.25・b≤0.25／黄 = r≥0.9・g≥0.9・b≤0.25／橙 = r≥0.9・0.45≤g≤0.75・b≤0.25．見出し行と備考列の色は無視します．
- 19列すべてが空の行は無視します．U 列以降は読みません．

## クイックスタート（フィクスチャデータ．Google アカウント不要）

`Src/Fixture.js` の架空データ30件（実在の患者データは含みません）で動かします．

### Worker 版

前提: Node.js 20 以上．

```sh
npm ci
cp .dev.vars.sample .dev.vars
# .dev.vars は DEV_BYPASS_ACCESS="1" と FIXTURE_MODE="1" の2行だけ残し，GOOGLE_SA_JSON の行は消す
npm run dev
```

ブラウザで http://localhost:8798 を開きます（`npm run dev` は `wrangler dev --local --port 8798 --env local` です）．`.dev.vars` は `.gitignore` 済みです．

### PHP 版

前提: Node.js 20 以上（フィクスチャの書き出しにだけ使用），PHP 8.3 以上と拡張 `intl`・`mbstring`・`openssl`・`curl`・`gd`（WebP 対応）．

```sh
node Php/Tools/ExportFixture.mjs        # Php/Tests/Fixture/FixtureData.json を書き出す
```

続いて環境変数を設定して PHP 組み込みサーバを起動します（`Php/Tools/DevRouter.php` 冒頭のコメントのとおり）．

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

ブラウザで http://localhost:8799 を開きます．暗号化キャッシュとログは既定で `Php/Private/Cache/`・`Php/Private/Logs/`（どちらも `.gitignore` 済み）に作られます．別の場所にしたい場合は `VACCINE_CACHE_DIR`・`VACCINE_LOG_DIR` を設定してください．php.ini が無く拡張が読み込まれない環境では，`-d extension_dir=... -d extension=intl ...` のように明示してください（`Tests/E2E/RunE2E.py` はこれを自動で行います）．

## テスト

| コマンド | 内容 |
|---|---|
| `npm test` | JS の単体テスト（`node --test Tests/Unit/*.test.js`．追加依存なし） |
| `php Php/Tests/Unit/RunUnitTests.php` | PHP の I/O 層の単体テスト（キャッシュ・認証ゲート・ルーティング・画像変換・ヘッダ．ネットワーク不要．終了コード＝失敗数） |
| `node Php/Tests/Parity/GenerateGolden.mjs` → `php Php/Tests/Parity/RunParity.php` | JS と PHP の純粋ロジックが同じ入力にバイト単位で同じ JSON を返すかの比較（詳細は [Php/Tests/Parity/README.md](Php/Tests/Parity/README.md)） |
| `python Tests/E2E/RunE2E.py [--backend php]` | ブラウザでの E2E（フィクスチャモード．既定は Worker 版，`--backend php` で PHP 版） |

E2E には Playwright for Python（`pip install playwright`）とインストール済みの Google Chrome が必要です（`--channel chromium` で Playwright 同梱の Chromium も使えます）．その他のオプション: `--port`（既定 8798），`--headed`，`--only 1,3,7`，`--keep-server`．PHP 版で実行する前に `node Php/Tools/ExportFixture.mjs` を実行してください．失敗時は `logs/` に HTML とスクリーンショットを保存し，終了コードは失敗したシナリオの数です．

## Google 側の準備（両方の版で共通）

1. Google Cloud でプロジェクトを作り，**Google Sheets API** と **Google Drive API** を有効にします．
2. サービスアカウントを作り，JSON 鍵をダウンロードします．鍵はリポジトリに入れないでください．
3. 対象のスプレッドシートをサービスアカウントのメールアドレス（`...@<project>.iam.gserviceaccount.com`）に**閲覧者**として共有します．
4. 添付ファイルを使う場合は，写真・PDF を置く Drive フォルダも同じサービスアカウントに**閲覧者**として共有します．「リンクを知っている全員」には共有しないでください．サービスアカウントが読めるのは共有されたものだけです．HEIC は表示できないため JPEG で保存してください．

## デプロイ: Cloudflare Worker 版

1. **Cloudflare Access**（Zero Trust）で Self-hosted アプリケーションを作ります．Application domain は公開するホスト名（例 `vaccine.example.org`）の全パス，Policy は Allow＋許可するメールアドレスの列挙などにします．作成後に **Application Audience (AUD) Tag** を控えます．
2. `wrangler.jsonc` を編集します．
   - `routes` の `vaccine.example.org` を自分のドメインに変更します（Custom Domain は初回デプロイで自動作成されます）．
   - `vars` に `SHEET_ID`（スプレッドシート ID），`SHEET_NAME`（ワークシート名），`ACCESS_TEAM_DOMAIN`（例 `<team>.cloudflareaccess.com`），`ACCESS_AUD`（AUD タグ）を設定します．いずれも秘密ではありません．
   - `DEV_BYPASS_ACCESS` / `FIXTURE_MODE` は `wrangler.jsonc` に**絶対に書かない**でください（`.dev.vars` 専用です）．
3. サービスアカウントの鍵を秘密として登録します．

   ```sh
   npx wrangler secret put GOOGLE_SA_JSON     # 鍵 JSON の中身を貼り付ける
   ```

4. `npm test` と `npm run e2e` が通ることを確かめてから `npm run deploy` します．
5. **デプロイ後の確認（必須）**: 次のどれも **200 を返してはいけません**．

   ```sh
   curl -I https://vaccine.example.org/                              # Access のログインへ 302
   curl -I https://vaccine.example.org/api/meta                      # 302 / 401 / 403
   curl -I https://vaccine.example.org/api/records/2/attachments/0   # 302
   curl -I https://vaccine-search-portal.<account>.workers.dev/      # 名前解決失敗か 404 / 403
   ```

   そのうえで許可されたメールでログインし，`/api/me` が自分のメールを返すこと，Workers Logs に検索語が記録されていないことを確かめます．

## デプロイ: PHP（共用レンタルサーバ）版

前提: Apache（`.htaccess`・`mod_rewrite`・`mod_headers`・`<If>` が使えること），HTTPS，PHP 8.3 以上と拡張 `intl`・`mbstring`・`openssl`・`curl`・`gd`（WebP 対応）．

1. **ファイルの配置**: サイトのディレクトリ（例 `vaccine.example.org` の公開ディレクトリ）の直下に，`Php/` の中身のうち `.htaccess`・`Api.php`・`Private/` と，`Public/` の中のファイル（`index.html`・`App.js`・`Api.js`・`Render.js`・`Styles.css`・`Favicon.svg`・`Icons.svg`・`Logo.svg`）を**同じ階層に**置きます．`Php/Tests/` と `Php/Tools/` はアップロードしません．

   ```
   <サイトのディレクトリ>/
   ├─ .htaccess         （Php/.htaccess）
   ├─ Api.php           （Php/Api.php．/api/* はすべてここへ書き換えられる）
   ├─ index.html, App.js, Api.js, Render.js, Styles.css, Favicon.svg, Icons.svg, Logo.svg   （Public/ の中身）
   └─ Private/
      ├─ .htaccess      （Php/Private/.htaccess）
      ├─ Config.php
      ├─ Lib/*.php
      ├─ .htpasswd      （手順3で作成）
      └─ ServiceAccount.php   （手順4で作成）
   ```

2. **`.htaccess` の `AuthUserFile`** を，サーバ上の `Private/.htpasswd` の絶対パスに書き換えます（初期値は `/path/to/site/Private/.htpasswd`）．
3. **`Private/.htpasswd` を bcrypt で作成**します．例:

   ```sh
   htpasswd -B -c Private/.htpasswd <ユーザー名>
   # htpasswd が無い場合
   php -r 'echo "<ユーザー名>:" . password_hash("<パスワード>", PASSWORD_BCRYPT) . PHP_EOL;' > Private/.htpasswd
   ```

   Basic 認証のユーザー名が，画面右上とログに出る利用者名になります．
4. **サービスアカウント鍵を `Private/ServiceAccount.php` として作成**します（`.json` のまま置かないでください）．

   ```sh
   php Php/Tools/MakeServiceAccountPhp.php <key.json> > Php/Private/ServiceAccount.php
   ```

   作成した `ServiceAccount.php` を `Private/` にアップロードします．このファイルは `.gitignore` 済みです．
5. **スプレッドシートの指定**: `Private/Config.php` の `sheetId` を設定します（環境変数 `VACCINE_SHEET_ID` を読みます．サーバで環境変数を設定できない場合は `Config.php` に直接書きます）．ワークシート名が `患者管理` でない場合は `sheetName` も変更します．
6. スプレッドシートと添付用の Drive フォルダを，サービスアカウントに**閲覧者**として共有します（上の「Google 側の準備」）．
7. `Private/Cache/` と `Private/Logs/` は初回アクセス時に自動で作られます（PHP からの書き込み権限が必要です）．
8. **デプロイ後の確認（必須）**:

   ```sh
   curl -I http://vaccine.example.org/                         # HTTPS への 301（パスワードを求める前）
   curl -I https://vaccine.example.org/                        # 401（認証なし）
   curl -I https://vaccine.example.org/api/meta                # 401
   curl -I -u <ユーザー>:<パスワード> https://vaccine.example.org/Private/Config.php           # 403
   curl -I -u <ユーザー>:<パスワード> https://vaccine.example.org/Private/ServiceAccount.php   # 403
   curl -I https://vaccine.example.org/.htaccess               # 401 または 403
   ```

   **`Private/` 配下が認証済みでも 403 になること**を必ず確かめてください．その後ブラウザでログインし，検索と詳細表示ができることを確かめます．

## セキュリティ上の問題の報告

脆弱性を見つけた場合は，公開の Issue には書かず [SECURITY.md](SECURITY.md) の手順に従って報告してください．

## 免責事項

本ソフトウェアは認証を受けた医療機器や電子カルテ（EHR）ではなく，診療上の判断に使うことを意図していません．患者の個人情報を扱うため，運用者は個人情報保護法や「医療情報システムの安全管理に関するガイドライン」など，適用される法令・ガイドラインへの適合について自らの責任で確認・対応してください．本ソフトウェアは無保証で提供されます．

## ライセンス

[MIT License](LICENSE)
