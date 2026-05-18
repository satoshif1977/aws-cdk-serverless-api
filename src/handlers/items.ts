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

// ── 初期化 ────────────────────────────────────────────────────────
const client = new DynamoDBClient({ region: process.env.REGION });
const TABLE_NAME = process.env.TABLE_NAME!;

// ── ヘルパー ──────────────────────────────────────────────────────
const respond = (
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── コンテキスト型 ────────────────────────────────────────────────
type RouteCtx = { event: APIGatewayProxyEventV2; id?: string };

// ── ルートハンドラー ──────────────────────────────────────────────
const listItems = async (): Promise<APIGatewayProxyResultV2> => {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey: lastKey }),
    );
    (result.Items ?? []).forEach((item) => items.push(unmarshall(item)));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return respond(200, { items });
};

const getItem = async ({ id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const result = await client.send(
    new GetItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) }),
  );
  if (!result.Item) return respond(404, { message: 'Item not found' });
  return respond(200, { item: unmarshall(result.Item) });
};

const createItem = async ({ event }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  const newItem = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...body,
  };
  await client.send(
    new PutItemCommand({ TableName: TABLE_NAME, Item: marshall(newItem) }),
  );
  return respond(201, { item: newItem });
};

const updateItem = async ({ event, id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  const existing = await client.send(
    new GetItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) }),
  );
  if (!existing.Item) return respond(404, { message: 'Item not found' });
  const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  const updatedItem = {
    ...unmarshall(existing.Item),
    ...body,
    id, // id の上書きを防ぐ
    updatedAt: new Date().toISOString(),
  };
  await client.send(
    new PutItemCommand({ TableName: TABLE_NAME, Item: marshall(updatedItem) }),
  );
  return respond(200, { item: updatedItem });
};

const deleteItem = async ({ id }: RouteCtx): Promise<APIGatewayProxyResultV2> => {
  await client.send(
    new DeleteItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) }),
  );
  return respond(204, {});
};

// ── ディスパッチテーブル ──────────────────────────────────────────
type RouteKey = `${'GET' | 'POST' | 'PUT' | 'DELETE'}:${'item' | 'collection'}`;
type RouteHandler = (ctx: RouteCtx) => Promise<APIGatewayProxyResultV2>;

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
    if (!routeHandler) return respond(405, { message: 'Method Not Allowed' });
    return await routeHandler({ event, id });
  } catch (err) {
    console.error('Handler error:', err);
    return respond(500, { message: 'Internal Server Error' });
  }
};
