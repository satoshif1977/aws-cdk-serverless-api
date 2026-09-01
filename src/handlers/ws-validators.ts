/**
 * WebSocket API バリデーター
 *
 * WebSocket イベント・接続管理・ブロードキャストペイロードを
 * 検証する純粋関数群。AWS SDK に依存しないため単体テストが容易。
 *
 * 検証内容:
 *   - WebSocket イベント構造（requestContext / connectionId / routeKey）
 *   - connectionId のフォーマット（API Gateway 形式）
 *   - routeKey の有効値（$connect / $disconnect / $default）
 *   - API Gateway Management エンドポイント URL
 *   - ブロードキャストメッセージの JSON 構造・サイズ制約
 *   - DynamoDB 接続アイテムの構造・TTL チェック
 */

import type { WsEvent } from "./types";

// ── 型定義 ────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ConnectionItem {
  connectionId: string;
  connectedAt?: string;
  ttl?: number;
}

export interface BroadcastMessage {
  from?: string;
  message?: string;
  timestamp?: string;
}

// ── 定数 ─────────────────────────────────────────────────────

/** 有効な WebSocket routeKey */
export const VALID_ROUTE_KEYS = [
  "$connect",
  "$disconnect",
  "$default",
] as const;

/** API Gateway connectionId パターン（英数字 + `=`） */
export const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_=-]+$/;

/** connectionId の最大長 */
export const MAX_CONNECTION_ID_LENGTH = 256;

/** API Gateway WebSocket エンドポイント URL パターン */
export const WS_ENDPOINT_PATTERN =
  /^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/.+$/;

/** WebSocket フレームの最大サイズ（128 KB） */
export const MAX_WS_FRAME_SIZE = 128 * 1024;

/** API Gateway WebSocket メッセージの最大サイズ（32 KB） */
export const MAX_APIGW_MESSAGE_SIZE = 32 * 1024;

/** DynamoDB 接続 TTL の最小値（秒・0 より大きい） */
export const MIN_CONNECTION_TTL = 1;

/** DynamoDB 接続 TTL の最大推奨値（24時間） */
export const MAX_CONNECTION_TTL_HOURS = 24;

/** ISO 8601 日時パターン */
export const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// ── connectionId バリデーション ───────────────────────────────

/** connectionId が有効なフォーマットか */
export function isValidConnectionId(id: string): boolean {
  if (!id || id.length === 0) return false;
  if (id.length > MAX_CONNECTION_ID_LENGTH) return false;
  return CONNECTION_ID_PATTERN.test(id);
}

/** connectionId を検証する */
export function validateConnectionId(id: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!id || id.trim().length === 0) {
    errors.push({
      field: "connectionId",
      message: "connectionId が空です",
      severity: "error",
    });
    return errors;
  }

  if (id.length > MAX_CONNECTION_ID_LENGTH) {
    errors.push({
      field: "connectionId",
      message: `connectionId が最大長 ${MAX_CONNECTION_ID_LENGTH} を超えています（${id.length} 文字）`,
      severity: "error",
    });
  }

  if (!CONNECTION_ID_PATTERN.test(id)) {
    errors.push({
      field: "connectionId",
      message: `connectionId のフォーマットが不正です: "${id}"`,
      severity: "error",
    });
  }

  return errors;
}

// ── routeKey バリデーション ───────────────────────────────────

/** routeKey が有効か */
export function isValidRouteKey(key: string): boolean {
  return (VALID_ROUTE_KEYS as readonly string[]).includes(key);
}

/** routeKey がメッセージ送信を伴うか */
export function isMessageRoute(key: string): boolean {
  return key === "$default";
}

/** routeKey を検証する */
export function validateRouteKey(key: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!key || key.trim().length === 0) {
    errors.push({
      field: "routeKey",
      message: "routeKey が空です",
      severity: "error",
    });
    return errors;
  }

  if (!isValidRouteKey(key)) {
    errors.push({
      field: "routeKey",
      message: `未知の routeKey: "${key}"。有効値: ${VALID_ROUTE_KEYS.join(", ")}`,
      severity: "warning",
    });
  }

  return errors;
}

// ── エンドポイント URL バリデーション ────────────────────────

/** API Gateway WebSocket エンドポイント URL が有効か */
export function isValidWsEndpoint(url: string): boolean {
  return WS_ENDPOINT_PATTERN.test(url);
}

/** domainName と stage からエンドポイント URL を構築する */
export function buildEndpointUrl(domainName: string, stage: string): string {
  return `https://${domainName}/${stage}`;
}

/** エンドポイント URL を検証する */
export function validateEndpoint(
  domainName: string,
  stage: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!domainName || domainName.trim().length === 0) {
    errors.push({
      field: "domainName",
      message: "domainName が空です",
      severity: "error",
    });
  }

  if (!stage || stage.trim().length === 0) {
    errors.push({
      field: "stage",
      message: "stage が空です",
      severity: "error",
    });
  }

  if (domainName && stage) {
    const url = buildEndpointUrl(domainName, stage);
    if (!isValidWsEndpoint(url)) {
      errors.push({
        field: "endpoint",
        message: `エンドポイント URL が API Gateway 形式ではありません: "${url}"`,
        severity: "warning",
      });
    }
  }

  return errors;
}

// ── WebSocket イベントバリデーション ─────────────────────────

