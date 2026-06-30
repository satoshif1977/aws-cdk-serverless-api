// aws-cdk-serverless-api: Go 実装（TypeScript 版 items.ts との並置）
//
// TypeScript 版との比較ポイント:
//   - コールドスタートが Node.js より高速（バイナリ実行・ランタイム起動なし）
//   - 型安全: 構造体でリクエスト/レスポンスを厳密に定義
//   - DynamoDBAPI インターフェースでモック差し替えが可能 → 完全なユニットテスト
//   - 対応ルート: GET/POST /items, GET/PUT/DELETE /items/{id}
//
// ビルド方法:
//
//	GOOS=linux GOARCH=arm64 go build -o bootstrap main.go
//	zip lambda_go.zip bootstrap
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ── 環境変数 ──────────────────────────────────────────────────
var tableName = os.Getenv("TABLE_NAME")

// ── DynamoDB クライアントインターフェース（テスト用モック差し替え可） ──
type DynamoDBAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error)
}

var dbClient DynamoDBAPI

func init() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("AWS 設定の読み込みに失敗: %v", err)
	}
	dbClient = dynamodb.NewFromConfig(cfg)
}

// ── ヘルパー ──────────────────────────────────────────────────
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func respond(statusCode int, body any) (events.APIGatewayV2HTTPResponse, error) {
	b, _ := json.Marshal(body)
	return events.APIGatewayV2HTTPResponse{
		StatusCode: statusCode,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       string(b),
	}, nil
}

func errRespond(statusCode int, msg string) (events.APIGatewayV2HTTPResponse, error) {
	return respond(statusCode, map[string]string{"message": msg})
}

func itemKey(id string) (map[string]types.AttributeValue, error) {
	return attributevalue.MarshalMap(map[string]string{"id": id})
}

// ── ルートハンドラー ──────────────────────────────────────────

func listItems(ctx context.Context) (events.APIGatewayV2HTTPResponse, error) {
	out, err := dbClient.Scan(ctx, &dynamodb.ScanInput{
		TableName: aws.String(tableName),
	})
	if err != nil {
		log.Printf("Scan エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}

	items := make([]map[string]any, 0, len(out.Items))
	for _, av := range out.Items {
		var m map[string]any
		if e := attributevalue.UnmarshalMap(av, &m); e == nil {
			items = append(items, m)
		}
	}
	return respond(200, map[string]any{"items": items, "count": len(items)})
}

func getItem(ctx context.Context, id string) (events.APIGatewayV2HTTPResponse, error) {
	key, err := itemKey(id)
	if err != nil {
		return errRespond(500, "Internal Server Error")
	}
	out, err := dbClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key:       key,
	})
	if err != nil {
		log.Printf("GetItem エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	if out.Item == nil {
		return errRespond(404, "Item not found")
	}
	var item map[string]any
	_ = attributevalue.UnmarshalMap(out.Item, &item)
	return respond(200, map[string]any{"item": item})
}

func createItem(ctx context.Context, body string) (events.APIGatewayV2HTTPResponse, error) {
	var data map[string]any
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		return errRespond(400, "Invalid request body")
	}
	data["id"] = newUUID()
	data["createdAt"] = time.Now().UTC().Format(time.RFC3339)

	av, err := attributevalue.MarshalMap(data)
	if err != nil {
		log.Printf("MarshalMap エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	if _, err = dbClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item:      av,
	}); err != nil {
		log.Printf("PutItem エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	return respond(201, map[string]any{"item": data})
}

func updateItem(ctx context.Context, id, body string) (events.APIGatewayV2HTTPResponse, error) {
	key, err := itemKey(id)
	if err != nil {
		return errRespond(500, "Internal Server Error")
	}
	existing, err := dbClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key:       key,
	})
	if err != nil {
		log.Printf("GetItem エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	if existing.Item == nil {
		return errRespond(404, "Item not found")
	}

	var current map[string]any
	_ = attributevalue.UnmarshalMap(existing.Item, &current)

	var patch map[string]any
	if err := json.Unmarshal([]byte(body), &patch); err != nil {
		return errRespond(400, "Invalid request body")
	}
	for k, v := range patch {
		current[k] = v
	}
	current["id"] = id // id の上書きを防ぐ
	current["updatedAt"] = time.Now().UTC().Format(time.RFC3339)

	av, _ := attributevalue.MarshalMap(current)
	if _, err = dbClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item:      av,
	}); err != nil {
		log.Printf("PutItem エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	return respond(200, map[string]any{"item": current})
}

func deleteItem(ctx context.Context, id string) (events.APIGatewayV2HTTPResponse, error) {
	key, err := itemKey(id)
	if err != nil {
		return errRespond(500, "Internal Server Error")
	}
	if _, err = dbClient.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(tableName),
		Key:       key,
	}); err != nil {
		log.Printf("DeleteItem エラー: %v", err)
		return errRespond(500, "Internal Server Error")
	}
	return respond(204, map[string]any{})
}

// ── Lambda ハンドラー ─────────────────────────────────────────
func Handler(ctx context.Context, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	method := event.RequestContext.HTTP.Method
	id := event.PathParameters["id"]

	log.Printf("リクエスト受信: method=%s path=%s hasId=%v", method, event.RawPath, id != "")

	switch {
	case method == "GET" && id == "":
		return listItems(ctx)
	case method == "GET" && id != "":
		return getItem(ctx, id)
	case method == "POST":
		return createItem(ctx, event.Body)
	case method == "PUT" && id != "":
		return updateItem(ctx, id, event.Body)
	case method == "DELETE" && id != "":
		return deleteItem(ctx, id)
	default:
		return errRespond(405, "Method Not Allowed")
	}
}

func main() {
	lambda.Start(Handler)
}
