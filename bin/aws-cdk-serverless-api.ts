#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AwsCdkServerlessApiStack } from '../lib/aws-cdk-serverless-api-stack';

const app = new cdk.App();
const stack = new AwsCdkServerlessApiStack(app, 'AwsCdkServerlessApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});

Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
