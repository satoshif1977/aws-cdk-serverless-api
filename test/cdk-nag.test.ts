import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * cdk-nag（AwsSolutions）の抑制が実際に効いていることを検証する回帰テスト。
 *
 * 背景:
 *   aws-cdk-lib 2.262.1 で Validations.acknowledge() が書き込むメタデータキーの
 *   接頭辞が 'annotation::' から 'Annotation::' に変わった。
 *   cdk-nag 3.0.1 は小文字の 'annotation::' しか剥がさないため、
 *   aws-cdk-lib を上げた瞬間に抑制が黙って外れ、synth がエラーで落ちていた。
 *   cdk-nag 3.0.2 で大文字小文字を無視する修正が入っている。
 *
 * 通常の Template.fromStack() では cdk-nag v3 の違反を観測できない
 * （プラグイン経由で検証レポートに出力されるため）。
 * そのため bin/aws-cdk-serverless-api.ts と同じ構成で app.synth() まで実行し、
 * 生成される validation-report.json を直接検証する。
 */

interface Violation {
  ruleName: string;
  severity: string;
  constructPaths: string[];
}

/** App を synth して検証レポートの違反一覧を返す */
function synthAndCollectViolations(
  build: (app: cdk.App, env: cdk.Environment) => void,
): Violation[] {
  // cdk.json の context（フィーチャーフラグ）を読み込む。
  // enablePartitionLiterals の有無で ARN が arn:aws: と arn:<AWS::Partition>: に
  // 分かれ、IAM5 の finding ID が実際の synth と一致しなくなるため必須。
  const context = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf-8'),
  ).context;

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-test-'));
  const app = new cdk.App({ outdir, context });

  // bin/aws-cdk-serverless-api.ts と同じ env の解決方法を使う
  const env: cdk.Environment = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  };
  build(app, env);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

  // 検証失敗時の挙動はバージョンで異なる（aws-cdk-lib 2.261 は例外を投げず、
  // 2.268 は ValidationFailed を投げる）。どちらでもレポートは書き出されるため、
  // 例外は一旦受けてレポートの内容で判定する。
  // レポートが無い場合は検証以外の理由で失敗しているので、そのまま送出する。
  const reportPath = path.join(outdir, 'validation-report.json');
  try {
    app.synth();
  } catch (err) {
    if (!fs.existsSync(reportPath)) {
      throw err;
    }
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  return (report.pluginReports ?? []).flatMap((plugin: any) =>
    (plugin.violations ?? []).map((v: any) => ({
      ruleName: v.ruleName,
      severity: v.severity,
      constructPaths: (v.violatingConstructs ?? []).map(
        (c: any) => c.constructPath,
      ),
    })),
  );
}

describe('cdk-nag AwsSolutions', () => {
  test('抑制済みルールを除き、違反が 1 件も残らない', () => {
    const violations = synthAndCollectViolations((app, env) => {
      new AwsCdkServerlessApiStack(app, 'AwsCdkServerlessApiStack', { env });
    });

    // 失敗時に何が漏れたか分かるようにルール名を添えて表示する
    expect(
      violations.map((v) => `${v.severity} ${v.ruleName} @ ${v.constructPaths.join(',')}`),
    ).toEqual([]);
  });

  test('検証ハーネス自体が違反を検知できる（テストの自己検証）', () => {
    // 抑制を一切書いていないスタックでは違反が検出されることを確認する。
    // これが無いと、プラグインが実行されずに違反ゼロとなった場合でも
    // 上のテストが素通りしてしまう。
    const violations = synthAndCollectViolations((app, env) => {
      const stack = new cdk.Stack(app, 'CanaryStack', { env });
      // アクセスログ・HTTPS 強制なしの素の S3 バケット（AwsSolutions-S1 / S10 に違反）
      new s3.Bucket(stack, 'PlainBucket');
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.ruleName).join(' ')).toContain('AwsSolutions-');
  });
});
