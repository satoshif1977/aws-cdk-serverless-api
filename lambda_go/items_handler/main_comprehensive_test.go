package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ── キャプチャモック（DynamoDB 入力パラメータ検証用） ──────────────

type captureDynamoDB struct {
	mockDynamoDB
	scanInputs      []*dynamodb.ScanInput
	getItemInputs   []*dynamodb.GetItemInput
	putItemInputs   []*dynamodb.PutItemInput
	deleteItemInputs []*dynamodb.DeleteItemInput
}

func (c *captureDynamoDB) Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	c.scanInputs = append(c.scanInputs, params)
	return c.mockDynamoDB.Scan(ctx, params, optFns...)
}

func (c *captureDynamoDB) GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	c.getItemInputs = append(c.getItemInputs, params)
	return c.mockDynamoDB.GetItem(ctx, params, optFns...)
}

func (c *captureDynamoDB) PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	c.putItemInputs = append(c.putItemInputs, params)
	return c.mockDynamoDB.PutItem(ctx, params, optFns...)
}

func (c *captureDynamoDB) DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	c.deleteItemInputs = append(c.deleteItemInputs, params)
	return c.mockDynamoDB.DeleteItem(ctx, params, optFns...)
}

// ── ルーティング テーブル駆動テスト ────────────────────────────────

func TestHandler_Routing_Table(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		id         string
		body       string
		wantStatus int
	}{
		{"GET /items", "GET", "", "", 200},
		{"GET /items/{id} found", "GET", "abc", "", 200},
		{"GET /items/{id} not found", "GET", "missing", "", 404},
		{"POST /items", "POST", "", `{"name":"test"}`, 201},
		{"POST /items with id", "POST", "some-id", `{"name":"test"}`, 201},
		{"PUT /items/{id}", "PUT", "abc", `{"name":"upd"}`, 200},
		{"PUT /items (no id)", "PUT", "", `{"name":"upd"}`, 405},
		{"DELETE /items/{id}", "DELETE", "abc", "", 204},
		{"DELETE /items (no id)", "DELETE", "", "", 405},
		{"PATCH /items", "PATCH", "", "", 405},
		{"HEAD /items", "HEAD", "", "", 405},
		{"OPTIONS /items", "OPTIONS", "", "", 405},
		{"TRACE /items", "TRACE", "", "", 405},
		{"CONNECT /items", "CONNECT", "", "", 405},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockDynamoDB{
				scanOutput: &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
			}
			// GET/PUT/DELETE で id 指定ありの場合は GetItem を返す
			if tt.id != "" && tt.id != "missing" {
				mock.getItemOutput = &dynamodb.GetItemOutput{Item: makeItem(tt.id, "test-item")}
			} else {
				mock.getItemOutput = &dynamodb.GetItemOutput{Item: nil}
			}
			dbClient = mock

			resp, err := Handler(context.Background(), v2Event(tt.method, tt.id, tt.body))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resp.StatusCode != tt.wantStatus {
				t.Errorf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
		})
	}
}

// ── エラーレスポンス message フィールド一括検証 ────────────────────

func TestErrorResponses_MessageField_Table(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		id         string
		body       string
		wantStatus int
		wantMsg    string
	}{
		{"invalid JSON on POST", "POST", "", "not-json", 400, "Invalid request body"},
		{"invalid JSON on PUT", "PUT", "id-1", "not-json", 400, "Invalid request body"},
		{"not found on GET", "GET", "no-id", "", 404, "Item not found"},
		{"not found on PUT", "PUT", "no-id", `{"name":"test"}`, 404, "Item not found"},
		{"method not allowed", "PATCH", "", "", 405, "Method Not Allowed"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockDynamoDB{
				scanOutput:    &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
				getItemOutput: &dynamodb.GetItemOutput{Item: nil},
			}
			// PUT with invalid JSON needs existing item to reach JSON parse
			if tt.method == "PUT" && tt.wantStatus == 400 {
				mock.getItemOutput = &dynamodb.GetItemOutput{Item: makeItem(tt.id, "existing")}
			}
			dbClient = mock

			resp, _ := Handler(context.Background(), v2Event(tt.method, tt.id, tt.body))
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}

			var body map[string]any
			if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
				t.Fatalf("body is not valid JSON: %v", err)
			}
			msg, ok := body["message"].(string)
			if !ok {
				t.Fatal("response body missing 'message' field")
			}
			if msg != tt.wantMsg {
				t.Errorf("message = %q, want %q", msg, tt.wantMsg)
			}
		})
	}
}

