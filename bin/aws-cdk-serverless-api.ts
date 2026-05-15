#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';

const app = new cdk.App();
new AwsCdkServerlessApiStack(app, 'AwsCdkServerlessApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});
