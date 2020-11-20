/* tslint:disable:function-constructor no-unused-expression */
import { Repository } from "@aws-cdk/aws-codecommit";
import { EventBus, Rule } from "@aws-cdk/aws-events";
import * as targets from "@aws-cdk/aws-events-targets";
import { Effect, Group, PolicyStatement, User } from "@aws-cdk/aws-iam";
import { Code, Function, LayerVersion, Runtime } from "@aws-cdk/aws-lambda";
import { Secret } from "@aws-cdk/aws-secretsmanager";
import { Topic } from "@aws-cdk/aws-sns";
import * as subs from "@aws-cdk/aws-sns-subscriptions";
import { Construct, Duration, Stack, StackProps, Tags } from "@aws-cdk/core";
import * as path from "path";

interface CodeCommitStackProps extends StackProps {
    secretArn: string;
    notificationEmail: string;
    codeCommitSystemUserName: string;
}

export class Resources extends Stack {
    constructor(scope: Construct, id: string, props: CodeCommitStackProps) {
        super(scope, id, props);

        const DETAIL_TYPE = "CodeCommit Security Event";
        const TAG_NAME = "RepoState";

        const gitLambdaLayerVersionArn = `arn:aws:lambda:${this.region}:553035198032:layer:git-lambda2:7`;

        const superUsers = new Group(this, "CodeCommitSuperUsers", { groupName: "CodeCommitSuperUsers" });
        superUsers.addUser(new User(this, "CodeCommitSuperUserA", {
            password: new Secret(this, "CodeCommitSuperUserPassword").secretValue,
            userName: "CodeCommitSuperUserA"
        }));

        const users = new Group(this, "CodeCommitUsers", { groupName: "CodeCommitUsers" });
        users.addUser(new User(this, "User", {
            password: new Secret(this, "CodeCommitUserPassword").secretValue,
            userName: "CodeCommitUserA"
        }));

        const systemUser = User.fromUserName(this, "CodeCommitSystemUser", props.codeCommitSystemUserName);

        const repo = new Repository(this, "Repository", {
            repositoryName: "TestRepository",
            description: "The repository to test this project out",
        });
        Tags.of(repo).add(TAG_NAME, "ok");

        const topic = new Topic(this, "CodeCommitSecurityEventNotification", {
            displayName: "CodeCommitSecurityEventNotification",
        });

        topic.addSubscription(new subs.EmailSubscription(props.notificationEmail));

        const eventBus = new EventBus(this, "CodeCommitEventBus", {
            eventBusName: "CodeCommitSecurityEvents"
        });

        users.addToPolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["*"],
            resources: [repo.repositoryArn],
            conditions: {
                StringNotEquals: {
                    [`aws:ResourceTag/${TAG_NAME}`]: "locked"
                }
            }
        }));

        superUsers.addToPolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["*"],
            resources: [repo.repositoryArn]
        }));

        const lockRepositoryLambda = new Function(this, "LockRepositoryLambda", {
            runtime: Runtime.NODEJS_12_X,
            handler: "remediations.LockRepository",
            code: Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers")),
            environment: {
                TAG_NAME,
                SNS_TOPIC_ARN: topic.topicArn
            }
        });

        const raiseAlertLambda = new Function(this, "RaiseAlertLambda", {
            runtime: Runtime.NODEJS_12_X,
            handler: "remediations.RaiseAlert",
            code: Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers")),
            environment: {
                TAG_NAME,
                SNS_TOPIC_ARN: topic.topicArn
            }
        });

        const gitHubCredentials = Secret.fromSecretArn(this, "GitCommitSecrets", props?.secretArn!);

        const forcefulRevertLambda = new Function(this, "ForceRevert", {
            runtime: Runtime.NODEJS_12_X,
            handler: "remediations.ForceRevert",
            timeout: Duration.seconds(900),
            layers: [LayerVersion.fromLayerVersionAttributes(this, "GitLayer", {
                layerVersionArn: gitLambdaLayerVersionArn
            })],
            code: Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers")),
            environment: {
                TAG_NAME,
                SNS_TOPIC_ARN: topic.topicArn,
                SECRET_ID: gitHubCredentials.secretName,
                REPO_NAME: repo.repositoryName,
                REPO_URL: repo.repositoryCloneUrlHttp,
            }
        });

        topic.grantPublish(raiseAlertLambda);

        topic.grantPublish(lockRepositoryLambda);
        repo.grant(lockRepositoryLambda, "codecommit:*");

        topic.grantPublish(forcefulRevertLambda);
        repo.grantPullPush(forcefulRevertLambda);
        gitHubCredentials.grantRead(forcefulRevertLambda);

        new Rule(this, "CodeCommitSecurityEvent", {
            eventBus,
            enabled: true,
            ruleName: "CodeCommitSecurityEventRule",
            eventPattern: {
                detailType: [DETAIL_TYPE]
            },
            targets: [
                new targets.LambdaFunction(lockRepositoryLambda),
                new targets.LambdaFunction(raiseAlertLambda),
                new targets.LambdaFunction(forcefulRevertLambda)
            ]
        });

        const commitInspectLambda = new Function(this, "CommitInspectLambda", {
            runtime: Runtime.NODEJS_12_X,
            handler: "commits.InspectCommit",
            code: Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers")),
            environment: {
                EVENT_BUS_NAME: eventBus.eventBusName,
                DETAIL_TYPE,
                SECURITY_USER_ARN: systemUser.userArn
            },
            initialPolicy: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["codecommit:*"],
                    resources: [repo.repositoryArn]
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["events:PutEvents"],
                    resources: [eventBus.eventBusArn]
                })
            ]
        });

        repo.onCommit("AnyCommitEvent", {
            ruleName: "CallLambdaOnAnyCodeCommitEvent",
            target: new targets.LambdaFunction(commitInspectLambda)
        });
    }
}
