# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
