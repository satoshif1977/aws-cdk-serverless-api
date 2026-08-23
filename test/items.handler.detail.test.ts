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

jest.mock('@aws-lambda-powertools/tracer', () => ({
  Tracer: jest.fn().mockImplementation(() => ({
    captureAWSv3Client: jest.fn().mockImplementation((client: unknown) => client),
  })),
}));

jest.mock('@aws-lambda-powertools/metrics', () => ({
  Metrics: jest.fn().mockImplementation(() => ({
    addMetric: jest.fn(),
    publishStoredMetrics: jest.fn(),
  })),
  MetricUnit: { Count: 'Count' },
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

beforeEach(() => {
  mockSend.mockReset();
  process.env.TABLE_NAME = 'test-table';
  process.env.REGION = 'ap-northeast-1';
});

// ── GET /items - listItems 追加ケース ─────────────────────────────
describe('GET /items - listItems 追加ケース', () => {
  it('Items が undefined のとき空配列を返す', async () => {
    mockSend.mockResolvedValueOnce({ Items: undefined, LastEvaluatedKey: undefined });
    const result = await call(makeEvent('GET'));
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).items).toHaveLength(0);
  });

  it('limit=200 は 100 にクランプされて ScanCommand に渡る', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET', undefined, undefined, { limit: '200' }));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).Limit;
    expect(scanArg).toBe(100);
  });

  it('count フィールドが items.length と一致する（3件）', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ id: '1' }, { id: '2' }, { id: '3' }],
      LastEvaluatedKey: undefined,
    });
    const result = await call(makeEvent('GET'));
    const body = parseBody(result);
    expect(body.count).toBe(3);
    expect(body.count).toBe(body.items.length);
  });

  it('Content-Type ヘッダーが application/json', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const result = await call(makeEvent('GET'));
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('nextToken を渡すと ScanCommand に ExclusiveStartKey が設定される', async () => {
    const lastKey = { id: { S: 'abc' } };
    const token = Buffer.from(JSON.stringify(lastKey)).toString('base64url');
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET', undefined, undefined, { nextToken: token }));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).ExclusiveStartKey;
    expect(scanArg).toBeDefined();
  });
});

// ── GET /items/{id} - getItem 追加ケース ──────────────────────────
describe('GET /items/{id} - getItem 追加ケース', () => {
  it('404 のとき Content-Type ヘッダーが application/json', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await call(makeEvent('GET', 'not-found'));
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('200 のとき item フィールドが body に含まれる', async () => {
    mockSend.mockResolvedValueOnce({ Item: { id: 'xyz', name: 'foo' } });
    const result = await call(makeEvent('GET', 'xyz'));
    expect(parseBody(result).item).toBeDefined();
  });
});

// ── POST /items - createItem 追加ケース ───────────────────────────
describe('POST /items - createItem 追加ケース', () => {
  it('body が undefined でも 201 を返す', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await call(makeEvent('POST'));
    expect(result.statusCode).toBe(201);
  });

  it('生成された id が UUID 形式（ハイフン含む 36 文字）', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await call(makeEvent('POST', undefined, {}));
    const { item } = parseBody(result);
    expect(item.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('createdAt が ISO 8601 形式', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await call(makeEvent('POST', undefined, { name: 'test' }));
    const { item } = parseBody(result);
    expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
  });

  it('リクエストの複数フィールドがそのまま item に含まれる', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await call(
      makeEvent('POST', undefined, { name: 'test', price: 100, active: true }),
    );
    const { item } = parseBody(result);
    expect(item.name).toBe('test');
    expect(item.price).toBe(100);
    expect(item.active).toBe(true);
  });

  it('DynamoDB エラーで 500', async () => {
    mockSend.mockRejectedValueOnce(new Error('Put failed'));
    const result = await call(makeEvent('POST', undefined, { name: 'err' }));
    expect(result.statusCode).toBe(500);
  });
});

// ── PUT /items/{id} - updateItem 追加ケース ───────────────────────
describe('PUT /items/{id} - updateItem 追加ケース', () => {
  it('body が空 ({}) でも既存フィールドが保持される', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'abc', name: 'old-name' } })
      .mockResolvedValueOnce({});
    const result = await call(makeEvent('PUT', 'abc', {}));
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).item.name).toBe('old-name');
  });

  it('updatedAt が ISO 8601 形式', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'abc', name: 'old' } })
      .mockResolvedValueOnce({});
    const result = await call(makeEvent('PUT', 'abc', { name: 'new' }));
    const { item } = parseBody(result);
    expect(new Date(item.updatedAt).toISOString()).toBe(item.updatedAt);
  });

  it('PutItem 成功時 DynamoDB が 2 回呼ばれる（GetItem + PutItem）', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'abc', name: 'old' } })
      .mockResolvedValueOnce({});
    await call(makeEvent('PUT', 'abc', { name: 'new' }));
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('DynamoDB PutItem エラーで 500（GetItem 成功後）', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'abc', name: 'old' } })
      .mockRejectedValueOnce(new Error('PutItem failed'));
    const result = await call(makeEvent('PUT', 'abc', { name: 'new' }));
    expect(result.statusCode).toBe(500);
  });
});

