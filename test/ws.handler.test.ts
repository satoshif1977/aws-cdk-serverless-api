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
  constructor() { super('Gone'); }
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

// ── $connect ──────────────────────────────────────────────────────
describe('$connect', () => {
  it('200 を返し connectionId を DynamoDB に保存する', async () => {
    mockDynamoSend.mockResolvedValueOnce({});

    const result = await handler(makeWsEvent('$connect', 'conn-1'));

    expect(result.statusCode).toBe(200);
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });
});

// ── $disconnect ───────────────────────────────────────────────────
describe('$disconnect', () => {
  it('200 を返し connectionId を DynamoDB から削除する', async () => {
    mockDynamoSend.mockResolvedValueOnce({});

    const result = await handler(makeWsEvent('$disconnect', 'conn-1'));

    expect(result.statusCode).toBe(200);
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });
});

// ── $default（ブロードキャスト） ──────────────────────────────────
describe('$default - ブロードキャスト', () => {
  it('接続中の全クライアントにメッセージを送信する', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ connectionId: 'conn-1' }, { connectionId: 'conn-2' }],
    });
    mockApigwSend.mockResolvedValue({});

    const result = await handler(makeWsEvent('$default', 'conn-sender', 'hello'));

    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).toHaveBeenCalledTimes(2);
  });

  it('切断済みクライアント（GoneException）は DynamoDB から削除する', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ connectionId: 'stale-conn' }] }) // Scan
      .mockResolvedValueOnce({}); // DeleteItem（切断済み接続の削除）
    mockApigwSend.mockRejectedValueOnce(new MockGoneException());

    const result = await handler(makeWsEvent('$default', 'conn-sender', 'hi'));

    expect(result.statusCode).toBe(200);
    expect(mockDynamoSend).toHaveBeenCalledTimes(2); // Scan + DeleteItem
  });

  it('接続なし: APIGW は呼ばない', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeWsEvent('$default', 'conn-1', 'hello'));

    expect(result.statusCode).toBe(200);
    expect(mockApigwSend).not.toHaveBeenCalled();
  });
});
