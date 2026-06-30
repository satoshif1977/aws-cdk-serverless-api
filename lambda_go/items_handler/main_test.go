package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ── モック ────────────────────────────────────────────────────
type mockDynamoDB struct {
	scanOutput    *dynamodb.ScanOutput
	scanErr       error
	getItemOutput *dynamodb.GetItemOutput
	getItemErr    error
	putItemErr    error
	deleteItemErr error
}

func (m *mockDynamoDB) Scan(_ context.Context, _ *dynamodb.ScanInput, _ ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	return m.scanOutput, m.scanErr
}
func (m *mockDynamoDB) GetItem(_ context.Context, _ *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return m.getItemOutput, m.getItemErr
}
func (m *mockDynamoDB) PutItem(_ context.Context, _ *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	return &dynamodb.PutItemOutput{}, m.putItemErr
}
func (m *mockDynamoDB) DeleteItem(_ context.Context, _ *dynamodb.DeleteItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return &dynamodb.DeleteItemOutput{}, m.deleteItemErr
}

// ── ヘルパー ──────────────────────────────────────────────────
func makeItem(id, name string) map[string]types.AttributeValue {
	av, _ := attributevalue.MarshalMap(map[string]any{"id": id, "name": name})
	return av
}

func parseBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("レスポンスボディのパース失敗: %v", err)
	}
	return m
}

func v2Event(method, id string, body string) events.APIGatewayV2HTTPRequest {
	e := events.APIGatewayV2HTTPRequest{
		Body: body,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: method,
			},
		},
	}
	if id != "" {
		e.PathParameters = map[string]string{"id": id}
	}
	return e
}

// ── listItems テスト ──────────────────────────────────────────
func TestListItems_Success(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-1", "アイテム1"),
				makeItem("id-2", "アイテム2"),
			},
		},
	}
	resp, err := Handler(context.Background(), v2Event("GET", "", ""))
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	if body["count"].(float64) != 2 {
		t.Errorf("count: want 2, got %v", body["count"])
	}
}

func TestListItems_EmptyTable(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	if body["count"].(float64) != 0 {
		t.Errorf("count: want 0, got %v", body["count"])
	}
}

func TestListItems_DynamoDBError(t *testing.T) {
	dbClient = &mockDynamoDB{scanErr: errors.New("DynamoDB 接続エラー")}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

// ── getItem テスト ────────────────────────────────────────────
func TestGetItem_Success(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("abc-123", "テスト")},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "abc-123", ""))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	item := body["item"].(map[string]any)
	if item["id"] != "abc-123" {
		t.Errorf("id: want abc-123, got %v", item["id"])
	}
}

func TestGetItem_NotFound(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: nil},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "no-such-id", ""))
	if resp.StatusCode != 404 {
		t.Errorf("ステータスコード: want 404, got %d", resp.StatusCode)
	}
}

func TestGetItem_DynamoDBError(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: nil,
		getItemErr:    errors.New("テーブル未存在"),
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "some-id", ""))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

// ── createItem テスト ─────────────────────────────────────────
func TestCreateItem_Success(t *testing.T) {
	dbClient = &mockDynamoDB{}
	body := `{"name":"新アイテム","price":1000}`
	resp, _ := Handler(context.Background(), v2Event("POST", "", body))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["id"] == nil || item["id"] == "" {
		t.Error("id が設定されていない")
	}
	if item["createdAt"] == nil {
		t.Error("createdAt が設定されていない")
	}
	if item["name"] != "新アイテム" {
		t.Errorf("name: want 新アイテム, got %v", item["name"])
	}
}

func TestCreateItem_InvalidJSON(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("POST", "", "not-json"))
	if resp.StatusCode != 400 {
		t.Errorf("ステータスコード: want 400, got %d", resp.StatusCode)
	}
}

