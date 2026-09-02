import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { RouteCtx, RouteKey, RouteHandler } from './types';
import { respond, parseBody } from './helpers';
import { validateCreateInput, validateUpdateInput } from './validators';
import { retryAsync, extractErrorCode } from './retry';
import type { RetryOptions } from './retry';

// ── 初期化 ────────────────────────────────────────────────────────
// POWERTOOLS_TRACE_DISABLED=true（dev）のとき Tracer は no-op になる
// 本番では ACTIVE トレーシングに切り替えることで X-Ray サブセグメントが有効化される
const logger = new Logger({ serviceName: 'items-handler' });
const tracer = new Tracer({ serviceName: 'items-handler' });
const metrics = new Metrics({ namespace: 'ServerlessApi', serviceName: 'items-handler' });
const client = tracer.captureAWSv3Client(new DynamoDBClient({ region: process.env.REGION }));
const TABLE_NAME = process.env.TABLE_NAME!;

// ── リトライ ──────────────────────────────────────────────────────
// DynamoDB のスロットリング（ProvisionedThroughputExceededException 等）と
// 一時的なサーバエラーに対して、指数バックオフ + フルジッターで再試行する。
// API Gateway の 29 秒制限に収まるよう、待機は短め（最大 2 秒 × 2 回）に設定している。
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

// ── 型定義・ヘルパーは ./types, ./helpers から import ─────────────

// ── ルートハンドラー ──────────────────────────────────────────────
const listItems = async ({ event }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Number(qs['limit'] ?? 20), 100);
  const nextToken = qs['nextToken'];

  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64url').toString()) as Record<string, AttributeValue>)
    : undefined;

  const result = await sendWithRetry(() =>
    client.send(
      new ScanCommand({ TableName: TABLE_NAME, Limit: limit, ExclusiveStartKey: exclusiveStartKey }),
    ),
  );

  const items = (result.Items ?? []).map((item) => unmarshall(item));
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null;

  metrics.addMetric('ItemsListed', MetricUnit.Count, 1);
  return respond(200, { items, nextToken: responseNextToken, count: items.length });
};

const getItem = async ({ id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const result = await sendWithRetry(() =>
    client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) })),
  );
  if (!result.Item) {
    metrics.addMetric('ItemNotFound', MetricUnit.Count, 1);
    return respond(404, { message: 'Item not found' });
  }
  metrics.addMetric('ItemFetched', MetricUnit.Count, 1);
  return respond(200, { item: unmarshall(result.Item) });
};

const createItem = async ({ event }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const parsed = parseBody(event.body);
  if (!parsed.ok) return parsed.response;
  const validated = validateCreateInput(parsed.data);
  if (!validated.ok) return validated.response;
  const newItem = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...parsed.data,
  };
  await sendWithRetry(() =>
    client.send(new PutItemCommand({ TableName: TABLE_NAME, Item: marshall(newItem) })),
  );
  metrics.addMetric('ItemCreated', MetricUnit.Count, 1);
  return respond(201, { item: newItem });
};

const updateItem = async ({ event, id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const existing = await sendWithRetry(() =>
    client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) })),
  );
  if (!existing.Item) {
    metrics.addMetric('ItemNotFound', MetricUnit.Count, 1);
    return respond(404, { message: 'Item not found' });
  }
  const parsed = parseBody(event.body);
  if (!parsed.ok) return parsed.response;
  const validated = validateUpdateInput(parsed.data);
  if (!validated.ok) return validated.response;
  const updatedItem = {
    ...unmarshall(existing.Item),
    ...parsed.data,
    id, // id の上書きを防ぐ
    updatedAt: new Date().toISOString(),
  };
  await sendWithRetry(() =>
    client.send(new PutItemCommand({ TableName: TABLE_NAME, Item: marshall(updatedItem) })),
  );
  metrics.addMetric('ItemUpdated', MetricUnit.Count, 1);
  return respond(200, { item: updatedItem });
};

const deleteItem = async ({ id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  await sendWithRetry(() =>
    client.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) })),
  );
  metrics.addMetric('ItemDeleted', MetricUnit.Count, 1);
  return respond(204, {});
};

// ── ディスパッチテーブル ──────────────────────────────────────────

const ROUTES: Partial<Record<RouteKey, RouteHandler>> = {
  'GET:collection':  listItems,
  'GET:item':        getItem,
  'POST:collection': createItem,
  'PUT:item':        updateItem,
  'DELETE:item':     deleteItem,
};

// ── エントリーポイント ────────────────────────────────────────────
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
  const id = event.pathParameters?.['id'];
  const key: RouteKey = `${method}:${id ? 'item' : 'collection'}`;

  try {
    const routeHandler = ROUTES[key];
    if (!routeHandler) {
      logger.warn('Route not found', { method, path: event.rawPath, key });
      return respond(405, { message: 'Method Not Allowed' });
    }
    logger.info('Routing request', { method, path: event.rawPath, hasId: !!id });
    return await routeHandler({ event, id });
  } catch (err) {
    logger.error('Handler error', { error: err, method, path: event.rawPath });
    return respond(500, { message: 'Internal Server Error' });
  } finally {
    metrics.publishStoredMetrics();
  }
};
