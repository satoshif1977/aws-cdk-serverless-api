"""
aws-cdk-serverless-api スタック検証スクリプト

CDK デプロイ後に DynamoDB・Lambda・CloudWatch Logs・API Gateway の
リソースが正しく作成されているかを boto3 で確認する。

TypeScript/Go 実装との比較ポイント:
  - boto3 クライアントを引数で受け取る（依存注入）→ pytest でモック差し替え可能
  - VerifyResult dataclass で OK/NG を集計 → 終了コードに反映
  - 検証関数を独立させることで単体テストが容易

使用方法:
    python scripts/verify_stack.py [--stack-id <スタックID>] [--region <リージョン>]

前提条件:
    pip install boto3
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from typing import Any

import boto3

# ── デフォルト設定 ────────────────────────────────────────────
DEFAULT_STACK_ID = "AwsCdkServerlessApiStack"
DEFAULT_REGION   = "ap-northeast-1"
EXPECTED_LOG_RETENTION_DAYS = 7   # CDK: RetentionDays.ONE_WEEK


# ── 結果型 ────────────────────────────────────────────────────
@dataclass
class ResultItem:
    status: str   # "OK" | "NG" | "SKIP"
    message: str


@dataclass
class VerifyResult:
    section: str
    items: list[ResultItem] = field(default_factory=list)

    def ok(self, msg: str) -> None:
        self.items.append(ResultItem("OK", msg))

    def ng(self, msg: str) -> None:
        self.items.append(ResultItem("NG", msg))

    def skip(self, msg: str) -> None:
        self.items.append(ResultItem("SKIP", msg))

    @property
    def ok_count(self) -> int:
        return sum(1 for it in self.items if it.status == "OK")

    @property
    def ng_count(self) -> int:
        return sum(1 for it in self.items if it.status == "NG")

    def print(self) -> None:
        print(f"\n{'=' * 50}")
        print(f"  {self.section}")
        print("=" * 50)
        for it in self.items:
            prefix = {"OK": "[OK] ", "NG": "[NG] ", "SKIP": "[--] "}[it.status]
            print(f"  {prefix}{it.message}")


# ── DynamoDB 検証 ─────────────────────────────────────────────
def verify_dynamodb_table(
    table_name: str,
    client: Any,
    *,
    expected_billing_mode: str = "PAY_PER_REQUEST",
    expected_pk: str = "id",
    expected_ttl_attr: str | None = None,
) -> VerifyResult:
    """DynamoDB テーブルの存在・設定を検証する。"""
    result = VerifyResult(section=f"DynamoDB: {table_name}")

    try:
        resp = client.describe_table(TableName=table_name)
    except client.exceptions.ResourceNotFoundException:
        result.ng(f"テーブル '{table_name}' が見つかりません")
        return result
    except Exception as e:
        result.ng(f"DescribeTable エラー: {e}")
        return result

    table = resp["Table"]
    result.ok(f"テーブルが存在します: {table_name}")

    # 課金モード
    billing = table.get("BillingModeSummary", {}).get("BillingMode", "PROVISIONED")
    if billing == expected_billing_mode:
        result.ok(f"課金モード正常: {billing}")
    else:
        result.ng(f"課金モードが想定外: {billing} (期待: {expected_billing_mode})")

    # パーティションキー
    pk_keys = [k for k in table.get("KeySchema", []) if k["KeyType"] == "HASH"]
    pk_name = pk_keys[0]["AttributeName"] if pk_keys else None
    if pk_name == expected_pk:
        result.ok(f"パーティションキー正常: {pk_name}")
    else:
        result.ng(f"パーティションキーが想定外: {pk_name} (期待: {expected_pk})")

    # TTL 属性（指定された場合のみ）
    if expected_ttl_attr:
        ttl_resp = client.describe_time_to_live(TableName=table_name)
        ttl = ttl_resp.get("TimeToLiveDescription", {})
        if ttl.get("TimeToLiveStatus") in ("ENABLED", "ENABLING") and ttl.get("AttributeName") == expected_ttl_attr:
            result.ok(f"TTL 属性正常: {expected_ttl_attr}")
        else:
            result.ng(f"TTL 未設定または属性名不一致 (期待: {expected_ttl_attr})")

    return result


# ── Lambda 検証 ───────────────────────────────────────────────
def verify_lambda_function(
    function_name: str,
    client: Any,
    *,
    expected_runtime: str = "nodejs22.x",
) -> VerifyResult:
    """Lambda 関数の存在・ランタイム・状態を検証する。"""
    result = VerifyResult(section=f"Lambda: {function_name}")

    try:
        resp = client.get_function(FunctionName=function_name)
    except client.exceptions.ResourceNotFoundException:
        result.ng(f"Lambda 関数 '{function_name}' が見つかりません")
        return result
    except Exception as e:
        result.ng(f"GetFunction エラー: {e}")
        return result

    config = resp["Configuration"]
    result.ok(f"Lambda 関数が存在します: {function_name}")

    runtime = config.get("Runtime", "")
    if runtime == expected_runtime:
        result.ok(f"ランタイム正常: {runtime}")
    else:
        result.ng(f"ランタイムが想定外: {runtime} (期待: {expected_runtime})")

    state = config.get("State", "")
    if state == "Active":
        result.ok(f"関数ステータス正常: {state}")
    else:
        result.ng(f"関数ステータスが想定外: {state} (期待: Active)")

    tracing = config.get("TracingConfig", {}).get("Mode", "")
    if tracing == "PassThrough":
        result.ok(f"X-Ray トレーシング正常: {tracing}（コスト無料）")
    else:
        result.ng(f"X-Ray トレーシングが想定外: {tracing} (期待: PassThrough)")

    return result


# ── CloudWatch Logs 検証 ──────────────────────────────────────
def verify_log_group(
    log_group_name: str,
    client: Any,
    *,
    expected_retention_days: int = EXPECTED_LOG_RETENTION_DAYS,
) -> VerifyResult:
    """CloudWatch Logs グループの存在・保持期間を検証する。"""
    result = VerifyResult(section=f"CloudWatch Logs: {log_group_name}")

    try:
        resp = client.describe_log_groups(logGroupNamePrefix=log_group_name)
    except Exception as e:
        result.ng(f"DescribeLogGroups エラー: {e}")
        return result

    groups = [g for g in resp.get("logGroups", []) if g["logGroupName"] == log_group_name]
    if not groups:
        result.ng(f"ロググループ '{log_group_name}' が見つかりません")
        return result

    result.ok(f"ロググループが存在します: {log_group_name}")

    retention = groups[0].get("retentionInDays")
    if retention == expected_retention_days:
        result.ok(f"保持期間正常: {retention}日")
    else:
        result.ng(f"保持期間が想定外: {retention}日 (期待: {expected_retention_days}日)")

    return result


# ── API Gateway 検証 ──────────────────────────────────────────
def verify_http_api(
    api_name: str,
    client: Any,
) -> VerifyResult:
    """API Gateway HTTP API の存在・プロトコルを検証する。"""
    result = VerifyResult(section=f"API Gateway HTTP API: {api_name}")

    try:
        resp = client.get_apis()
    except Exception as e:
        result.ng(f"GetApis エラー: {e}")
        return result

    apis = [a for a in resp.get("Items", []) if a.get("Name") == api_name]
    if not apis:
        result.ng(f"HTTP API '{api_name}' が見つかりません")
        return result

    api = apis[0]
    result.ok(f"HTTP API が存在します: {api_name}")

    protocol = api.get("ProtocolType", "")
    if protocol == "HTTP":
        result.ok(f"プロトコル正常: {protocol}")
    else:
        result.ng(f"プロトコルが想定外: {protocol} (期待: HTTP)")

    return result


def verify_websocket_api(
    api_name: str,
    client: Any,
) -> VerifyResult:
    """API Gateway WebSocket API の存在・プロトコルを検証する。"""
    result = VerifyResult(section=f"API Gateway WebSocket API: {api_name}")

    try:
        resp = client.get_apis()
    except Exception as e:
        result.ng(f"GetApis エラー: {e}")
        return result

    apis = [a for a in resp.get("Items", []) if a.get("Name") == api_name]
    if not apis:
        result.ng(f"WebSocket API '{api_name}' が見つかりません")
        return result

    api = apis[0]
    result.ok(f"WebSocket API が存在します: {api_name}")

    protocol = api.get("ProtocolType", "")
    if protocol == "WEBSOCKET":
        result.ok(f"プロトコル正常: {protocol}")
    else:
        result.ng(f"プロトコルが想定外: {protocol} (期待: WEBSOCKET)")

    return result


# ── メイン ────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="aws-cdk-serverless-api スタック検証")
    parser.add_argument("--stack-id", default=DEFAULT_STACK_ID)
    parser.add_argument("--region",   default=DEFAULT_REGION)
    parser.add_argument("--profile",  default=None)
    args = parser.parse_args()

    sid = args.stack_id
    session = boto3.Session(profile_name=args.profile, region_name=args.region)

    print(f"\naws-cdk-serverless-api スタック検証")
    print(f"スタック ID : {sid}")
    print(f"リージョン  : {args.region}")

    results = [
        verify_dynamodb_table(f"{sid}-items",       session.client("dynamodb")),
        verify_dynamodb_table(f"{sid}-connections", session.client("dynamodb"),
                              expected_pk="connectionId", expected_ttl_attr="ttl"),
        verify_lambda_function(f"{sid}-items-handler", session.client("lambda")),
        verify_lambda_function(f"{sid}-ws-handler",    session.client("lambda")),
        verify_log_group(f"/aws/lambda/{sid}-items-handler", session.client("logs")),
        verify_log_group(f"/aws/lambda/{sid}-ws-handler",    session.client("logs")),
        verify_http_api(f"{sid}-items-api",   session.client("apigatewayv2")),
        verify_websocket_api(f"{sid}-ws-api", session.client("apigatewayv2")),
    ]

    total_ng = 0
    for r in results:
        r.print()
        total_ng += r.ng_count

    print(f"\n{'=' * 50}")
    print(f"  検証完了（NG: {total_ng}件）")
    print("=" * 50)

    if total_ng > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
