package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ── updateItem エラー系 ───────────────────────────────────────

func TestUpdateItem_GetItemError(t *testing.T) {
	dbClient = &mockDynamoDB{
		getItemErr: errors.New("DynamoDB 読み取りエラー"),
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"name":"test"}`))
	if resp.StatusCode != 500 {
		t.Errorf("ステータスコード: want 500, got %d", resp.StatusCode)
	}
}

func TestUpdateItem_EmptyPatch(t *testing.T) {
	existing := makeItem("id-1", "テスト")
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{}`))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
}

func TestUpdateItem_FieldPreserved(t *testing.T) {
	existing := makeItem("id-1", "旧名前")
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"price":100}`))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["name"] != "旧名前" {
		t.Errorf("name: want 旧名前（既存フィールドが保持されるべき）, got %v", item["name"])
	}
}

func TestUpdateItem_UpdatedAtIsSet(t *testing.T) {
	existing := makeItem("id-1", "テスト")
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-1", `{"name":"新名前"}`))
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["updatedAt"] == nil || item["updatedAt"] == "" {
		t.Error("updatedAt が設定されていない")
	}
}

func TestUpdateItem_IdPreservedAfterUpdate(t *testing.T) {
	existing := makeItem("id-abc", "テスト")
	dbClient = &mockDynamoDB{
		getItemOutput: &dynamodb.GetItemOutput{Item: existing},
	}
	// パッチで id を上書きしようとしても元の id が保持される
	resp, _ := Handler(context.Background(), v2Event("PUT", "id-abc", `{"id":"hacked","name":"test"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["id"] != "id-abc" {
		t.Errorf("id: want id-abc（上書き禁止）, got %v", item["id"])
	}
}

// ── Handler ルーティング追加テスト ────────────────────────────

func TestHandler_PUTWithoutId(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("PUT", "", `{"name":"test"}`))
	if resp.StatusCode != 405 {
		t.Errorf("ステータスコード: want 405, got %d", resp.StatusCode)
	}
}

func TestHandler_DELETEWithoutId(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("DELETE", "", ""))
	if resp.StatusCode != 405 {
		t.Errorf("ステータスコード: want 405, got %d", resp.StatusCode)
	}
}

func TestHandler_HEADMethod(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("HEAD", "", ""))
	if resp.StatusCode != 405 {
		t.Errorf("ステータスコード: want 405, got %d", resp.StatusCode)
	}
}

func TestHandler_OPTIONSMethod(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("OPTIONS", "", ""))
	if resp.StatusCode != 405 {
		t.Errorf("ステータスコード: want 405, got %d", resp.StatusCode)
	}
}

func TestHandler_POSTWithId(t *testing.T) {
	// POST は id の有無に関わらず createItem を呼ぶ（ルーティング確認）
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("POST", "some-id", `{"name":"test"}`))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
}

// ── createItem 追加テスト ─────────────────────────────────────

func TestCreateItem_MultipleFields(t *testing.T) {
	dbClient = &mockDynamoDB{}
	body := `{"name":"テスト","price":500,"category":"food"}`
	resp, _ := Handler(context.Background(), v2Event("POST", "", body))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["category"] != "food" {
		t.Errorf("category: want food, got %v", item["category"])
	}
}

func TestCreateItem_BooleanValue(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("POST", "", `{"active":true}`))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
}

func TestCreateItem_NumberField(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("POST", "", `{"price":9999}`))
	if resp.StatusCode != 201 {
		t.Errorf("ステータスコード: want 201, got %d", resp.StatusCode)
	}
	parsed := parseBody(t, resp.Body)
	item := parsed["item"].(map[string]any)
	if item["price"].(float64) != 9999 {
		t.Errorf("price: want 9999, got %v", item["price"])
	}
}

// ── listItems 追加テスト ──────────────────────────────────────

func TestListItems_ThreeItems(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-1", "A"),
				makeItem("id-2", "B"),
				makeItem("id-3", "C"),
			},
		},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	if resp.StatusCode != 200 {
		t.Errorf("ステータスコード: want 200, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	if body["count"].(float64) != 3 {
		t.Errorf("count: want 3, got %v", body["count"])
	}
}

func TestListItems_CountMatchesItems(t *testing.T) {
	dbClient = &mockDynamoDB{
		scanOutput: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				makeItem("id-1", "A"),
				makeItem("id-2", "B"),
			},
		},
	}
	resp, _ := Handler(context.Background(), v2Event("GET", "", ""))
	body := parseBody(t, resp.Body)
	items := body["items"].([]any)
	count := int(body["count"].(float64))
	if len(items) != count {
		t.Errorf("items 数 (%d) と count (%d) が一致しない", len(items), count)
	}
}

