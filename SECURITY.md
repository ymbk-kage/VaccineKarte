# Security Policy / セキュリティポリシー

VaccineKarte handles patient personal and health information (name, date of birth, address, phone number, vaccination details). Security reports are taken seriously.

VaccineKarte は患者の個人情報・健康情報（氏名，生年月日，住所，電話番号，接種内容）を扱います．脆弱性の報告を歓迎します．

## Supported versions / サポート対象

| Version | Supported |
|---|---|
| `main` branch (latest) | Yes |
| Older commits / forks | No |

## Reporting a vulnerability / 脆弱性の報告

**Please do not open a public issue for security problems.**
**公開 Issue には書かないでください．**

1. Use GitHub's **private vulnerability reporting**: *Security* tab → *Report a vulnerability*.
   GitHub の **Private vulnerability reporting**（*Security* タブ → *Report a vulnerability*）から報告してください．
2. Include: affected backend (Cloudflare Worker / PHP), version or commit, reproduction steps, and impact.
   影響するバックエンド（Cloudflare Worker / PHP），コミット，再現手順，影響を書いてください．
3. **Never include real patient data** in a report. Use the synthetic fixture (`Src/Fixture.js`).
   **実在の患者データは絶対に含めないでください**．合成データ（`Src/Fixture.js`）で再現してください．

## What to expect / 対応の目安

| Step | Target |
|---|---|
| Acknowledgement / 受領連絡 | within 3 business days / 3 営業日以内 |
| Initial assessment / 初期評価 | within 7 business days / 7 営業日以内 |
| Fix and advisory / 修正と勧告 | as soon as practical; a GitHub Security Advisory (with CVE when applicable) is published after the fix |

Reporters are credited in the advisory unless they ask otherwise.
報告者は，希望がない限り勧告に記名します．

## Scope / 対象範囲

In scope / 対象:

- Authentication or authorization bypass (Cloudflare Access JWT verification, PHP Basic-auth gate, fail-closed behaviour)
- Exposure of records, attachments, service-account keys, caches or logs (e.g. `Php/Private/` reachable over HTTP)
- Leakage of search terms or identifiers into URLs, logs or caches
- XSS, injection, SSRF via attachment links, CSP bypass
- Weaknesses in the encrypted cache (`SecureCache`)

Out of scope / 対象外:

- Misconfiguration of a specific deployment (e.g. Access policy allowing everyone, weak Basic-auth password)
- Vulnerabilities in Cloudflare, Google APIs or the hosting provider themselves
- Denial of service by volume

## Design reference / 設計資料

The threat model and defence-in-depth decisions are in [`Docs/Design.md` §1](Docs/Design.md) (Japanese).
脅威モデルと多層防御の方針は [`Docs/Design.md` §1](Docs/Design.md) にあります．