// ── Content-Type ヘッダー テーブル駆動検証 ─────────────────────────

func TestHandler_ContentType_Table(t *testing.T) {
	methods := []struct {
		name   string
		method string
		id     string
		body   string
	}{
		{"GET list", "GET", "", ""},
		{"GET item", "GET", "abc", ""},
		{"POST", "POST", "", `{"name":"test"}`},
		{"PUT", "PUT", "abc", `{"name":"upd"}`},
		{"DELETE", "DELETE", "abc", ""},
		{"405", "PATCH", "", ""},
	}
	for _, tt := range methods {
		t.Run(tt.name, func(t *testing.T) {
			dbClient = &mockDynamoDB{
				scanOutput:    &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
				getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("abc", "test")},
			}
			resp, _ := Handler(context.Background(), v2Event(tt.method, tt.id, tt.body))
			if resp.Headers["Content-Type"] != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", resp.Headers["Content-Type"])
			}
		})
	}
}

// ── キャプチャモック: DynamoDB 入力パラメータ検証 ──────────────────

func TestCapture_ScanUsesTableName(t *testing.T) {
	orig := tableName
	tableName = "test-items-table"
	defer func() { tableName = orig }()

	cap := &captureDynamoDB{
		mockDynamoDB: mockDynamoDB{
			scanOutput: &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
		},
	}
	dbClient = cap

	Handler(context.Background(), v2Event("GET", "", ""))

	if len(cap.scanInputs) != 1 {
		t.Fatalf("Scan calls = %d, want 1", len(cap.scanInputs))
	}
	if *cap.scanInputs[0].TableName != "test-items-table" {
		t.Errorf("Scan TableName = %q, want test-items-table", *cap.scanInputs[0].TableName)
	}
}

func TestCapture_GetItemUsesCorrectKey(t *testing.T) {
	orig := tableName
	tableName = "test-items-table"
	defer func() { tableName = orig }()

	cap := &captureDynamoDB{
		mockDynamoDB: mockDynamoDB{
			getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("target-id", "test")},
		},
	}
	dbClient = cap

	Handler(context.Background(), v2Event("GET", "target-id", ""))

	if len(cap.getItemInputs) != 1 {
		t.Fatalf("GetItem calls = %d, want 1", len(cap.getItemInputs))
	}
	if *cap.getItemInputs[0].TableName != "test-items-table" {
		t.Errorf("GetItem TableName = %q, want test-items-table", *cap.getItemInputs[0].TableName)
	}
	// Key に id が含まれること
	idAttr, ok := cap.getItemInputs[0].Key["id"]
	if !ok {
		t.Fatal("GetItem Key missing 'id'")
	}
	if s, ok := idAttr.(*types.AttributeValueMemberS); !ok || s.Value != "target-id" {
		t.Errorf("GetItem Key[id] = %v, want target-id", idAttr)
	}
}

func TestCapture_DeleteItemUsesCorrectKey(t *testing.T) {
	orig := tableName
	tableName = "test-items-table"
	defer func() { tableName = orig }()

	cap := &captureDynamoDB{mockDynamoDB: mockDynamoDB{}}
	dbClient = cap

	Handler(context.Background(), v2Event("DELETE", "del-id", ""))

	if len(cap.deleteItemInputs) != 1 {
		t.Fatalf("DeleteItem calls = %d, want 1", len(cap.deleteItemInputs))
	}
	if *cap.deleteItemInputs[0].TableName != "test-items-table" {
		t.Errorf("DeleteItem TableName = %q", *cap.deleteItemInputs[0].TableName)
	}
	idAttr, ok := cap.deleteItemInputs[0].Key["id"]
	if !ok {
		t.Fatal("DeleteItem Key missing 'id'")
	}
	if s, ok := idAttr.(*types.AttributeValueMemberS); !ok || s.Value != "del-id" {
		t.Errorf("DeleteItem Key[id] = %v, want del-id", idAttr)
	}
}

