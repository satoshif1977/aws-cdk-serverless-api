import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export class AwsCdkServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB テーブル ────────────────────────────────────────
    const table = new dynamodb.Table(this, 'ItemsTable', {
      tableName: `${id}-items`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev 用: スタック削除時にテーブルも削除
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: false, // dev 用: 本番では true 推奨
      },
    });

    // ── CloudWatch Logs グループ（Lambda 用） ─────────────────────
    const logGroup = new logs.LogGroup(this, 'ItemsHandlerLogGroup', {
      logGroupName: `/aws/lambda/${id}-items-handler`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda 関数（NodejsFunction + esbuild バンドル） ───────────
    const itemsHandler = new nodejs.NodejsFunction(this, 'ItemsHandler', {
      functionName: `${id}-items-handler`,
      entry: path.join(__dirname, '../src/handlers/items.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        REGION: this.region,
        POWERTOOLS_TRACE_DISABLED: 'true', // dev: PASS_THROUGH のため無効化（本番では削除して Tracing.ACTIVE に変更）
      },
      logGroup,
      tracing: lambda.Tracing.PASS_THROUGH, // dev: X-Ray コスト無料
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
      },
    });

    // DynamoDB 読み書き権限を Lambda に付与
    table.grantReadWriteData(itemsHandler);

    // ── API Gateway HTTP API ──────────────────────────────────────
    const httpApi = new apigatewayv2.HttpApi(this, 'ItemsHttpApi', {
      apiName: `${id}-items-api`,
      corsPreflight: {
        allowHeaders: ['Content-Type'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowOrigins: ['*'],
      },
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'ItemsIntegration',
      itemsHandler,
    );

    // ルート定義
    httpApi.addRoutes({
      path: '/items',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/items',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/items/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/items/{id}',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/items/{id}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: lambdaIntegration,
    });

    // ── DynamoDB テーブル（WebSocket 接続管理） ───────────────────
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: `${id}-connections`,
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      timeToLiveAttribute: 'ttl', // 切断済み接続を 24h 後に自動削除
    });

    // ── CloudWatch Logs グループ（WebSocket Lambda 用） ───────────
    const wsLogGroup = new logs.LogGroup(this, 'WsHandlerLogGroup', {
      logGroupName: `/aws/lambda/${id}-ws-handler`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda 関数（WebSocket ハンドラー） ───────────────────────
    const wsHandler = new nodejs.NodejsFunction(this, 'WsHandler', {
      functionName: `${id}-ws-handler`,
      entry: path.join(__dirname, '../src/handlers/ws.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        REGION: this.region,
        POWERTOOLS_TRACE_DISABLED: 'true', // dev: PASS_THROUGH のため無効化（本番では削除して Tracing.ACTIVE に変更）
      },
      logGroup: wsLogGroup,
      tracing: lambda.Tracing.PASS_THROUGH,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });

    connectionsTable.grantReadWriteData(wsHandler);

    // ── API Gateway WebSocket API ─────────────────────────────────
    const wsApi = new apigatewayv2.WebSocketApi(this, 'ItemsWsApi', {
      apiName: `${id}-ws-api`,
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('WsConnectIntegration', wsHandler),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('WsDisconnectIntegration', wsHandler),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('WsDefaultIntegration', wsHandler),
      },
    });

    const wsStage = new apigatewayv2.WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi,
      stageName: 'dev',
      autoDeploy: true,
    });

    // WebSocket 送信権限（execute-api:ManageConnections）を Lambda に付与
    wsApi.grantManageConnections(wsHandler);

    // ── Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API エンドポイント',
    });
    new cdk.CfnOutput(this, 'WsEndpoint', {
      value: wsStage.url,
      description: 'API Gateway WebSocket API エンドポイント（wss://）',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB テーブル名',
    });

    // ── cdk-nag v3 suppressions（dev 環境の意図的な省略） ──────────
    // v3: NagSuppressions.addStackSuppressions → cdk.Validations.of().acknowledge() に移行
    // ARN を含む finding ID は CDK Validations API が :: 区切りと衝突して拒否するため、
    // 該当するものは node.addMetadata(ACKNOWLEDGED_RULES_METADATA_KEY, {...}) で直接投入する。
    const ACK_KEY = 'aws:cdk:acknowledged-rules';

    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'NODEJS_22_X は現時点で最新の Lambda ランタイム。cdk-nag のルール定義が追いついていないため抑制。',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-APIG1',
      reason: 'dev 環境のため API アクセスログは省略。本番では CloudWatch Logs への access log destination を設定すること。',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason: 'デモ用 API のため認証は未実装。本番では IAM / Cognito / Lambda Authorizer による認可を追加すること。',
    });

    // IAM4: AWSLambdaBasicExecutionRole の finding ID は ARN 内に <AWS::Partition> を含み
    // CDK Validations API が :: 衝突で拒否するため node.addMetadata で直接抑制する。
    const iam4FindingId =
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]';
    for (const handler of [itemsHandler, wsHandler]) {
      handler.node.addMetadata(ACK_KEY, {
        [iam4FindingId]:
          'AWSLambdaBasicExecutionRole は CDK NodejsFunction が自動付与する標準マネージドポリシー。Lambda 基本実行権限として許容。',
      });
    }

    // IAM5 Resource::* （X-Ray / DynamoDB ワイルドカード）
    // CDK Validations API は [] 内の :: を許容するためこちらは通常 acknowledge で対応可。
    for (const handler of [itemsHandler, wsHandler]) {
      handler.node.findAll().forEach(child => {
        const cfn = child as cdk.CfnResource;
        if (cfn.cfnResourceType === 'AWS::IAM::Policy') {
          cdk.Validations.of(cfn).acknowledge({
            id: 'AwsSolutions-IAM5[Resource::*]',
            reason: 'CDK の grantReadWriteData が自動生成するワイルドカード権限（X-Ray / DynamoDB）。最小権限の範囲内として許容。',
          });
        }
      });
    }

    // IAM5 execute-api ARN: grantManageConnections が生成する ARN には AccountId を含む
    // finding ID が CDK Validations API に拒否されるため node.addMetadata で直接 CfnPolicy に投入する。
    // .logicalId は construction 時点では lazy token を返すため Stack.getLogicalId() で解決する
    const wsApiLogicalId = cdk.Stack.of(this).getLogicalId(wsApi.node.defaultChild as cdk.CfnElement);
    // this.region がトークン（未解決）の場合は flattenCfnReference が <AWS::Region> に変換するため分岐する
    const regionPart = cdk.Token.isUnresolved(this.region) ? '<AWS::Region>' : this.region;
    // Ref を経由する値は flattenCfnReference が <LogicalId> 形式に変換するため <> で囲む
    const executeApiResource = `arn:aws:execute-api:${regionPart}:<AWS::AccountId>:<${wsApiLogicalId}>/*/*/@connections/*`;
    wsHandler.node.findAll().forEach(child => {
      const cfn = child as cdk.CfnResource;
      if (cfn.cfnResourceType === 'AWS::IAM::Policy') {
        cfn.node.addMetadata(ACK_KEY, {
          [`AwsSolutions-IAM5[Resource::${executeApiResource}]`]:
            'grantManageConnections が自動生成する WebSocket execute-api ARN。接続 ID が動的なため /* ワイルドカードが不可避。',
        });
      }
    });

    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-DDB3',
      reason: 'dev 環境のため PITR は無効。本番では pointInTimeRecoveryEnabled: true を設定すること。',
    });
  }
}
