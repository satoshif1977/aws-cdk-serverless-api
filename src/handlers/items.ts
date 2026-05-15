import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
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

// ── ルーター ──────────────────────────────────────────────────────
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const pathParams = event.pathParameters ?? {};
  const id = pathParams['id'];

  try {
    // GET /items — 全件取得
    if (method === 'GET' && !id) {
      const result = await client.send(new ScanCommand({ TableName: TABLE_NAME }));
      const items = (result.Items ?? []).map((item) => unmarshall(item));
      return respond(200, { items });
    }

    // GET /items/{id} — 1件取得
    if (method === 'GET' && id) {
      const result = await client.send(
        new GetItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ id }),
        }),
      );
      if (!result.Item) {
        return respond(404, { message: 'Item not found' });
      }
      return respond(200, { item: unmarshall(result.Item) });
    }

    // POST /items — 新規作成
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
      const newItem = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...body,
      };
      await client.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: marshall(newItem),
        }),
      );
      return respond(201, { item: newItem });
    }

    // DELETE /items/{id} — 削除
    if (method === 'DELETE' && id) {
      await client.send(
        new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ id }),
        }),
      );
      return respond(204, {});
    }

    return respond(405, { message: 'Method Not Allowed' });
  } catch (err) {
    console.error('Handler error:', err);
    return respond(500, { message: 'Internal Server Error' });
  }
};
