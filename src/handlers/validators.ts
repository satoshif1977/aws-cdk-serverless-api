/**
 * Items API - 入力バリデーション
 *
 * createItem / updateItem で受け取るリクエストボディのフィールドを検証する。
 * helpers.ts の parseBody（JSON パース）の後段で使用する。
 */

import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { respond } from './helpers';

// ── 型定義 ────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[]; response: APIGatewayProxyResultV2 };

// ── バリデーション関数 ────────────────────────────────────────────

/**
 * 指定フィールドが存在し、空文字でないことを検証する。
 */
export function validateRequired(
  data: Record<string, unknown>,
  fields: string[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const field of fields) {
    const value = data[field];
    if (value === undefined || value === null) {
      errors.push({ field, message: `${field} is required` });
    } else if (typeof value === 'string' && value.trim() === '') {
      errors.push({ field, message: `${field} must not be empty` });
    }
  }
  return errors;
}

/**
 * 指定フィールドが期待する型であることを検証する。
 */
export function validateTypes(
  data: Record<string, unknown>,
  schema: Record<string, 'string' | 'number' | 'boolean'>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [field, expectedType] of Object.entries(schema)) {
    const value = data[field];
    if (value !== undefined && value !== null && typeof value !== expectedType) {
      errors.push({ field, message: `${field} must be of type ${expectedType}` });
    }
  }
  return errors;
}

/**
 * createItem 用バリデーション: name 必須 + 型チェック
 */
export function validateCreateInput(data: Record<string, unknown>): ValidationResult {
  const errors = [
    ...validateRequired(data, ['name']),
    ...validateTypes(data, { name: 'string', price: 'number', active: 'boolean' }),
  ];
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      response: respond(400, { message: 'Validation failed', errors }),
    };
  }
  return { ok: true };
}

/**
 * updateItem 用バリデーション: 型チェックのみ（全フィールド任意）
 */
export function validateUpdateInput(data: Record<string, unknown>): ValidationResult {
  const errors = validateTypes(data, { name: 'string', price: 'number', active: 'boolean' });
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      response: respond(400, { message: 'Validation failed', errors }),
    };
  }
  return { ok: true };
}