func TestCreateItem_DynamoDBError(t *testing.T) {
	dbClient = &mockDynamoDB{putItemErr: errors.New("書き込みエラー")}
	resp, _ := Handler(context.Background(), v2Event("POST", "", `{"name":"test"}`))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

// ── updateItem テスト ─────────────────────────────────────────
func TestUpdateItem_Success(t *testing.T) {
	existing := makeItem("id-1", "旧名前")
	existing["price"] = &types.AttributeValueMemberN{Value: "500"}
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"name":"新名前","price":999}`))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["updatedAt"] == nil {
		t.Error("updatedAt が設定されていない")
	}
	if item["id"] != "id-1" {
		t.Errorf("id が上書きされた: %v", item["id"])
	}
}

func TestUpdateItem_NotFound(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: nil},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "no-id", `{"name":"test"}`))
	if resp.StatusCode != 404 {
		t.Errorf("ステータスコード: want 404, got %d", resp.StatusCode)
	}
}

func TestUpdateItem_InvalidJSON(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("id-1", "テスト")},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", "bad-json"))
	if resp.StatusCode != 400 {
		t.Errorf("ステータスコード: want 400, got %d", resp.StatusCode)
	}
}

// ── deleteItem テスト ─────────────────────────────────────────
func TestDeleteItem_Success(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("DELETE", "id-1", ""))
	if resp.StatusCode != 204 {
		t.Errorf("ステータスコード: want 204, got %d", resp.StatusCode)
	}
}

func TestDeleteItem_DynamoDBError(t *testing.T) {
	dbClient = &mockDynamoDB{deleteItemErr: errors.New("削除エラー")}
	resp, _ := Handler(context.Background(), v2Event("DELETE", "id-1", ""))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

// ── Handler ルーティングテスト ────────────────────────────────
func TestHandler_MethodNotAllowed(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("PATCH", "", ""))
	if resp.StatusCode != 405 {
		t.Errorf("ステータスコード: want 405, got %d", resp.StatusCode)
	}
}

func TestHandler_ContentTypeHeader(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	if resp.Headers["Content-Type"] != "application/json" {
		t.Errorf("Content-Type: want application/json, got %s", resp.Headers["Content-Type"])
	}
}

func TestNewUUID_Format(t *testing.T) {
	id := newUUID()
	// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx 形式を確認
	if len(id) != 36 {
		t.Errorf("UUID 長: want 36, got %d (%s)", len(id), id)
	}
	if id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		t.Errorf("UUID フォーマット不正: %s", id)
	}
}

func TestNewUUID_Unique(t *testing.T) {
	ids := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := newUUID()
		if ids[id] {
			t.Errorf("UUID が重複: %s", id)
		}
		ids[id] = true
	}
}

// ── レスポンスヘルパーテスト ──────────────────────────────────
func TestRespond_StatusCode(t *testing.T) {
	resp, err := respond(201, map[string]string{"key": "value"})
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
}

func TestErrRespond_Message(t *testing.T) {
	resp, _ := errRespond(404, "Not Found")
	body := parseBody(t, resp.Body)
	if body["message"] != "Not Found" {
		t.Errorf("message: want Not Found, got %v", body["message"])
	}
}

// ── newUUID バージョンビット確認 ──────────────────────────────
func TestNewUUID_Version4Bits(t *testing.T) {
	id := newUUID()
	// 13文字目（version）が '4' であることを確認
	if id[14] != '4' {
		t.Errorf("UUID version bit: want '4', got '%c' in %s", id[14], id)
	}
	// 19文字目（variant）が '8'〜'b' であることを確認
	variant := id[19]
	if variant != '8' && variant != '9' && variant != 'a' && variant != 'b' {
		t.Errorf("UUID variant bit 不正: '%c' in %s", variant, id)
	}
}

func TestCreateItem_IDNotOverwritten(t *testing.T) {
	dbClient = &mockDynamoDB{}
	// クライアントが id を送ってきても上書きされる（サーバー生成 id が使われる）
	resp, _ := Handler(context.Background(), v2Event("POST", "", `{"id":"client-id","name":"test"}`))
	if resp.StatusCode != 201 {
		t.Fatalf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	// サーバー生成の id（36文字 UUID 形式）に上書きされるはず
	if item["id"] == "client-id" {
		t.Error("クライアント指定の id がそのまま使われた（サーバー生成で上書きされるべき）")
	}
}

func TestListItems_ResponseStructure(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-1", "テスト"),
			},
		},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	body := parseBody(t, resp.Body)
	if _, ok := body["items"]; !ok {
		t.Error("レスポンスに items フィールドがない")
	}
	if _, ok := body["count"]; !ok {
		t.Error("レスポンスに count フィールドがない")
	}
}

// ── 境界値テスト ──────────────────────────────────────────────
func TestCreateItem_EmptyBody(t *testing.T) {
	dbClient = &mockDynamoDB{}
	// 空オブジェクトは valid JSON → 201 で id と createdAt だけが入る
	resp, _ := Handler(context.Background(), v2Event("POST", "", "{}"))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
}

func TestUpdateItem_DynamoDBWriteError(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("id-1", "テスト")},
		putItemErr:    errors.New("書き込みエラー"),
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"name":"新名前"}`))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

func TestGetItem_ResponseHasItemKey(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{
			Item: makeItem("id-99", "テストアイテム99"),
		},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "id-99", ""))
	if resp.StatusCode != 200 {
		t.Fatalf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	if _, ok := body["item"]; !ok {
		t.Error("レスポンスに item フィールドがない")
	}
}
