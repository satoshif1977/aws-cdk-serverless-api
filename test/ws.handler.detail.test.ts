// ── モック定義 ────────────────────────────────────────────────────
const mockDynamoSend = jest.fn();
const mockApigwSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockDynamoSend })),
  PutItemCommand: jest.fn().mockImplementation((i: unknown) => i),
  DeleteItemCommand: jest.fn().mockImplementation((i: unknown) => i),
  ScanCommand: jest.fn().mockImplementation((i: unknown) => i),
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

class MockGoneException extends Error {
  constructor() {
    super('Gone');
  }
}

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn().mockImplementation(() => ({ send: mockApigwSend })),
  PostToConnectionCommand: jest.fn().mockImplementation((i: unknown) => i),
  GoneException: MockGoneException,
}));

// ── テスト対象（モック後に import） ────────────────────────────────
import { handler } from '../src/handlers/ws';

// ── ヘルパー ──────────────────────────────────────────────────────
const makeWsEvent = (routeKey: string, connectionId: string, body?: string) => ({
  requestContext: {
    connectionId,
    routeKey,
    domainName: 'test.execute-api.ap-northeast-1.amazonaws.com',
    stage: 'dev',
  },
  body,
});

beforeEach(() => {
  mockDynamoSend.mockReset();
  mockApigwSend.mockReset();
  process.env.CONNECTIONS_TABLE = 'test-connections';
  process.env.REGION = 'ap-northeast-1';
});

// ── $connect 追加ケース ────────────────────────────────────────────
describe('$connect - 追加ケース', () => {
  it('statusCode が 200', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    const result = await handler(makeWsEvent('$connect', 'conn-100'));
    expect(result.statusCode).toBe(200);
  });

  it('DynamoDB PutItemCommand が 1 回だけ呼ばれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$connect', 'conn-200'));
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  it('異なる connectionId を連続接続しても独立して DynamoDB に保存する', async () => {
    mockDynamoSend.mockResolvedValue({});
    await handler(makeWsEvent('$connect', 'conn-a'));
    await handler(makeWsEvent('$connect', 'conn-b'));
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });
});

// ── $disconnect 追加ケース ─────────────────────────────────────────
describe('$disconnect - 追加ケース', () => {
  it('statusCode が 200', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    const result = await handler(makeWsEvent('$disconnect', 'conn-300'));
    expect(result.statusCode).toBe(200);
  });

  it('DynamoDB DeleteItemCommand が 1 回だけ呼ばれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$disconnect', 'conn-del-999'));
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });
});

// ── $default 追加ケース ───────────────────────────────────────────
describe('$default - ブロードキャスト 追加ケース', () => {
  it('接続が 3 件のとき PostToConnection が 3 回呼ばれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ connectionId: 'c1' }, { connectionId: 'c2' }, { connectionId: 'c3' }],
    });
    mockApigwSend.mockResolvedValue({});
    const result = await handler(makeWsEvent('$default', 'sender', 'msg'));
    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).toHaveBeenCalledTimes(3);
  });

  it('body が undefined のとき APIGW が 1 回呼ばれる（空文字扱い）', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ connectionId: 'c1' }] });
    mockApigwSend.mockResolvedValueOnce({});
    const result = await handler(makeWsEvent('$default', 'sender', undefined));
    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).toHaveBeenCalledTimes(1);
  });

  it('非 GoneException エラーのとき DynamoDB 削除を行わない', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ connectionId: 'c1' }] });
    mockApigwSend.mockRejectedValueOnce(new Error('Network error'));
    const result = await handler(makeWsEvent('$default', 'sender', 'hello'));
    expect(result.statusCode).toBe(200);
    // Scan のみ 1 回（DeleteItem は呼ばれない）
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  it('全接続が GoneException のとき全接続が削除される（2件）', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [{ connectionId: 'stale1' }, { connectionId: 'stale2' }],
      }) // Scan
      .mockResolvedValue({}); // 2 x DeleteItem
    mockApigwSend
      .mockRejectedValueOnce(new MockGoneException())
      .mockRejectedValueOnce(new MockGoneException());
    const result = await handler(makeWsEvent('$default', 'sender', 'bye'));
    expect(result.statusCode).toBe(200);
    // Scan 1 + DeleteItem 2 = 3 回
    expect(mockDynamoSend).toHaveBeenCalledTimes(3);
  });

  it('接続が 0 件のとき PostToConnection は呼ばれない', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    const result = await handler(makeWsEvent('$default', 'sender', 'hello'));
    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).not.toHaveBeenCalled();
  });

  it('Items が undefined のとき PostToConnection は呼ばれない', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: undefined });
    const result = await handler(makeWsEvent('$default', 'sender', 'hello'));
    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).not.toHaveBeenCalled();
  });

  it('正常接続と GoneException が混在するバッチ', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [{ connectionId: 'ok1' }, { connectionId: 'gone1' }, { connectionId: 'ok2' }],
      })
      .mockResolvedValue({});
    mockApigwSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new MockGoneException())
      .mockResolvedValueOnce({});
    const result = await handler(makeWsEvent('$default', 'sender', 'mix'));
    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).toHaveBeenCalledTimes(3);
    // Scan 1 + DeleteItem 1 (gone) = 2
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });
});

// ── 未知の routeKey ──────────────────────────────────────────────
describe('未知の routeKey', () => {
  it('カスタム routeKey は $default として扱われる', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    const result = await handler(makeWsEvent('customAction', 'conn-x', 'data'));
    expect(result.statusCode).toBe(200);
  });
});

// ── $connect 追加エッジケース ─────────────────────────────────────
describe('$connect - エッジケース', () => {
  it('接続時に PutItem の Item に connectionId が含まれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$connect', 'conn-check'));
    const putArg = mockDynamoSend.mock.calls[0][0] as Record<string, unknown>;
    const item = putArg.Item as Record<string, unknown>;
    expect(item.connectionId).toBe('conn-check');
  });

  it('接続時に PutItem の Item に connectedAt が含まれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$connect', 'conn-ts'));
    const putArg = mockDynamoSend.mock.calls[0][0] as Record<string, unknown>;
    const item = putArg.Item as Record<string, unknown>;
    expect(item.connectedAt).toBeDefined();
  });

  it('接続時に PutItem の Item に ttl が数値で含まれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$connect', 'conn-ttl'));
    const putArg = mockDynamoSend.mock.calls[0][0] as Record<string, unknown>;
    const item = putArg.Item as Record<string, unknown>;
    expect(typeof item.ttl).toBe('number');
  });

  it('ttl が現在時刻より大きい（未来の値）', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$connect', 'conn-ttl2'));
    const putArg = mockDynamoSend.mock.calls[0][0] as Record<string, unknown>;
    const item = putArg.Item as Record<string, unknown>;
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(item.ttl as number).toBeGreaterThan(nowEpoch);
  });
});

// ── $disconnect 追加エッジケース ──────────────────────────────────
describe('$disconnect - エッジケース', () => {
  it('切断時に DeleteItem の Key に connectionId が含まれる', async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    await handler(makeWsEvent('$disconnect', 'conn-del'));
    const delArg = mockDynamoSend.mock.calls[0][0] as Record<string, unknown>;
    const key = delArg.Key as Record<string, unknown>;
    expect(key.connectionId).toBe('conn-del');
  });
});
