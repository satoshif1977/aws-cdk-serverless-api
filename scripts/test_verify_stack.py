"""
verify_stack.py のユニットテスト

boto3 クライアントを MagicMock で差し替えることで
AWS 接続なしに全検証関数を網羅的にテストする。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from verify_stack import (
    VerifyResult,
    verify_dynamodb_table,
    verify_http_api,
    verify_lambda_function,
    verify_log_group,
    verify_websocket_api,
)


# ── ヘルパー ──────────────────────────────────────────────────
def make_dynamo_client(
    table: dict | None = None,
    ttl_status: str = "ENABLED",
    ttl_attr: str = "ttl",
    error: Exception | None = None,
) -> MagicMock:
    client = MagicMock()
    client.exceptions.ResourceNotFoundException = type("RNF", (Exception,), {})
    if error:
        client.describe_table.side_effect = error
    else:
        client.describe_table.return_value = {"Table": table or _default_table()}
    client.describe_time_to_live.return_value = {
        "TimeToLiveDescription": {"TimeToLiveStatus": ttl_status, "AttributeName": ttl_attr}
    }
    return client


def _default_table(
    billing: str = "PAY_PER_REQUEST",
    pk: str = "id",
) -> dict:
    return {
        "BillingModeSummary": {"BillingMode": billing},
        "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}],
    }


def make_lambda_client(
    runtime: str = "nodejs22.x",
    state: str = "Active",
    tracing: str = "PassThrough",
    error: Exception | None = None,
) -> MagicMock:
    client = MagicMock()
    client.exceptions.ResourceNotFoundException = type("RNF", (Exception,), {})
    if error:
        client.get_function.side_effect = error
    else:
        client.get_function.return_value = {
            "Configuration": {
                "Runtime": runtime,
                "State": state,
                "TracingConfig": {"Mode": tracing},
            }
        }
    return client


def make_logs_client(
    group_name: str = "/aws/lambda/stack-items-handler",
    retention: int = 7,
    error: Exception | None = None,
) -> MagicMock:
    client = MagicMock()
    if error:
        client.describe_log_groups.side_effect = error
    else:
        client.describe_log_groups.return_value = {
            "logGroups": [{"logGroupName": group_name, "retentionInDays": retention}]
        }
    return client


def make_apigw_client(
    apis: list[dict] | None = None,
    error: Exception | None = None,
) -> MagicMock:
    client = MagicMock()
    if error:
        client.get_apis.side_effect = error
    else:
        client.get_apis.return_value = {"Items": apis or []}
    return client


def has_ng(result: VerifyResult) -> bool:
    return result.ng_count > 0


def has_ok(result: VerifyResult) -> bool:
    return result.ok_count > 0


# ── VerifyResult テスト ───────────────────────────────────────
class TestVerifyResult:
    def test_ok_count(self) -> None:
        r = VerifyResult(section="テスト")
        r.ok("成功1"); r.ok("成功2"); r.ng("失敗1")
        assert r.ok_count == 2

    def test_ng_count(self) -> None:
        r = VerifyResult(section="テスト")
        r.ok("成功1"); r.ng("失敗1"); r.ng("失敗2")
        assert r.ng_count == 2

    def test_empty_counts(self) -> None:
        r = VerifyResult(section="空")
        assert r.ok_count == 0 and r.ng_count == 0

    def test_skip_not_counted(self) -> None:
        r = VerifyResult(section="テスト")
        r.skip("スキップ"); r.skip("スキップ2")
        assert r.ok_count == 0 and r.ng_count == 0


# ── verify_dynamodb_table テスト ──────────────────────────────
class TestVerifyDynamoDBTable:
    def test_success(self) -> None:
        result = verify_dynamodb_table("my-table", make_dynamo_client())
        assert not has_ng(result)

    def test_table_not_found(self) -> None:
        client = make_dynamo_client()
        client.describe_table.side_effect = client.exceptions.ResourceNotFoundException()
        result = verify_dynamodb_table("missing-table", client)
        assert has_ng(result)

    def test_api_error(self) -> None:
        result = verify_dynamodb_table("my-table", make_dynamo_client(error=Exception("接続エラー")))
        assert has_ng(result)

    def test_wrong_billing_mode(self) -> None:
        table = _default_table(billing="PROVISIONED")
        result = verify_dynamodb_table("my-table", make_dynamo_client(table=table))
        assert has_ng(result)

    def test_wrong_partition_key(self) -> None:
        table = _default_table(pk="connectionId")
        result = verify_dynamodb_table("my-table", make_dynamo_client(table=table))
        assert has_ng(result)

    def test_ttl_enabled(self) -> None:
        result = verify_dynamodb_table(
            "connections", make_dynamo_client(ttl_status="ENABLED", ttl_attr="ttl"),
            expected_ttl_attr="ttl",
        )
        assert not has_ng(result)

    def test_ttl_wrong_attribute(self) -> None:
        result = verify_dynamodb_table(
            "connections", make_dynamo_client(ttl_status="ENABLED", ttl_attr="expires"),
            expected_ttl_attr="ttl",
        )
        assert has_ng(result)

    def test_ttl_disabled(self) -> None:
        result = verify_dynamodb_table(
            "connections", make_dynamo_client(ttl_status="DISABLED"),
            expected_ttl_attr="ttl",
        )
        assert has_ng(result)

    def test_custom_pk(self) -> None:
        table = _default_table(pk="connectionId")
        result = verify_dynamodb_table(
            "connections", make_dynamo_client(table=table),
            expected_pk="connectionId",
        )
        assert not has_ng(result)

    def test_result_has_table_name_in_section(self) -> None:
        result = verify_dynamodb_table("my-items-table", make_dynamo_client())
        assert "my-items-table" in result.section


# ── verify_lambda_function テスト ─────────────────────────────
class TestVerifyLambdaFunction:
    def test_success(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client())
        assert not has_ng(result)

    def test_not_found(self) -> None:
        client = make_lambda_client()
        client.get_function.side_effect = client.exceptions.ResourceNotFoundException()
        result = verify_lambda_function("missing-fn", client)
        assert has_ng(result)

    def test_api_error(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client(error=Exception("エラー")))
        assert has_ng(result)

    def test_wrong_runtime(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client(runtime="python3.11"))
        assert has_ng(result)

    def test_inactive_state(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client(state="Inactive"))
        assert has_ng(result)

    def test_active_tracing_not_passthrough(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client(tracing="Active"))
        assert has_ng(result)

    def test_ok_count_all_pass(self) -> None:
        result = verify_lambda_function("my-handler", make_lambda_client())
        assert result.ok_count >= 4  # 存在・runtime・state・tracing


# ── verify_log_group テスト ───────────────────────────────────
class TestVerifyLogGroup:
    LG = "/aws/lambda/stack-items-handler"

    def test_success(self) -> None:
        result = verify_log_group(self.LG, make_logs_client(self.LG, 7))
        assert not has_ng(result)

    def test_not_found(self) -> None:
        client = make_logs_client("/other/group", 7)
        result = verify_log_group(self.LG, client)
        assert has_ng(result)

    def test_api_error(self) -> None:
        result = verify_log_group(self.LG, make_logs_client(error=Exception("エラー")))
        assert has_ng(result)

    def test_wrong_retention(self) -> None:
        result = verify_log_group(self.LG, make_logs_client(self.LG, retention=30))
        assert has_ng(result)

    def test_custom_retention(self) -> None:
        result = verify_log_group(self.LG, make_logs_client(self.LG, retention=14),
                                  expected_retention_days=14)
        assert not has_ng(result)

    def test_no_retention_set(self) -> None:
        client = MagicMock()
        client.describe_log_groups.return_value = {
            "logGroups": [{"logGroupName": self.LG}]  # retentionInDays なし
        }
        result = verify_log_group(self.LG, client)
        assert has_ng(result)


# ── verify_http_api テスト ────────────────────────────────────
class TestVerifyHttpApi:
    def test_success(self) -> None:
        apis = [{"Name": "my-api", "ProtocolType": "HTTP"}]
        result = verify_http_api("my-api", make_apigw_client(apis))
        assert not has_ng(result)

    def test_not_found(self) -> None:
        result = verify_http_api("my-api", make_apigw_client([]))
        assert has_ng(result)

    def test_api_error(self) -> None:
        result = verify_http_api("my-api", make_apigw_client(error=Exception("エラー")))
        assert has_ng(result)

    def test_wrong_protocol(self) -> None:
        apis = [{"Name": "my-api", "ProtocolType": "WEBSOCKET"}]
        result = verify_http_api("my-api", make_apigw_client(apis))
        assert has_ng(result)

    def test_other_api_not_matched(self) -> None:
        apis = [{"Name": "other-api", "ProtocolType": "HTTP"}]
        result = verify_http_api("my-api", make_apigw_client(apis))
        assert has_ng(result)


# ── verify_websocket_api テスト ───────────────────────────────
class TestVerifyWebSocketApi:
    def test_success(self) -> None:
        apis = [{"Name": "my-ws", "ProtocolType": "WEBSOCKET"}]
        result = verify_websocket_api("my-ws", make_apigw_client(apis))
        assert not has_ng(result)

    def test_not_found(self) -> None:
        result = verify_websocket_api("my-ws", make_apigw_client([]))
        assert has_ng(result)

    def test_api_error(self) -> None:
        result = verify_websocket_api("my-ws", make_apigw_client(error=Exception("エラー")))
        assert has_ng(result)

    def test_wrong_protocol(self) -> None:
        apis = [{"Name": "my-ws", "ProtocolType": "HTTP"}]
        result = verify_websocket_api("my-ws", make_apigw_client(apis))
        assert has_ng(result)

    def test_multiple_apis_correct_matched(self) -> None:
        apis = [
            {"Name": "other-api", "ProtocolType": "HTTP"},
            {"Name": "my-ws",     "ProtocolType": "WEBSOCKET"},
        ]
        result = verify_websocket_api("my-ws", make_apigw_client(apis))
        assert not has_ng(result)