func TestCapture_CreateItemPutItemInput(t *testing.T) {
	orig := tableName
	tableName = "test-items-table"
	defer func() { tableName = orig }()

	cap := &captureDynamoDB{mockDynamoDB: mockDynamoDB{}}
	dbClient = cap

	Handler(context.Background(), v2Event("POST", "", `{"name":"capture-test"}`))

	if len(cap.putItemInputs) != 1 {
		t.Fatalf("PutItem calls = %d, want 1", len(cap.putItemInputs))
	}
	if *cap.putItemInputs[0].TableName != "test-items-table" {
		t.Errorf("PutItem TableName = %q", *cap.putItemInputs[0].TableName)
	}
	// Item に id と createdAt が含まれること
	item := cap.putItemInputs[0].Item
	if _, ok := item["id"]; !ok {
		t.Error("PutItem Item missing 'id'")
	}
	if _, ok := item["createdAt"]; !ok {
		t.Error("PutItem Item missing 'createdAt'")
	}
	if _, ok := item["name"]; !ok {
		t.Error("PutItem Item missing 'name'")
	}
}

func TestCapture_UpdateItemCallsGetThenPut(t *testing.T) {
	cap := &captureDynamoDB{
		mockDynamoDB: mockDynamoDB{
			getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("upd-id", "old")},
		},
	}
	dbClient = cap

	Handler(context.Background(), v2Event("PUT", "upd-id", `{"name":"new"}`))

	if len(cap.getItemInputs) != 1 {
		t.Errorf("GetItem calls = %d, want 1", len(cap.getItemInputs))
	}
	if len(cap.putItemInputs) != 1 {
		t.Errorf("PutItem calls = %d, want 1", len(cap.putItemInputs))
	}
}

// ── タイムスタンプフォーマット検証 ─────────────────────────────────

func TestCreateItem_CreatedAtRFC3339(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("POST", "", `{"name":"ts-test"}`))
	if resp.StatusCode != 201 {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	createdAt, ok := item["createdAt"].(string)
	if !ok {
		t.Fatal("createdAt is not a string")
	}
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		t.Errorf("createdAt is not RFC3339: %q (%v)", createdAt, err)
	}
}

func TestUpdateItem_UpdatedAtRFC3339(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("id-1", "test")},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"name":"upd"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	updatedAt, ok := item["updatedAt"].(string)
	if !ok {
		t.Fatal("updatedAt is not a string")
	}
	if _, err := time.Parse(time.RFC3339, updatedAt); err != nil {
		t.Errorf("updatedAt is not RFC3339: %q (%v)", updatedAt, err)
	}
}

// ── newUUID テーブル駆動（統計的検証） ─────────────────────────────

func TestNewUUID_Batch_Table(t *testing.T) {
	tests := []struct {
		name  string
		check func(id string) bool
	}{
		{"length is 36", func(id string) bool { return len(id) == 36 }},
		{"dash at pos 8", func(id string) bool { return id[8] == '-' }},
		{"dash at pos 13", func(id string) bool { return id[13] == '-' }},
		{"dash at pos 18", func(id string) bool { return id[18] == '-' }},
		{"dash at pos 23", func(id string) bool { return id[23] == '-' }},
		{"version 4", func(id string) bool { return id[14] == '4' }},
		{"variant 8-b", func(id string) bool {
			v := id[19]
			return v == '8' || v == '9' || v == 'a' || v == 'b'
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for i := 0; i < 50; i++ {
				id := newUUID()
				if !tt.check(id) {
					t.Errorf("check failed for UUID: %s", id)
				}
			}
		})
	}
}

// ── respond / errRespond 構造テーブル駆動 ─────────────────────────

func TestRespond_Table(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   any
	}{
		{"200 with map", 200, map[string]string{"key": "val"}},
		{"201 with nested", 201, map[string]any{"item": map[string]string{"id": "1"}}},
		{"204 with empty", 204, map[string]any{}},
		{"500 with error", 500, map[string]string{"message": "error"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, err := respond(tt.status, tt.body)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resp.StatusCode != tt.status {
				t.Errorf("status = %d, want %d", resp.StatusCode, tt.status)
			}
			if resp.Headers["Content-Type"] != "application/json" {
				t.Errorf("Content-Type = %q", resp.Headers["Content-Type"])
			}
			var parsed any
			if err := json.Unmarshal([]byte(resp.Body), &parsed); err != nil {
				t.Errorf("body is not valid JSON: %v", err)
			}
		})
	}
}

func TestErrRespond_Table(t *testing.T) {
	tests := []struct {
		status int
		msg    string
	}{
		{400, "Bad Request"},
		{404, "Not Found"},
		{405, "Method Not Allowed"},
		{500, "Internal Server Error"},
		{403, "Forbidden"},
		{409, "Conflict"},
	}
	for _, tt := range tests {
		t.Run(tt.msg, func(t *testing.T) {
			resp, _ := errRespond(tt.status, tt.msg)
			if resp.StatusCode != tt.status {
				t.Errorf("status = %d, want %d", resp.StatusCode, tt.status)
			}
			var body map[string]any
			if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
				t.Fatalf("body is not valid JSON: %v", err)
			}
			if body["message"] != tt.msg {
				t.Errorf("message = %q, want %q", body["message"], tt.msg)
			}
		})
	}
}

