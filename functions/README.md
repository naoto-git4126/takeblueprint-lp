# /api/contact — LP フォーム受け口（PoC）

フォーム POST を検証し、内部転送メール（apply+タグ@）として受信箱へ送る Cloud Function。
既存パイプライン（受信箱→mail_bridge→intake）は無改修で流用する（Phase 1 設計）。

## 環境変数（functions/.env.<project-id> に置く・git 管理外）

- `SENDER_USER` — 転送メールの送信名義となる Workspace ユーザー（DWD で偽装。推奨: info@）
- `FORWARD_ADDRESS` — 内部転送の宛先 `apply+<現行タグ>@takeblueprint.com`。タグの正典は app0002 registry/intake_config.json（正典同期は 0007-02-post B改定で条文化予定）

## 統治要件（GOV-0004）

- 入力値（名前・連絡先・本文）を**ログに残さない**。ログは結果コードと時刻のみ
- 転送メール本文は現行 mailto と同一フォーマット＋「ご連絡先メールアドレス」行を追加（Reply-To ヘッダにも設定）

## 送信の仕組み（キーレス DWD）

サービスアカウント鍵ファイルは使わない。関数の実行 SA が IAM Credentials `signJwt` で
自身の JWT（sub=SENDER_USER・scope=gmail.send）に署名 → OAuth トークン交換 → Gmail API `messages.send`。

必要な事前設定:
1. 関数の実行 SA に `roles/iam.serviceAccountTokenCreator`（自分自身に対して）
2. Google admin console → セキュリティ → API の制御 → ドメイン全体の委任: 実行 SA の
   クライアント ID に scope `https://www.googleapis.com/auth/gmail.send` を承認
