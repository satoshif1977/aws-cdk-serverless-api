import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

// ── Items Handler 型定義 ──────────────────────────────────────────

export type RouteCtx = { event: APIGatewayProxyEventV2; id?: string };

export type RouteKey = `${'GET' | 'POST' | 'PUT' | 'DELETE'}:${'item' | 'collection'}`;

export type RouteHandler = (ctx: RouteCtx) => Promise<APIGatewayProxyResultV2>;

// ── WebSocket Handler 型定義 ──────────────────────────────────────

export type WsEvent = {
  requestContext: {
    connectionId: string;
    routeKey: string;
    domainName: string;
    stage: string;
  };
  body?: string;
};
