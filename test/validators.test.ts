import {
  validateRequired,
  validateTypes,
  validateCreateInput,
  validateUpdateInput,
} from '../src/handlers/validators';

describe('validateRequired', () => {
  it('全フィールドが存在すればエラーなし', () => {
    expect(validateRequired({ name: 'test', price: 100 }, ['name', 'price'])).toHaveLength(0);
  });

  it('フィールドが undefined ならエラー', () => {
    const errors = validateRequired({}, ['name']);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('name');
    expect(errors[0].message).toBe('name is required');
  });

  it('フィールドが null ならエラー', () => {
    const errors = validateRequired({ name: null }, ['name']);
    expect(errors).toHaveLength(1);
  });

  it('空文字ならエラー', () => {
    const errors = validateRequired({ name: '' }, ['name']);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('name must not be empty');
  });

  it('スペースのみの文字列もエラー', () => {
    const errors = validateRequired({ name: '   ' }, ['name']);
    expect(errors).toHaveLength(1);
  });

  it('複数フィールド欠落で複数エラー', () => {
    const errors = validateRequired({}, ['name', 'price']);
    expect(errors).toHaveLength(2);
  });

  it('数値 0 はエラーにならない', () => {
    expect(validateRequired({ price: 0 }, ['price'])).toHaveLength(0);
  });

  it('boolean false はエラーにならない', () => {
    expect(validateRequired({ active: false }, ['active'])).toHaveLength(0);
  });
});

describe('validateTypes', () => {
  it('正しい型ならエラーなし', () => {
    const errors = validateTypes(
      { name: 'test', price: 100, active: true },
      { name: 'string', price: 'number', active: 'boolean' },
    );
    expect(errors).toHaveLength(0);
  });

  it('型が違えばエラー', () => {
    const errors = validateTypes({ name: 123 }, { name: 'string' });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('name must be of type string');
  });

  it('undefined のフィールドはスキップ（任意フィールド）', () => {
    expect(validateTypes({}, { name: 'string' })).toHaveLength(0);
  });

  it('null のフィールドはスキップ', () => {
    expect(validateTypes({ name: null }, { name: 'string' })).toHaveLength(0);
  });

  it('複数フィールドの型エラー', () => {
    const errors = validateTypes(
      { name: 123, price: 'abc' },
      { name: 'string', price: 'number' },
    );
    expect(errors).toHaveLength(2);
  });
});

describe('validateCreateInput', () => {
  it('name あり → ok: true', () => {
    const result = validateCreateInput({ name: 'test' });
    expect(result.ok).toBe(true);
  });

  it('name なし → ok: false + 400 レスポンス', () => {
    const result = validateCreateInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.response).toHaveProperty('statusCode', 400);
    }
  });

  it('name が数値 → ok: false（型エラー）', () => {
    const result = validateCreateInput({ name: 123 });
    expect(result.ok).toBe(false);
  });

  it('price が文字列 → ok: false', () => {
    const result = validateCreateInput({ name: 'test', price: 'abc' });
    expect(result.ok).toBe(false);
  });

  it('active が文字列 → ok: false', () => {
    const result = validateCreateInput({ name: 'test', active: 'yes' });
    expect(result.ok).toBe(false);
  });

  it('全フィールド正しい → ok: true', () => {
    const result = validateCreateInput({ name: 'item', price: 500, active: true });
    expect(result.ok).toBe(true);
  });
});

describe('validateUpdateInput', () => {
  it('空オブジェクト → ok: true（全フィールド任意）', () => {
    expect(validateUpdateInput({}).ok).toBe(true);
  });

  it('正しい型 → ok: true', () => {
    expect(validateUpdateInput({ name: 'updated', price: 200 }).ok).toBe(true);
  });

  it('name が数値 → ok: false', () => {
    const result = validateUpdateInput({ name: 42 });
    expect(result.ok).toBe(false);
  });

  it('price が文字列 → ok: false', () => {
    const result = validateUpdateInput({ price: 'free' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toHaveProperty('statusCode', 400);
    }
  });
});
