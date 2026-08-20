# contact — LP フォーム受け口（Cloud Run・案A''）

フォーム POST を検証し、内部転送メール（apply+タグ@）として受信箱へ送る Cloud Run サービス。
既存パイプライン（受信箱→mail_bridge→intake）は無改修で流用する（Phase 1 設計）。
Firebase は使わない（2026-08-20 案A'' 採用——ホスティングは GitHub Pages のまま・
フォームの action がこのサービスの run.app URL を直接指す）。

## 環境変数（Cloud Run サービスに一度設定・以後のデプロイに引き継がれる）

- `SENDER_USER` — 転送メールの送信名義となる Workspace ユーザー（DWD で偽装。推奨: info@）
- `FORWARD_ADDRESS` — 内部転送の宛先 `apply+<現行タグ>@takeblueprint.com`。タグの正典は app0002 registry/intake_config.json
- `THANKS_URL` — 省略可（既定 https://takeblueprint.com/thanks.html）

※タグ・宛先はコード・リポジトリに置かない（本リポは Public）。

## 統治要件（GOV-0004）

- 入力値（名前・連絡先・本文）を**ログに残さない**。ログは結果コードと時刻のみ
- 転送メール本文は現行 mailto と同一フォーマット＋「ご連絡先メールアドレス」行（Reply-To ヘッダにも設定）
- `Origin` ヘッダ検証: https://takeblueprint.com 以外の明示 Origin は 403

## 送信の仕組み（キーレス DWD）

サービスアカウント鍵ファイルは使わない。実行 SA が IAM Credentials `signJwt` で
自身の JWT（sub=SENDER_USER・scope=gmail.send）に署名 → OAuth トークン交換 → Gmail API `messages.send`。

事前設定（一度だけ・Cloud Shell 可）:
1. 実行 SA に `roles/iam.serviceAccountTokenCreator`（自分自身に対して）
2. Google admin console → セキュリティ → API の制御 → ドメイン全体の委任:
   実行 SA のクライアント ID に scope `https://www.googleapis.com/auth/gmail.send` を承認

## デプロイ（GitHub Actions・WIF キーレス）

`.github/workflows/deploy-contact.yml` が main への push（functions/ 配下の変更時）で
Cloud Run へデプロイする。**本番トークンはどのマシンにも置かない**——認証は
Workload Identity Federation（このリポの main に限定）。ローカル CLI 不要。

一度だけの初期設定（Cloud Shell で実行・詳細はコメント付きで同ファイル参照）:
プロジェクト作成 → 課金紐付け → API 有効化（run/cloudbuild/artifactregistry/iamcredentials/gmail）
→ デプロイ用 SA と WIF プール/プロバイダ（repo 限定）→ リポの Actions Variables に
`GCP_WIF_PROVIDER` / `GCP_DEPLOY_SA` を登録 → 環境変数をサービスに設定。

## ローカル動作確認

```
cd functions && npm install && npm start   # http://localhost:8080/
curl -i -X POST localhost:8080 -d "name=x"                # → 400（検証）
curl -i -X POST localhost:8080 -d "website=bot"           # → 303（honeypot 吸収）
```
（送信段まで通すには GCP メタデータが必要なためローカルでは 500 で正常）

## デプロイ後の E2E 手順（フォーム接続）

1. `gcloud run services describe contact --format='value(status.url)'` で URL を取得
2. index.html の `<form action>` と CSP `form-action` をその URL に書き換え（このブランチ上）
3. テスト送信 → 受信箱→mail_bridge→intake の一周を確認 → 平行運用 → main へマージ=リリース
