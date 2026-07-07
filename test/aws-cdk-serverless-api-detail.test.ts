import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';

describe('AwsCdkServerlessApiStack - 詳細検証', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AwsCdkServerlessApiStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  // ── Lambda 環境変数 ───────────────────────────────────────────────
  test('items-handler の環境変数 TABLE_NAME が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('ws-handler の環境変数 CONNECTIONS_TABLE が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONNECTIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test('Lambda 環境変数 REGION が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REGION: Match.anyValue(),
        }),
      },
    });
  });

  // ── DynamoDB ─────────────────────────────────────────────────────
  test('ConnectionsTable のパーティションキーが connectionId (STRING) である', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
    });
  });

  test('DynamoDB テーブルが 2件作成される（ItemsTable・ConnectionsTable）', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  // ── API Gateway CORS ─────────────────────────────────────────────
  test('HTTP API の CORS allowOrigins が * に設定されている', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['*'],
      }),
    });
  });

  test('HTTP API の CORS allowHeaders に Content-Type が含まれる', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowHeaders: ['Content-Type'],
      }),
    });
  });

  // ── API Gateway WebSocket ルートキー ─────────────────────────────
  test('WebSocket API に $connect ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$connect',
    });
  });

  test('WebSocket API に $disconnect ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$disconnect',
    });
  });

  test('WebSocket API に $default ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$default',
    });
  });

  // ── API Gateway HTTP ルートキー ──────────────────────────────────
  test('HTTP API に GET /items ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /items',
    });
  });

  test('HTTP API に POST /items ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /items',
    });
  });

  test('HTTP API に DELETE /items/{id} ルートが作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'DELETE /items/{id}',
    });
  });

  // ── WebSocket ステージ ────────────────────────────────────────────
  test('WebSocket ステージ名が dev である', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: 'dev',
    });
  });

  test('WebSocket ステージが AutoDeploy に設定されている', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AutoDeploy: true,
    });
  });

  // ── IAM ──────────────────────────────────────────────────────────
  test('Lambda 実行ロールが 2件作成される（items-handler・ws-handler 各1件）', () => {
    template.resourceCountIs('AWS::IAM::Role', 2);
  });

  // ── CloudWatch Logs グループ名 ────────────────────────────────────
  test('ログループ名に items-handler が含まれる', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('items-handler'),
    });
  });

  test('ログループ名に ws-handler が含まれる', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('ws-handler'),
    });
  });
});
