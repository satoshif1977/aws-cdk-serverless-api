import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';

describe('AwsCdkServerlessApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AwsCdkServerlessApiStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  test('DynamoDB テーブルが PAY_PER_REQUEST で作成される', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    });
  });

  test('Lambda 関数が Node.js 22.x で作成される', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  test('Lambda の IAM ポリシーに DynamoDB アクションが含まれる', () => {
    // ポリシー内のいずれかのステートメントに dynamodb: アクションが存在することを確認
    const policies = template.findResources('AWS::IAM::Policy');
    const allActions = Object.values(policies).flatMap((p: any) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ),
    );
    const dynamoActions = allActions.filter((a: string) =>
      a.startsWith('dynamodb:'),
    );
    expect(dynamoActions).toContain('dynamodb:PutItem');
    expect(dynamoActions).toContain('dynamodb:GetItem');
    expect(dynamoActions).toContain('dynamodb:DeleteItem');
    expect(dynamoActions).toContain('dynamodb:Scan');
  });

  test('API Gateway HTTP API が作成される', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
  });

  test('API Gateway ルートが 8 件作成される（HTTP 5件 + WebSocket 3件）', () => {
    // HTTP: GET/POST /items, GET/PUT/DELETE /items/{id} = 5
    // WebSocket: $connect / $disconnect / $default = 3
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 8);
  });

  test('CloudWatch Logs グループが 1 週間の保持期間で作成される', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });

  test('ApiEndpoint の Output が存在する', () => {
    template.hasOutput('ApiEndpoint', {});
  });

  test('WsEndpoint の Output が存在する', () => {
    template.hasOutput('WsEndpoint', {});
  });

  test('WebSocket API が作成される', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 2); // HTTP + WebSocket
  });
});
