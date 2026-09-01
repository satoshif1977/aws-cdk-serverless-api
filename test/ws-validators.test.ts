import {
  // 型
  type ValidationError,
  type ConnectionItem,
  type BroadcastMessage,
  // 定数
  VALID_ROUTE_KEYS,
  CONNECTION_ID_PATTERN,
  MAX_CONNECTION_ID_LENGTH,
  WS_ENDPOINT_PATTERN,
  MAX_WS_FRAME_SIZE,
  MAX_APIGW_MESSAGE_SIZE,
  MIN_CONNECTION_TTL,
  ISO8601_PATTERN,
  // connectionId
  isValidConnectionId,
  validateConnectionId,
  // routeKey
  isValidRouteKey,
  isMessageRoute,
  validateRouteKey,
  // エンドポイント
  isValidWsEndpoint,
  buildEndpointUrl,
  validateEndpoint,
  // WebSocket イベント
  validateWsEvent,
  // ブロードキャスト
  validateBroadcastMessage,
  // 接続アイテム
  validateConnectionItem,
  validateConnectionItems,
  // ユーティリティ
  hasErrors,
  formatErrors,
} from "../src/handlers/ws-validators";

import type { WsEvent } from "../src/handlers/types";

// ── ヘルパー ─────────────────────────────────────────────────

const mkWsEvent = (overrides: Partial<WsEvent> = {}): WsEvent => ({
  requestContext: {
    connectionId: "abc123=",
    routeKey: "$default",
    domainName: "xyz123.execute-api.ap-northeast-1.amazonaws.com",
    stage: "prod",
  },
  body: "hello",
  ...overrides,
});

