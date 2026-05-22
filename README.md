# aws-cdk-serverless-api

[![CI](https://github.com/satoshif1977/aws-cdk-serverless-api/actions/workflows/ci.yml/badge.svg)](https://github.com/satoshif1977/aws-cdk-serverless-api/actions/workflows/ci.yml)
![AWS CDK](https://img.shields.io/badge/AWS_CDK-TypeScript-blue?logo=amazon-aws)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?style=flat&logo=node.js&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?style=flat&logo=amazon-aws&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-orange?logo=anthropic)
![Claude Cowork](https://img.shields.io/badge/Daily%20Use-Claude%20Cowork-blueviolet?logo=anthropic)
![Claude Skills](https://img.shields.io/badge/Custom-Skills%20Configured-green?logo=anthropic)

AWS CDK（TypeScript）で実装したサーバーレス API。
API Gateway HTTP API（REST CRUD）+ WebSocket API（リアルタイムブロードキャスト）+ Lambda + DynamoDB をコードだけで構築します。

## アーキテクチャ

![アーキテクチャ図](docs/architecture.drawio.png)

> draw.io ソースファイルは `docs/architecture.drawio` にあります。[app.diagrams.net](https://app.diagrams.net) で開くか、draw.io デスクトップアプリで「Open from → This device」から開いてください。

```
クライアント（HTTP）
    │ HTTPS
    ▼
Amazon API Gateway HTTP API
    │ GET /items?limit=N&nextToken=xxx  → 全件取得（カーソルページネーション）
    │ GET /items/{id}                   → 1件取得
    │ POST /items                       → 新規作成
    │ PUT /items/{id}                   → 更新
    │ DELETE /items/{id}                → 削除
    ▼ Lambda 統合
AWS Lambda - items-handler (Node.js 22.x)
    │ GetItem/PutItem/DeleteItem/Scan
    ▼
Amazon DynamoDB - items テーブル (PAY_PER_REQUEST)

クライアント（WebSocket）
    │ WSS
    ▼
Amazon API Gateway WebSocket API
    │ $connect    → 接続登録
    │ $disconnect → 接続削除
    │ $default    → 全接続へブロードキャスト
    ▼ Lambda 統合
AWS Lambda - ws-handler (Node.js 22.x)
    │ PutItem/DeleteItem/Scan + PostToConnection
    ▼
Amazon DynamoDB - connections テーブル (TTL: 24時間)
```

## 技術スタック

| 技術 | 内容 |
|---|---|
| AWS CDK v2 | IaC（TypeScript） |
| API Gateway HTTP API | REST エンドポイント（CORS・カーソルページネーション） |
| API Gateway WebSocket API | リアルタイムブロードキャスト（$connect/$disconnect/$default） |
| Lambda NodejsFunction | TypeScript → esbuild で自動バンドル |
| DynamoDB | PAY_PER_REQUEST（TTL による接続自動クリーンアップ） |
| AWS SDK v3 | `@aws-sdk/client-dynamodb` / `@aws-sdk/client-apigatewaymanagementapi` |
| Jest + CDK Assertions | ユニットテスト（26件） |
| GitHub Actions | push / PR 時に型チェック & テスト自動実行 |

## ディレクトリ構成

```
aws-cdk-serverless-api/
├── bin/
│   └── aws-cdk-serverless-api.ts        # CDK App エントリーポイント
├── lib/
│   └── aws-cdk-serverless-api-stack.ts  # CDK スタック定義
├── src/
│   └── handlers/
│       ├── items.ts                     # Lambda ハンドラー（HTTP CRUD）
│       └── ws.ts                        # Lambda ハンドラー（WebSocket）
├── test/
│   ├── aws-cdk-serverless-api.test.ts   # CDK Assertions テスト（インフラ）
│   ├── items.handler.test.ts            # items ハンドラー ユニットテスト
│   └── ws.handler.test.ts               # ws ハンドラー ユニットテスト
└── .github/workflows/ci.yml             # GitHub Actions CI
```

## デプロイ手順

### 前提条件

- Node.js 22+
- AWS CLI 設定済み（`ap-northeast-1`）
- AWS CDK v2 インストール済み（`npm install -g aws-cdk`）

### 1. 依存パッケージインストール

```bash
npm install
```

### 2. CDK Bootstrap（初回のみ）

```bash
cdk bootstrap aws://YOUR_ACCOUNT_ID/ap-northeast-1
```

### 3. デプロイ

```bash
cdk deploy
```

デプロイ完了後、`ApiEndpoint`（HTTP）と `WsEndpoint`（WebSocket）の URL が出力されます。

### 4. 動作確認（HTTP API）

```bash
# アイテム作成
curl -X POST https://<API_ENDPOINT>/items \
  -H "Content-Type: application/json" \
  -d '{"name": "テストアイテム", "price": 1000}'

# 全件取得（ページネーション）
curl "https://<API_ENDPOINT>/items?limit=5"

# 次ページ取得
curl "https://<API_ENDPOINT>/items?limit=5&nextToken=<nextToken>"

# 1件取得
curl https://<API_ENDPOINT>/items/<ID>

# 更新
curl -X PUT https://<API_ENDPOINT>/items/<ID> \
  -H "Content-Type: application/json" \
  -d '{"name": "更新後アイテム", "price": 2000}'

# 削除
curl -X DELETE https://<API_ENDPOINT>/items/<ID>
```

### 5. 動作確認（WebSocket API）

```bash
# wscat インストール（初回のみ）
npm install -g wscat

# 接続（ターミナル1）
wscat -c wss://<WS_ENDPOINT>

# 接続（ターミナル2 - 別ウィンドウで）
wscat -c wss://<WS_ENDPOINT>

# ターミナル1 から送信すると、接続中の全クライアントにブロードキャストされます
> {"action":"hello","data":"こんにちは！"}
```

> `WS_ENDPOINT` は `cdk deploy` 出力の `WsEndpoint` から `wss://` プレフィックスを確認してください。
> 切断済みの接続は DynamoDB TTL（24時間）で自動削除されます。

### 6. リソース削除

```bash
cdk destroy
```

## ローカルテスト

```bash
npm test
```

CDK Assertions・ハンドラーユニットテスト合計 26件がローカルで実行されます。
実際の AWS 環境への接続は不要です。

## 技術的なポイント・工夫

- **CDK NodejsFunction**: TypeScript のハンドラーコードを esbuild で自動バンドル。`tsc` でのコンパイル不要
- **HTTP API（v2）vs REST API（v1）**: HTTP API はコストが約70%低く、シンプルな CRUD には最適
- **カーソルページネーション**: `LastEvaluatedKey` を base64url エンコードして `nextToken` として返す。DynamoDB ネイティブのページング方式
- **WebSocket API**: $connect/$disconnect/$default ルートで接続管理・全接続へのブロードキャストを実装
- **GoneException 処理**: 送信失敗（クライアント切断済み）を `GoneException` で検知し DynamoDB から自動削除
- **DynamoDB TTL**: 接続レコードに 24時間後の Unix タイムスタンプを `ttl` フィールドで付与。切断後のゴミレコードを自動削除
- **PAY_PER_REQUEST**: DynamoDB のプロビジョニング不要モード。開発・低トラフィック環境でコスト最小
- **AWS SDK v3**: v2 より軽量・Tree Shaking 対応。`marshall` / `unmarshall` で型安全な DynamoDB 操作
- **CDK Assertions**: `Template.fromStack()` でインフラをユニットテスト。CloudFormation テンプレートの構造を検証
- **CORS 設定**: `corsPreflight` を HTTP API レベルで一元設定

## AWS Well-Architected 観点

| 柱 | 対応内容 |
|---|---|
| セキュリティ | IAM 最小権限（`grantReadWriteData` / `grantManageConnections` で必要な権限のみ付与） |
| コスト最適化 | PAY_PER_REQUEST + HTTP API で使った分だけ課金・TTL で不要レコードを自動削除 |
| 運用性 | CloudWatch Logs 自動設定・1週間保持（HTTP / WebSocket 両 Lambda） |
| 信頼性 | DynamoDB はマネージドサービスで自動フェイルオーバー・GoneException で接続状態を自動整合 |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and security policies.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
