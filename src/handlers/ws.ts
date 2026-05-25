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

// ── 初期化 ────────────────────────────────────────────────────────
const logger = new Logger({ serviceName: 'ws-handler' });
const dynamo = new DynamoDBClient({ region: process.env.REGION });
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

// ── イベント型 ────────────────────────────────────────────────────
type WsEvent = {
  requestContext: {
    connectionId: string;
    routeKey: string;
    domainName: string;
    stage: string;
  };
  body?: string;
};

// ── $connect ──────────────────────────────────────────────────────
const onConnect = async (connectionId: string): Promise<{ statusCode: number }> => {
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24時間後（Unix秒）
  await dynamo.send(
    new PutItemCommand({
      TableName: CONNECTIONS_TABLE,
      Item: marshall({ connectionId, connectedAt: new Date().toISOString(), ttl }),
    }),
  );
  return { statusCode: 200 };
};

// ── $disconnect ───────────────────────────────────────────────────
const onDisconnect = async (connectionId: string): Promise<{ statusCode: number }> => {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: CONNECTIONS_TABLE,
      Key: marshall({ connectionId }),
    }),
  );
  return { statusCode: 200 };
};

// ── $default（全接続へブロードキャスト） ─────────────────────────
const onMessage = async (
  connectionId: string,
  body: string,
  endpoint: string,
): Promise<{ statusCode: number }> => {
  const apigw = new ApiGatewayManagementApiClient({ endpoint });

  const result = await dynamo.send(new ScanCommand({ TableName: CONNECTIONS_TABLE }));
  const connections = (result.Items ?? []).map((item) => unmarshall(item));

  const payload = Buffer.from(
    JSON.stringify({ from: connectionId, message: body, timestamp: new Date().toISOString() }),
  );

  await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({ ConnectionId: conn.connectionId as string, Data: payload }),
        );
      } catch (err) {
        if (err instanceof GoneException) {
          // 切断済みの接続を DynamoDB から削除
          await dynamo.send(
            new DeleteItemCommand({
              TableName: CONNECTIONS_TABLE,
              Key: marshall({ connectionId: conn.connectionId }),
            }),
          );
        }
      }
    }),
  );

  return { statusCode: 200 };
};

// ── エントリーポイント ────────────────────────────────────────────
export const handler = async (event: WsEvent): Promise<{ statusCode: number }> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;
  logger.info('WebSocket event', { connectionId, routeKey });

  switch (routeKey) {
    case '$connect':
      return onConnect(connectionId);
    case '$disconnect':
      return onDisconnect(connectionId);
    default:
      return onMessage(connectionId, event.body ?? '', endpoint);
  }
};