// ── DELETE /items/{id} - deleteItem 追加ケース ────────────────────
describe('DELETE /items/{id} - deleteItem 追加ケース', () => {
  it('204 のとき body が空 JSON ({})', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await call(makeEvent('DELETE', 'abc'));
    expect(parseBody(result)).toEqual({});
  });

  it('DynamoDB エラーで 500', async () => {
    mockSend.mockRejectedValueOnce(new Error('Delete failed'));
    const result = await call(makeEvent('DELETE', 'abc'));
    expect(result.statusCode).toBe(500);
  });
});

// ── 未対応ルート 追加ケース ────────────────────────────────────────
describe('未対応ルート - 405 追加ケース', () => {
  it('HEAD /items → 405', async () => {
    const result = await call(makeEvent('HEAD'));
    expect(result.statusCode).toBe(405);
  });

  it('PUT /items（id なし）→ 405', async () => {
    const result = await call(makeEvent('PUT', undefined, { name: 'x' }));
    expect(result.statusCode).toBe(405);
  });

  it('DELETE /items（id なし）→ 405', async () => {
    const result = await call(makeEvent('DELETE'));
    expect(result.statusCode).toBe(405);
  });

  it('PATCH /items/{id} → 405', async () => {
    const result = await call(makeEvent('PATCH', 'abc'));
    expect(result.statusCode).toBe(405);
  });

  it('OPTIONS /items → 405', async () => {
    const result = await call(makeEvent('OPTIONS'));
    expect(result.statusCode).toBe(405);
  });

  it('405 のとき body に "Method Not Allowed" メッセージ', async () => {
    const result = await call(makeEvent('HEAD'));
    expect(parseBody(result).message).toBe('Method Not Allowed');
  });
});

// ── GET /items - limit バリエーション ─────────────────────────────
describe('GET /items - limit バリエーション', () => {
  it('limit=1 のとき ScanCommand に Limit=1 が渡る', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET', undefined, undefined, { limit: '1' }));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).Limit;
    expect(scanArg).toBe(1);
  });

  it('limit=100 のとき ScanCommand に Limit=100 が渡る', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET', undefined, undefined, { limit: '100' }));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).Limit;
    expect(scanArg).toBe(100);
  });

  it('limit 未指定のとき ScanCommand に Limit=20 が渡る', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET'));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).Limit;
    expect(scanArg).toBe(20);
  });

  it('limit が負数のとき NaN 扱い（20 にフォールバック）', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await call(makeEvent('GET', undefined, undefined, { limit: '-5' }));
    const scanArg = (mockSend.mock.calls[0][0] as Record<string, unknown>).Limit;
    expect(scanArg).toBeLessThanOrEqual(100);
  });
});

// ── GET /items - nextToken / ページネーション ──────────────────────
describe('GET /items - nextToken ページネーション', () => {
  it('LastEvaluatedKey があるとき nextToken が返される', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ id: 'item1' }],
      LastEvaluatedKey: { id: { S: 'item1' } },
    });
    const result = await call(makeEvent('GET'));
    expect(parseBody(result).nextToken).not.toBeNull();
  });

  it('LastEvaluatedKey がないとき nextToken が null', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ id: 'item1' }],
      LastEvaluatedKey: undefined,
    });
    const result = await call(makeEvent('GET'));
    expect(parseBody(result).nextToken).toBeNull();
  });
});

// ── PUT /items/{id} - id 上書き防止 ──────────────────────────────
describe('PUT /items/{id} - id 上書き防止', () => {
  it('body で id を上書きしようとしても元の id が維持される', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { id: 'original', name: 'test' } })
      .mockResolvedValueOnce({});
    const result = await call(makeEvent('PUT', 'original', { id: 'hacked', name: 'updated' }));
    expect(parseBody(result).item.id).toBe('original');
  });
});

// ── POST /items - 連続作成 ───────────────────────────────────────
describe('POST /items - 連続作成', () => {
  it('2 回連続 POST で異なる id が生成される', async () => {
    mockSend.mockResolvedValue({});
    const result1 = await call(makeEvent('POST', undefined, { name: 'item1' }));
    const result2 = await call(makeEvent('POST', undefined, { name: 'item2' }));
    const id1 = parseBody(result1).item.id;
    const id2 = parseBody(result2).item.id;
    expect(id1).not.toBe(id2);
  });
});

// ── エラーハンドリング ────────────────────────────────────────────
describe('エラーハンドリング', () => {
  it('GET /items で DynamoDB エラー → 500', async () => {
    mockSend.mockRejectedValueOnce(new Error('Scan failed'));
    const result = await call(makeEvent('GET'));
    expect(result.statusCode).toBe(500);
    expect(parseBody(result).message).toBe('Internal Server Error');
  });

  it('GET /items/{id} で DynamoDB エラー → 500', async () => {
    mockSend.mockRejectedValueOnce(new Error('GetItem failed'));
    const result = await call(makeEvent('GET', 'abc'));
    expect(result.statusCode).toBe(500);
  });

  it('500 レスポンスの Content-Type が application/json', async () => {
    mockSend.mockRejectedValueOnce(new Error('error'));
    const result = await call(makeEvent('GET'));
    expect(result.headers['Content-Type']).toBe('application/json');
  });
});