// ── listItems レスポンス items 配列の要素検証 ──────────────────────

func TestListItems_ItemsContainCorrectFields(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-a", "Alpha"),
				makeItem("id-b", "Beta"),
			},
		},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	body := parseBody(t, resp.Body)
	items := body["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items count = %d, want 2", len(items))
	}

	names := make([]string, len(items))
	for i, raw := range items {
		item := raw.(map[string]any)
		if _, ok := item["id"]; !ok {
			t.Errorf("items[%d] missing 'id'", i)
		}
		if _, ok := item["name"]; !ok {
			t.Errorf("items[%d] missing 'name'", i)
		}
		names[i] = item["name"].(string)
	}
	if names[0] != "Alpha" || names[1] != "Beta" {
		t.Errorf("item names = %v, want [Alpha Beta]", names)
	}
}

// ── createItem フルフロー検証 ─────────────────────────────────────

func TestCreateItem_FullFlow(t *testing.T) {
	dbClient = &mockDynamoDB{}
	body := `{"name":"Full Flow Item","price":1500,"category":"electronics"}`
	resp, _ := Handler(context.Background(), v2Event("POST", "", body))

	if resp.StatusCode != 201 {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	if resp.Headers["Content-Type"] != "application/json" {
		t.Errorf("Content-Type = %q", resp.Headers["Content-Type"])
	}

	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)

	// id: UUID 形式（36文字）
	id, ok := item["id"].(string)
	if !ok || len(id) != 36 {
		t.Errorf("id should be UUID (36 chars), got %q", id)
	}

	// createdAt: RFC3339
	createdAt, ok := item["createdAt"].(string)
	if !ok {
		t.Fatal("createdAt missing")
	}
	if !strings.Contains(createdAt, "T") {
		t.Errorf("createdAt should be RFC3339: %q", createdAt)
	}

	// 元のフィールドが保持される
	if item["name"] != "Full Flow Item" {
		t.Errorf("name = %v", item["name"])
	}
	if item["price"].(float64) != 1500 {
		t.Errorf("price = %v", item["price"])
	}
	if item["category"] != "electronics" {
		t.Errorf("category = %v", item["category"])
	}
}

// ── updateItem フルフロー検証 ─────────────────────────────────────

func TestUpdateItem_FullFlow(t *testing.T) {
	existing := makeItem("flow-id", "Old Name")
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}

	resp, _ := Handler(context.Background(), v2Event("PUT", "flow-id", `{"name":"New Name","extra":"field"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)

	// id は上書きされない
	if item["id"] != "flow-id" {
		t.Errorf("id = %v, want flow-id", item["id"])
	}
	// name は更新される
	if item["name"] != "New Name" {
		t.Errorf("name = %v, want New Name", item["name"])
	}
	// 新しいフィールドが追加される
	if item["extra"] != "field" {
		t.Errorf("extra = %v, want field", item["extra"])
	}
	// updatedAt が設定される
	if item["updatedAt"] == nil {
		t.Error("updatedAt missing")
	}
}

// ── ベンチマーク ──────────────────────────────────────────────────

func BenchmarkHandler_ListItems(b *testing.B) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-1", "bench1"),
				makeItem("id-2", "bench2"),
			},
		},
	}
	event := v2Event("GET", "", "")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Handler(context.Background(), event)
	}
}

func BenchmarkHandler_GetItem(b *testing.B) {
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("bench-id", "bench")},
	}
	event := v2Event("GET", "bench-id", "")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Handler(context.Background(), event)
	}
}

func BenchmarkHandler_CreateItem(b *testing.B) {
	dbClient = &mockDynamoDB{}
	event := v2Event("POST", "", `{"name":"bench","price":100}`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Handler(context.Background(), event)
	}
}

func BenchmarkHandler_DeleteItem(b *testing.B) {
	dbClient = &mockDynamoDB{}
	event := v2Event("DELETE", "bench-id", "")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Handler(context.Background(), event)
	}
}

func BenchmarkNewUUID(b *testing.B) {
	for i := 0; i < b.N; i++ {
		newUUID()
	}
}
