import { APIGatewayProxyResultV2 } from 'aws-lambda';

export const respond = (
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * リクエストボディをパースし、失敗時は 400 レスポンスを返す。
 * JSON.parse を直接使うと不正なボディで 500 になるため、
 * API Gateway 境界でバリデーションを行う。
 */
export const parseBody = (
  rawBody: string | undefined,
): { ok: true; data: Record<string, unknown> } | { ok: false; response: APIGatewayProxyResultV2 } => {
  if (!rawBody) {
    return { ok: false, response: respond(400, { message: 'Request body is required' }) };
  }
  try {
    const data = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ok: false, response: respond(400, { message: 'Request body must be a JSON object' }) };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, response: respond(400, { message: 'Invalid JSON in request body' }) };
  }
};
