#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';

const app = new cdk.App();
new AwsCdkServerlessApiStack(app, 'AwsCdkServerlessApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});

// cdk-nag v3: Aspects.of().add() → Validations.of().addPlugins() に変更
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
