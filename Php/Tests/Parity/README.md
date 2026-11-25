# パリティテスト（JS ⇔ PHP）

Cloudflare Worker の純粋ロジック（`Src/Normalize.js`・`Src/Attachments.js`・`Src/Records.js`・`Src/Search.js`）と，共用サーバー用 PHP 移植版（`Php/Private/Lib/*.php`）が同じ入力に対して**バイト単位で同じ JSON** を返すことを確かめるテストです．

## 実行方法（リポジトリ直下で）

```
node Php/Tests/Parity/GenerateGolden.mjs
php Php/Tests/Parity/RunParity.php
```

1. `GenerateGolden.mjs` が JS 実装を実行し，`Golden.json`（入力と `JSON.stringify` した出力の組）を書き出します．
2. `RunParity.php` が同じ入力で PHP 実装を実行し，`json_encode($x, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)` の結果を文字列比較します．関数ごとの合否と先頭の差分を表示し，不一致が 1 件でもあれば終了コード 1 を返します．

### オプション

| オプション | 意味 |
|---|---|
| `--max-diffs=N` | 詳細表示する不一致の件数（既定 20） |

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 全件一致 |
| 1 | 不一致あり |
| 2 | 準備エラー（Golden.json が無い，intl/mbstring が読めない） |

## 前提

- Node.js 20 以上（ESM と `structuredClone` を使用）．
- PHP 8.3 以上，拡張 `intl` と `mbstring`．php.ini が無く拡張が未ロードの場合（WinGet 版 PHP など），`RunParity.php` は PHP 本体と同じフォルダの `ext` を指定して自分自身を自動で再起動します．

## データについて

`Golden.json` は合成データ `Src/Fixture.js` と，このスクリプト内に手書きした架空の文字列・URL だけから作られます．実在の患者データは含みません．

## 除外扱いのケース

`json_decode($x, true)`（I/O 層の契約）では，JSON の `[]` と `{}`，および `{"0": ..}` のようなキーを持つオブジェクトと配列を区別できません．該当ケースは `assocAmbiguous` として集計から除外し，件数を表示します．`parseQuery` については `json_decode($x)`（オブジェクト）でデコードし `parseQuery($body, true)` を呼ぶモードで厳密に比較しています．
