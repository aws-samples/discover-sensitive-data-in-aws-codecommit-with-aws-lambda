#!/usr/bin/env node
/* tslint:disable:no-submodule-imports no-import-side-effect no-unused-expression */
import * as cdk from "@aws-cdk/core";
import "source-map-support/register";

import { Resources } from "../lib/resources";

const app = new cdk.App();

new Resources(app, "CodeCommitSecretsStack", {
    secretArn: "<CHANGE_ME>",
    notificationEmail: "<CHANGE_ME>",
    codeCommitSystemUserName: "<CHANGE_ME>"
});