const mkConnectionItem = (
  overrides: Partial<ConnectionItem> = {}
): ConnectionItem => ({
  connectionId: "abc123=",
  connectedAt: "2026-09-01T10:00:00Z",
  ttl: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

// ── 定数テスト ───────────────────────────────────────────────

describe("定数", () => {
  test("VALID_ROUTE_KEYS に3種含まれる", () => {
    expect(VALID_ROUTE_KEYS).toHaveLength(3);
    expect(VALID_ROUTE_KEYS).toContain("$connect");
    expect(VALID_ROUTE_KEYS).toContain("$disconnect");
    expect(VALID_ROUTE_KEYS).toContain("$default");
  });

  test("CONNECTION_ID_PATTERN が英数字+記号にマッチ", () => {
    expect(CONNECTION_ID_PATTERN.test("abc123=")).toBe(true);
    expect(CONNECTION_ID_PATTERN.test("ABC_def-123=")).toBe(true);
    expect(CONNECTION_ID_PATTERN.test("has space")).toBe(false);
  });

  test("MAX_CONNECTION_ID_LENGTH は 256", () => {
    expect(MAX_CONNECTION_ID_LENGTH).toBe(256);
  });

  test("WS_ENDPOINT_PATTERN が API Gateway URL にマッチ", () => {
    expect(
      WS_ENDPOINT_PATTERN.test(
        "https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod"
      )
    ).toBe(true);
    expect(WS_ENDPOINT_PATTERN.test("http://localhost:3000")).toBe(false);
  });

  test("MAX_APIGW_MESSAGE_SIZE は 32KB", () => {
    expect(MAX_APIGW_MESSAGE_SIZE).toBe(32 * 1024);
  });

  test("MAX_WS_FRAME_SIZE は 128KB", () => {
    expect(MAX_WS_FRAME_SIZE).toBe(128 * 1024);
  });

  test("ISO8601_PATTERN が有効な日時にマッチ", () => {
    expect(ISO8601_PATTERN.test("2026-09-01T10:00:00Z")).toBe(true);
    expect(ISO8601_PATTERN.test("not-a-date")).toBe(false);
  });
});

// ── connectionId バリデーション ───────────────────────────────

describe("isValidConnectionId", () => {
  test("有効な connectionId", () => {
    expect(isValidConnectionId("abc123=")).toBe(true);
    expect(isValidConnectionId("ABC_def-123")).toBe(true);
  });

  test("空文字は無効", () => {
    expect(isValidConnectionId("")).toBe(false);
  });

  test("257文字以上は無効", () => {
    expect(isValidConnectionId("A".repeat(257))).toBe(false);
  });

  test("256文字は有効", () => {
    expect(isValidConnectionId("A".repeat(256))).toBe(true);
  });

  test("スペース含みは無効", () => {
    expect(isValidConnectionId("abc 123")).toBe(false);
  });
});

describe("validateConnectionId", () => {
  test("有効な ID でエラーなし", () => {
    expect(validateConnectionId("abc123=")).toHaveLength(0);
  });

  test("空文字でエラー", () => {
    const errors = validateConnectionId("");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("不正フォーマットでエラー", () => {
    const errors = validateConnectionId("abc 123!@#");
    expect(errors.some((e) => e.field === "connectionId")).toBe(true);
  });

  test("長すぎる ID でエラー", () => {
    const errors = validateConnectionId("A".repeat(300));
    expect(errors.some((e) => e.message.includes("最大長"))).toBe(true);
  });
});

// ── routeKey バリデーション ───────────────────────────────────

describe("isValidRouteKey", () => {
  test.each(["$connect", "$disconnect", "$default"])("%s は有効", (key) => {
    expect(isValidRouteKey(key)).toBe(true);
  });

  test("unknown は無効", () => {
    expect(isValidRouteKey("unknown")).toBe(false);
  });
});

describe("isMessageRoute", () => {
  test("$default はメッセージルート", () => {
    expect(isMessageRoute("$default")).toBe(true);
  });

  test("$connect はメッセージルートではない", () => {
    expect(isMessageRoute("$connect")).toBe(false);
  });

  test("$disconnect はメッセージルートではない", () => {
    expect(isMessageRoute("$disconnect")).toBe(false);
  });
});

describe("validateRouteKey", () => {
  test("有効な routeKey でエラーなし", () => {
    expect(validateRouteKey("$connect")).toHaveLength(0);
  });

  test("空文字でエラー", () => {
    const errors = validateRouteKey("");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("未知の routeKey で warning", () => {
    const errors = validateRouteKey("custom-route");
    expect(errors.some((e) => e.severity === "warning")).toBe(true);
  });
});

// ── エンドポイント URL バリデーション ────────────────────────

describe("isValidWsEndpoint", () => {
  test("有効な API Gateway URL", () => {
    expect(
      isValidWsEndpoint(
        "https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod"
      )
    ).toBe(true);
  });

  test("http は無効", () => {
    expect(
      isValidWsEndpoint(
        "http://abc123.execute-api.ap-northeast-1.amazonaws.com/prod"
      )
    ).toBe(false);
  });

  test("localhost は無効", () => {
    expect(isValidWsEndpoint("https://localhost:3000/ws")).toBe(false);
  });
});

describe("buildEndpointUrl", () => {
  test("domainName と stage から URL を構築", () => {
    const url = buildEndpointUrl(
      "abc123.execute-api.ap-northeast-1.amazonaws.com",
      "prod"
    );
    expect(url).toBe(
      "https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod"
    );
  });
});

describe("validateEndpoint", () => {
  test("有効な domainName + stage でエラーなし", () => {
    expect(
      validateEndpoint(
        "abc123.execute-api.ap-northeast-1.amazonaws.com",
        "prod"
      )
    ).toHaveLength(0);
  });

  test("domainName が空でエラー", () => {
    const errors = validateEndpoint("", "prod");
    expect(errors.some((e) => e.field === "domainName")).toBe(true);
  });

  test("stage が空でエラー", () => {
    const errors = validateEndpoint(
      "abc123.execute-api.ap-northeast-1.amazonaws.com",
      ""
    );
    expect(errors.some((e) => e.field === "stage")).toBe(true);
  });

  test("非 API Gateway ドメインで warning", () => {
    const errors = validateEndpoint("example.com", "prod");
    expect(
      errors.some(
        (e) => e.field === "endpoint" && e.severity === "warning"
      )
    ).toBe(true);
  });
});

// ── WebSocket イベントバリデーション ─────────────────────────

describe("validateWsEvent", () => {
  test("有効なイベントでエラーなし", () => {
    expect(validateWsEvent(mkWsEvent())).toHaveLength(0);
  });

  test("requestContext なしでエラー", () => {
    const event = {} as unknown as WsEvent;
    const errors = validateWsEvent(event);
    expect(
      errors.some((e) => e.field === "requestContext" && e.severity === "error")
    ).toBe(true);
  });

  test("connectionId が空でエラー", () => {
    const event = mkWsEvent({
      requestContext: {
        connectionId: "",
        routeKey: "$default",
        domainName: "abc123.execute-api.ap-northeast-1.amazonaws.com",
        stage: "prod",
      },
    });
    const errors = validateWsEvent(event);
    expect(errors.some((e) => e.field === "connectionId")).toBe(true);
  });

  test("$default で body なしは warning", () => {
    const event = mkWsEvent();
    delete event.body;
    const errors = validateWsEvent(event);
    expect(
      errors.some((e) => e.field === "body" && e.severity === "warning")
    ).toBe(true);
  });

  test("$connect で body なしは OK", () => {
    const event = mkWsEvent({
      requestContext: {
        connectionId: "abc123=",
        routeKey: "$connect",
        domainName: "abc123.execute-api.ap-northeast-1.amazonaws.com",
        stage: "prod",
      },
    });
    delete event.body;
    const errors = validateWsEvent(event);
    expect(errors.filter((e) => e.field === "body")).toHaveLength(0);
  });

  test("body が 32KB 超えでエラー", () => {
    const event = mkWsEvent();
    event.body = "A".repeat(MAX_APIGW_MESSAGE_SIZE + 1);
    const errors = validateWsEvent(event);
    expect(
      errors.some((e) => e.field === "body" && e.severity === "error")
    ).toBe(true);
  });

  test("body がちょうど 32KB は OK", () => {
    const event = mkWsEvent();
    event.body = "A".repeat(MAX_APIGW_MESSAGE_SIZE);
    const errors = validateWsEvent(event);
    expect(errors.filter((e) => e.field === "body")).toHaveLength(0);
  });

  test("未知の routeKey で warning", () => {
    const event = mkWsEvent({
      requestContext: {
        connectionId: "abc123=",
        routeKey: "custom",
        domainName: "abc123.execute-api.ap-northeast-1.amazonaws.com",
        stage: "prod",
      },
    });
    const errors = validateWsEvent(event);
    expect(
      errors.some((e) => e.field === "routeKey" && e.severity === "warning")
    ).toBe(true);
  });
});

// ── ブロードキャストメッセージバリデーション ──────────────────

describe("validateBroadcastMessage", () => {
  test("有効なメッセージでエラーなし", () => {
    const msg: BroadcastMessage = {
      from: "abc123=",
      message: "hello",
      timestamp: "2026-09-01T10:00:00Z",
    };
    expect(validateBroadcastMessage(msg)).toHaveLength(0);
  });

  test("from なしで warning", () => {
    const msg: BroadcastMessage = {
      message: "hello",
      timestamp: "2026-09-01T10:00:00Z",
    };
    const errors = validateBroadcastMessage(msg);
    expect(
      errors.some((e) => e.field === "from" && e.severity === "warning")
    ).toBe(true);
  });

  test("message なしでエラー", () => {
    const msg: BroadcastMessage = {
      from: "abc123=",
      timestamp: "2026-09-01T10:00:00Z",
    };
    const errors = validateBroadcastMessage(msg);
    expect(
      errors.some((e) => e.field === "message" && e.severity === "error")
    ).toBe(true);
  });

  test("不正な timestamp で warning", () => {
    const msg: BroadcastMessage = {
      from: "abc123=",
      message: "hello",
      timestamp: "yesterday",
    };
    const errors = validateBroadcastMessage(msg);
    expect(
      errors.some((e) => e.field === "timestamp" && e.severity === "warning")
    ).toBe(true);
  });

  test("不正な from connectionId でエラー", () => {
    const msg: BroadcastMessage = {
      from: "invalid id!@#",
      message: "hello",
    };
    const errors = validateBroadcastMessage(msg);
    expect(errors.some((e) => e.field === "from")).toBe(true);
  });

  test("巨大メッセージでエラー", () => {
    const msg: BroadcastMessage = {
      from: "abc123=",
      message: "A".repeat(MAX_WS_FRAME_SIZE + 1),
    };
    const errors = validateBroadcastMessage(msg);
    expect(
      errors.some(
        (e) => e.field === "broadcastMessage" && e.severity === "error"
      )
    ).toBe(true);
  });
});

// ── DynamoDB 接続アイテムバリデーション ───────────────────────

describe("validateConnectionItem", () => {
  test("有効なアイテムでエラーなし", () => {
    expect(validateConnectionItem(mkConnectionItem())).toHaveLength(0);
  });

  test("connectionId 空でエラー", () => {
    const item = mkConnectionItem({ connectionId: "" });
    const errors = validateConnectionItem(item);
    expect(errors.some((e) => e.field === "connectionId")).toBe(true);
  });

  test("connectedAt なしで warning", () => {
    const item = mkConnectionItem();
    delete item.connectedAt;
    const errors = validateConnectionItem(item);
    expect(
      errors.some(
        (e) => e.field === "connectedAt" && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("connectedAt が不正形式で warning", () => {
    const item = mkConnectionItem({ connectedAt: "not-a-date" });
    const errors = validateConnectionItem(item);
    expect(
      errors.some(
        (e) => e.field === "connectedAt" && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("TTL なしで warning", () => {
    const item = mkConnectionItem();
    delete item.ttl;
    const errors = validateConnectionItem(item);
    expect(
      errors.some((e) => e.field === "ttl" && e.severity === "warning")
    ).toBe(true);
  });

  test("TTL が 0 でエラー", () => {
    const item = mkConnectionItem({ ttl: 0 });
    const errors = validateConnectionItem(item);
    expect(
      errors.some((e) => e.field === "ttl" && e.severity === "error")
    ).toBe(true);
  });

  test("TTL が負の値でエラー", () => {
    const item = mkConnectionItem({ ttl: -100 });
    const errors = validateConnectionItem(item);
    expect(
      errors.some((e) => e.field === "ttl" && e.severity === "error")
    ).toBe(true);
  });

  test("TTL が過去で warning", () => {
    const item = mkConnectionItem({ ttl: 1000 }); // 1970年
    const errors = validateConnectionItem(item);
    expect(
      errors.some(
        (e) => e.field === "ttl" && e.message.includes("過去")
      )
    ).toBe(true);
  });

  test("小数 TTL でエラー", () => {
    const item = mkConnectionItem({ ttl: 1234.5 });
    const errors = validateConnectionItem(item);
    expect(
      errors.some((e) => e.field === "ttl" && e.severity === "error")
    ).toBe(true);
  });
});

describe("validateConnectionItems", () => {
  test("有効な配列でエラーなし", () => {
    const items = [
      mkConnectionItem({ connectionId: "conn1" }),
      mkConnectionItem({ connectionId: "conn2" }),
    ];
    expect(validateConnectionItems(items)).toHaveLength(0);
  });

  test("空配列はエラーなし", () => {
    expect(validateConnectionItems([])).toHaveLength(0);
  });

  test("重複 connectionId でエラー", () => {
    const items = [
      mkConnectionItem({ connectionId: "conn1" }),
      mkConnectionItem({ connectionId: "conn1" }),
    ];
    const errors = validateConnectionItems(items);
    expect(errors.some((e) => e.message.includes("重複"))).toBe(true);
  });

  test("個別エラーに index が含まれる", () => {
    const items = [
      mkConnectionItem({ connectionId: "" }),
      mkConnectionItem(),
    ];
    const errors = validateConnectionItems(items);
    expect(errors.some((e) => e.field.includes("connections[0]"))).toBe(true);
  });
});

// ── ユーティリティ ────────────────────────────────────────────

describe("hasErrors", () => {
  test("error があれば true", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "err", severity: "error" },
    ];
    expect(hasErrors(errors)).toBe(true);
  });

  test("warning のみなら false", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "warn", severity: "warning" },
    ];
    expect(hasErrors(errors)).toBe(false);
  });

  test("空配列なら false", () => {
    expect(hasErrors([])).toBe(false);
  });
});

describe("formatErrors", () => {
  test("空配列は成功メッセージ", () => {
    expect(formatErrors([])).toBe("すべてのチェックが通過しました");
  });

  test("エラーをフォーマット", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "問題", severity: "error" },
      { field: "y", message: "注意", severity: "warning" },
    ];
    const result = formatErrors(errors);
    expect(result).toContain("[ERROR] x: 問題");
    expect(result).toContain("[WARNING] y: 注意");
  });
});
