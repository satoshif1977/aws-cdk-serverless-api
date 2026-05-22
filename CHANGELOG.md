# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.0.0] - 2026-05-22

### Added
- **WebSocket API 追加**（リアルタイムブロードキャスト）
  - API Gateway WebSocket API（$connect / $disconnect / $default ルート）
  - `src/handlers/ws.ts`：接続管理・全接続へのブロードキャスト
  - `GoneException` 捕捉による切断済み接続の自動クリーンアップ
  - `Promise.allSettled` によるブロードキャスト中の部分失敗許容
- **DynamoDB connections テーブル**（接続管理用）
  - TTL（`timeToLiveAttribute: 'ttl'`）で切断後 24h 後に自動削除
  - `onConnect` 時に Unix 秒の TTL フィールドを書き込み
- **WebSocket ユニットテスト追加**（`test/ws.handler.test.ts`・5ケース）
  - $connect / $disconnect / ブロードキャスト / GoneException 削除 / 接続なし
- **カーソルベースページネーション**（`GET /items`）
  - `?limit=N`（デフォルト 20・最大 100）+ `?nextToken=xxx` クエリパラメータ
  - レスポンスに `nextToken`（次ページトークン or null）と `count` を追加
  - 旧：do-while 全件取得 → 新：単一 Scan + Limit（API として正しい設計）
- **構成図更新**（`docs/architecture.drawio` / `.png`）
  - HTTP フロー + WebSocket フロー 2系統を 1枚に統合
  - ステップバッジ 1〜7・右側凡例パネル・CloudWatch Logs 補助サービスゾーン追加

### Changed
- テスト件数：19件 → **26件**（CDK Assertions 9 + items ハンドラー 12 + ws ハンドラー 5）
- README：WebSocket API・wscat 手順・ページネーション・ディレクトリ構成を全面更新

## [1.2.0] - 2026-05-19

### Fixed
- API Gateway ルート数のテストを 4 → 5 件に修正（PUT /items/{id} が漏れていた）
- README のアーキテクチャ図に `PUT /items/{id}` を追記
- README の動作確認サンプルに PUT の curl コマンドを追加
- README の GET /items にページネーション対応の注記を追加

## [1.1.0] - 2026-05-13

### Added
- `PUT /items/{id}` エンドポイント追加（既存アイテムの更新）
- `GET /items` 全件取得にページネーション対応（`LastEvaluatedKey` ループ）
- アーキテクチャ構成図（draw.io）追加（`docs/architecture.drawio` / `docs/architecture.drawio.png`）

### Changed
- `handler()` を `if/else` チェーンからディスパッチテーブル（`ROUTES` オブジェクト）にリファクタリング
  - メソッド × リソース種別（collection/item）の組み合わせで O(1) ルーティング
- README にバッジ・LICENSE・Security セクションを追加

### Fixed
- CI の `npm ci` を `npm install` に変更（lockfile バージョン差異による CI 失敗を解消）
- `@aws-cdk/aws-lambda-nodejs` 余剰パッケージを削除（lock file 再生成）

## [1.0.0] - 2026-04-15

### Added
- 初回実装：API Gateway HTTP API + Lambda（NodejsFunction）+ DynamoDB による サーバーレス CRUD API
  - `GET /items` 全件取得
  - `GET /items/{id}` 1件取得
  - `POST /items` 新規作成
  - `DELETE /items/{id}` 削除
- AWS CDK v2（TypeScript）でインフラ全体を IaC 化
- Jest + CDK Assertions によるインフラユニットテスト
- GitHub Actions CI（型チェック・テスト自動実行）
