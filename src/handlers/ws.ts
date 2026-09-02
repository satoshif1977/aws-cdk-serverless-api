import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { WsEvent } from './types';
import { retryAsync, extractErrorCode } from './retry';
import type { RetryOptions } from './retry';

// ── 初期化 ────────────────────────────────────────────────────────
const logger = new Logger({ serviceName: 'ws-handler' });
const tracer = new Tracer({ serviceName: 'ws-handler' });
const metrics = new Metrics({ namespace: 'ServerlessApi', serviceName: 'ws-handler' });
const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({ region: process.env.REGION }));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

// ── リトライ ──────────────────────────────────────────────────────
// DynamoDB と API Gateway Management API の一時的な失敗に対して、
// 指数バックオフ + フルジッターで再試行する。
// GoneException（410・切断済み接続）はリトライ対象外なので、
// 下の切断済み接続の掃除ロジックはそのまま機能する。
// テストからは RETRY_OPTIONS.sleep を差し替えることで実待機なしに検証できる。
export const RETRY_OPTIONS: RetryOptions = {
  config: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2000 },
  onRetry: (attempt, delayMs, error) =>
    logger.warn('AWS 呼び出しをリトライします', {
      attempt,
      delayMs,
      errorCode: extractErrorCode(error),
    }),
};

const sendWithRetry = <T>(fn: () => Promise<T>): Promise<T> => retryAsync(fn, RETRY_OPTIONS);

// ── $connect ──────────────────────────────────────────────────────
const onConnect = async (connectionId: string): Promise<{ statusCode: number }> => {
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24時間後（Unix秒）
  await sendWithRetry(() =>
    dynamo.send(
      new PutItemCommand({
        TableName: CONNECTIONS_TABLE,
        Item: marshall({ connectionId, connectedAt: new Date().toISOString(), ttl }),
      }),
    ),
  );
  metrics.addMetric('WebSocketConnected', MetricUnit.Count, 1);
  return { statusCode: 200 };
};

// ── $disconnect ───────────────────────────────────────────────────
const onDisconnect = async (connectionId: string): Promise<{ statusCode: number }> => {
  await sendWithRetry(() =>
    dynamo.send(
      new DeleteItemCommand({
        TableName: CONNECTIONS_TABLE,
        Key: marshall({ connectionId }),
      }),
    ),
  );
  metrics.addMetric('WebSocketDisconnected', MetricUnit.Count, 1);
  return { statusCode: 200 };
};

// ── $default（全接続へブロードキャスト） ─────────────────────────
const onMessage = async (
  connectionId: string,
  body: string,
  endpoint: string,
): Promise<{ statusCode: number }> => {
  const apigw = new ApiGatewayManagementApiClient({ endpoint });

  const result = await sendWithRetry(() =>
    dynamo.send(new ScanCommand({ TableName: CONNECTIONS_TABLE })),
  );
  const connections = (result.Items ?? []).map((item) => unmarshall(item));

  const payload = Buffer.from(
    JSON.stringify({ from: connectionId, message: body, timestamp: new Date().toISOString() }),
  );

  await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await sendWithRetry(() =>
          apigw.send(
            new PostToConnectionCommand({
              ConnectionId: conn.connectionId as string,
              Data: payload,
            }),
          ),
        );
      } catch (err) {
        if (err instanceof GoneException) {
          // 切断済みの接続を DynamoDB から削除
          await sendWithRetry(() =>
            dynamo.send(
              new DeleteItemCommand({
                TableName: CONNECTIONS_TABLE,
                Key: marshall({ connectionId: conn.connectionId }),
              }),
            ),
          );
        }
      }
    }),
  );

  metrics.addMetric('MessageBroadcast', MetricUnit.Count, 1);
  return { statusCode: 200 };
};

// ── エントリーポイント ────────────────────────────────────────────
export const handler = async (event: WsEvent): Promise<{ statusCode: number }> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;
  logger.info('WebSocket event', { connectionId, routeKey });

  try {
    switch (routeKey) {
      case '$connect':
        return onConnect(connectionId);
      case '$disconnect':
        return onDisconnect(connectionId);
      default:
        return onMessage(connectionId, event.body ?? '', endpoint);
    }
  } finally {
    metrics.publishStoredMetrics();
  }
};