/** WebSocket イベント全体を検証する */
export function validateWsEvent(event: WsEvent): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!event.requestContext) {
    errors.push({
      field: "requestContext",
      message: "requestContext が未定義です",
      severity: "error",
    });
    return errors;
  }

  const ctx = event.requestContext;

  // connectionId
  errors.push(...validateConnectionId(ctx.connectionId));

  // routeKey
  errors.push(...validateRouteKey(ctx.routeKey));

  // domainName + stage
  errors.push(...validateEndpoint(ctx.domainName, ctx.stage));

  // $default ルートで body がない場合は warning
  if (isMessageRoute(ctx.routeKey) && !event.body) {
    errors.push({
      field: "body",
      message: "$default ルートにメッセージ body がありません",
      severity: "warning",
    });
  }

  // body のサイズチェック
  if (event.body) {
    const byteLen = new TextEncoder().encode(event.body).length;
    if (byteLen > MAX_APIGW_MESSAGE_SIZE) {
      errors.push({
        field: "body",
        message: `メッセージサイズ（${byteLen} バイト）が API Gateway 上限 ${MAX_APIGW_MESSAGE_SIZE} バイトを超えています`,
        severity: "error",
      });
    }
  }

  return errors;
}

// ── ブロードキャストメッセージバリデーション ──────────────────

/** ブロードキャストメッセージを検証する */
export function validateBroadcastMessage(
  msg: BroadcastMessage
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!msg.from) {
    errors.push({
      field: "from",
      message: "送信元 connectionId（from）がありません",
      severity: "warning",
    });
  } else {
    errors.push(
      ...validateConnectionId(msg.from).map((e) => ({
        ...e,
        field: `from`,
      }))
    );
  }

  if (msg.message === undefined || msg.message === null) {
    errors.push({
      field: "message",
      message: "メッセージ本文が未定義です",
      severity: "error",
    });
  }

  if (msg.timestamp) {
    if (!ISO8601_PATTERN.test(msg.timestamp)) {
      errors.push({
        field: "timestamp",
        message: `タイムスタンプが ISO 8601 形式ではありません: "${msg.timestamp}"`,
        severity: "warning",
      });
    }
  }

  // シリアライズ後のサイズチェック
  const serialized = JSON.stringify(msg);
  const byteLen = new TextEncoder().encode(serialized).length;
  if (byteLen > MAX_WS_FRAME_SIZE) {
    errors.push({
      field: "broadcastMessage",
      message: `ブロードキャストメッセージ（${byteLen} バイト）が WebSocket フレーム上限 ${MAX_WS_FRAME_SIZE} バイトを超えています`,
      severity: "error",
    });
  }

  return errors;
}

// ── DynamoDB 接続アイテムバリデーション ───────────────────────

/** DynamoDB 接続アイテムを検証する */
export function validateConnectionItem(
  item: ConnectionItem
): ValidationError[] {
  const errors: ValidationError[] = [];

  // connectionId
  if (!item.connectionId) {
    errors.push({
      field: "connectionId",
      message: "connectionId が空です",
      severity: "error",
    });
  } else {
    errors.push(...validateConnectionId(item.connectionId));
  }

  // connectedAt
  if (item.connectedAt !== undefined) {
    if (!ISO8601_PATTERN.test(item.connectedAt)) {
      errors.push({
        field: "connectedAt",
        message: `connectedAt が ISO 8601 形式ではありません: "${item.connectedAt}"`,
        severity: "warning",
      });
    }
  } else {
    errors.push({
      field: "connectedAt",
      message: "connectedAt が未設定です",
      severity: "warning",
    });
  }

  // TTL
  if (item.ttl !== undefined) {
    if (!Number.isInteger(item.ttl) || item.ttl < MIN_CONNECTION_TTL) {
      errors.push({
        field: "ttl",
        message: `TTL は正の整数である必要があります（現在: ${item.ttl}）`,
        severity: "error",
      });
    } else {
      // 過去の TTL（期限切れ）チェック
      const now = Math.floor(Date.now() / 1000);
      if (item.ttl < now) {
        errors.push({
          field: "ttl",
          message: "TTL が現在時刻より過去です（期限切れの可能性）",
          severity: "warning",
        });
      }
    }
  } else {
    errors.push({
      field: "ttl",
      message: "TTL が未設定です。DynamoDB TTL による自動削除が機能しません",
      severity: "warning",
    });
  }

  return errors;
}

/** 接続アイテム配列に重複がないか検証する */
export function validateConnectionItems(
  items: ConnectionItem[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  const seen = new Set<string>();
  items.forEach((item, idx) => {
    const itemErrors = validateConnectionItem(item);
    itemErrors.forEach((e) => {
      errors.push({
        ...e,
        field: `connections[${idx}].${e.field}`,
      });
    });

    if (item.connectionId && seen.has(item.connectionId)) {
      errors.push({
        field: `connections[${idx}].connectionId`,
        message: `重複した connectionId: "${item.connectionId}"`,
        severity: "error",
      });
    }
    if (item.connectionId) seen.add(item.connectionId);
  });

  return errors;
}

// ── ユーティリティ ────────────────────────────────────────────

/** エラーの有無を判定する（warning は含まない） */
export function hasErrors(errors: ValidationError[]): boolean {
  return errors.some((e) => e.severity === "error");
}

/** エラーをフォーマットする */
export function formatErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return "すべてのチェックが通過しました";
  return errors
    .map((e) => `[${e.severity.toUpperCase()}] ${e.field}: ${e.message}`)
    .join("\n");
}
