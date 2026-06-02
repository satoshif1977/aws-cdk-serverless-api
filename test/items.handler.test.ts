import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ── モック定義（jest.mock はホイスティングされるため先頭に記述） ─────
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  ScanCommand: jest.fn().mockImplementation((i: unknown) => i),
  GetItemCommand: jest.fn().mockImplementation((i: unknown) => i),
  PutItemCommand: jest.fn().mockImplementation((i: unknown) => i),
  DeleteItemCommand: jest.fn().mockImplementation((i: unknown) => i),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn().mockImplementation((obj: unknown) => obj),
  unmarshall: jest.fn().mockImplementation((obj: unknown) => obj),
}));

// ── テスト対象（モック後に import） ────────────────────────────────
import { handler } from '../src/handlers/items';

// ── ヘルパー ──────────────────────────────────────────────────────
type HandlerResult = { statusCode: number; body: string; headers: Record<string, string> };

const makeEvent = (
  method: string,
  id?: string,
  body?: unknown,
  qs?: Record<string, string>,
): APIGatewayProxyEventV2 =>
  ({
    requestContext: { http: { method } },
    pathParameters: id ? { id } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    queryStringParameters: qs,
  }) as unknown as APIGatewayProxyEventV2;

const call = async (...args: Parameters<typeof handler>): Promise<HandlerResult> =>
  (await handler(...args)) as HandlerResult;

const parseBody = (result: HandlerResult) => JSON.parse(result.body);

// ── テストスイート ─────────────────────────────────────────────────
beforeEach(() => {
  mockSend.mockReset();
  process.env.TABLE_NAME = 'test-table';
  process.env.REGION = 'ap-northeast-1';
});

// ── GET /items (listItems) ─────────────────────────────────────────
describe('GET /items - listItems', () => {
  it('デフォルト: 200 + items / nextToken=null / count を返す', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ id: 'abc', name: 'test' }],
      LastEvaluatedKey: undefined,
    });

    const result = await call(makeEvent('GET'));

    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.items).toHaveLength(1);
    expect(body.nextToken).toBeNull();
    expect(body.count).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('?limit=2: ScanCommand を1回だけ実行し nextToken を返す', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ id: '1' }, { id: '2' }],
      LastEvaluatedKey: { id: { S: '2' } },
    });

    const result = await call(makeEvent('GET', undefined, undefined, { limit: '2' }));

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = parseBody(result);
    expect(body.items).toHaveLength(2);
    expect(body.nextToken).not.toBeNull();
  });

  it('?nextToken: ExclusiveStartKey 付きで Scan し最終ページを返す', async () => {
    const lastKey = { id: { S: '2' } };
    const token = Buffer.from(JSON.stringify(lastKey)).toString('base64url');
    mockSend.mockResolvedValueOnce({
      Items: [{ id: '3' }],
      LastEvaluatedKey: undefined,
    });

    const result = await call(makeEvent('GET', undefined, undefined, { nextToken: token }));

    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.items).toHaveLength(1);
    expect(body.nextToken).toBeNull();
  });

  it('0件: items が空配列・nextToken は null', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    const result = await call(makeEvent('GET'));

    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.items).toHaveLength(0);
    expect(body.nextToken).toBeNull();
  });
});

// ── GET /items/{id} (getItem) ──────────────────────────────────────
describe('GET /items/{id} - getItem', () => {
  it('存在する場合: 200 + item を返す', async () => {
    mockSend.mockResolvedValueOnce({ Item: { id: 'abc', name: 'foo' } });

    const result = await call(makeEvent('GET', 'abc'));

    expect(result.statusCode).toBe(200);
    expect(parseBody(result).item).toBeDefined();
  });

  it('存在しない場合: 404', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await call(makeEvent('GET', 'missing'));

    expect(result.statusCode).toBe(404);
    expect(parseBody(result).message).toBe('Item not found');
  });
});

// ── POST /items (createItem) ───────────────────────────────────────
describe('POST /items - createItem', () => {
  it('201 + id / createdAt が付与された item を返す', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await call(makeEvent('POST', undefined, { name: 'new item' }));

    expect(result.statusCode).toBe(201);
    const { item } = parseBody(result);
    expect(item.id).toBeDefined();
    expect(item.createdAt).toBeDefined();
    expect(item.name).toBe('new item');
  });
});

// ── PUT /items/{id} (updateItem) ──────────────────────────────────
describe('PUT /items/{id} - updateItem', () => {
  it('200 + updatedAt が付与された item を返す', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'abc', name: 'old' } })  // GetItem
      .mockResolvedValueOnce({});                                    // PutItem

    const result = await call(makeEvent('PUT', 'abc', { name: 'updated' }));

    expect(result.statusCode).toBe(200);
    const { item } = parseBody(result);
    expect(item.updatedAt).toBeDefined();
    expect(item.id).toBe('abc');  // id が上書きされていないこと
  });

  it('存在しない場合: 404', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await call(makeEvent('PUT', 'missing', { name: 'x' }));

    expect(result.statusCode).toBe(404);
  });
});

// ── DELETE /items/{id} (deleteItem) ───────────────────────────────
describe('DELETE /items/{id} - deleteItem', () => {
  it('204 を返す', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await call(makeEvent('DELETE', 'abc'));

    expect(result.statusCode).toBe(204);
  });
});

// ── 未対応ルート ──────────────────────────────────────────────────
describe('未対応ルート - 405', () => {
  it('PATCH /items/{id} → 405', async () => {
    const result = await call(makeEvent('PATCH', 'abc'));
    expect(result.statusCode).toBe(405);
  });

  it('POST /items/{id} (idあり) → 405', async () => {
    const result = await call(makeEvent('POST', 'abc', {}));
    expect(result.statusCode).toBe(405);
  });
});

// ── 予期しないエラー（500）────────────────────────────────────────
describe('DynamoDB 例外 - 500', () => {
  it('DynamoDB がエラーをスローした場合: 500 を返す', async () => {
    // listItems の mockSend が例外を投げるケースでハンドラの catch ブロックを検証
    mockSend.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

    const result = await call(makeEvent('GET'));

    expect(result.statusCode).toBe(500);
    expect(parseBody(result).message).toBe('Internal Server Error');
  });
});