// ── deleteItem 追加テスト ─────────────────────────────────────

func TestDeleteItem_ReturnsEmptyBody(t *testing.T) {
	dbClient = &mockDynamoDB{}
	resp, _ := Handler(context.Background(), v2Event("DELETE", "id-1", ""))
	if resp.StatusCode != 204 {
		t.Fatalf("ステータスコード: want 204, got %d", resp.StatusCode)
	}
	body := parseBody(t, resp.Body)
	if len(body) != 0 {
		t.Errorf("204 レスポンスのボディが空でない: %v", body)
	}
}

// ── レスポンスヘルパー追加テスト ─────────────────────────────

func TestErrRespond_StatusCode(t *testing.T) {
	resp, _ := errRespond(403, "Forbidden")
	if resp.StatusCode != 403 {
		t.Errorf("ステータスコード: want 403, got %d", resp.StatusCode)
	}
}

func TestRespond_BodyIsValidJSON(t *testing.T) {
	resp, _ := respond(200, map[string]string{"key": "val"})
	var out map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &out); err != nil {
		t.Errorf("ボディが有効な JSON でない: %v", err)
	}
}

// ── UUID 追加テスト ───────────────────────────────────────────

func TestNewUUID_IsHexOnly(t *testing.T) {
	id := newUUID()
	for _, c := range id {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == '-' {
			continue
		}
		t.Errorf("UUID に不正文字: '%c' in %s", c, id)
	}
}

// ── Fuzz テスト ───────────────────────────────────────────────

func FuzzHandlerNoPanic(f *testing.F) {
	seeds := []struct{ method, body string }{
		{"GET", ""},
		{"POST", `{"name":"test"}`},
		{"POST", `not-json`},
		{"PUT", `{"name":"updated"}`},
		{"DELETE", ""},
		{"PATCH", ""},
		{"HEAD", ""},
		{"OPTIONS", ""},
		{"GET", `{"unexpected":"body"}`},
		{"POST", `{}`},
	}
	for _, s := range seeds {
		f.Add(s.method, s.body)
	}
	f.Fuzz(func(t *testing.T, method, body string) {
		if !utf8.ValidString(method) || !utf8.ValidString(body) {
			t.Skip()
		}
		dbClient = &mockDynamoDB{
			scanOutput:    &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{}},
			getItemOutput: &dynamodb.GetItemOutput{Item: nil},
		}
		resp, _ := Handler(context.Background(), v2Event(method, "", body))
		if resp.StatusCode < 100 || resp.StatusCode >= 600 {
			t.Errorf("不正なステータスコード: %d", resp.StatusCode)
		}
	})
}

func FuzzCreateItemBody(f *testing.F) {
	f.Add(`{}`)
	f.Add(`{"name":"test"}`)
	f.Add(`{"name":"test","price":100}`)
	f.Add(`not-json`)
	f.Add(`{"id":"forced","name":"override-attempt"}`)
	f.Fuzz(func(t *testing.T, body string) {
		if !utf8.ValidString(body) {
			t.Skip()
		}
		dbClient = &mockDynamoDB{}
		resp, _ := Handler(context.Background(), v2Event("POST", "", body))
		if resp.StatusCode != 201 && resp.StatusCode != 400 && resp.StatusCode != 500 {
			t.Errorf("予期しないステータスコード: %d", resp.StatusCode)
		}
	})
}

func FuzzUpdateItemBody(f *testing.F) {
	f.Add("id-1", `{}`)
	f.Add("id-1", `{"name":"test"}`)
	f.Add("id-abc", `not-json`)
	f.Add("id-1", `{"id":"overwrite"}`)
	f.Add("id-xyz", `{"price":0}`)
	f.Fuzz(func(t *testing.T, id, body string) {
		if !utf8.ValidString(id) || !utf8.ValidString(body) {
			t.Skip()
		}
		dbClient = &mockDynamoDB{
			getItemOutput: &dynamodb.GetItemOutput{Item: makeItem("id-1", "テスト")},
		}
		resp, _ := Handler(context.Background(), v2Event("PUT", id, body))
		if resp.StatusCode < 100 || resp.StatusCode >= 600 {
			t.Errorf("不正なステータスコード: %d", resp.StatusCode)
		}
	})
}
