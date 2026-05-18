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

    // ── Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API エンドポイント',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB テーブル名',
    });
  }
}
