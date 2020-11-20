/* tslint:disable:max-line-length */
import { EventBridgeEvent } from "aws-lambda";
import * as AWS from "aws-sdk";

const TAG_NAME = process.env.TAG_NAME!;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN!;
const SECRET_ID = process.env.SECRET_ID!;
const REPO_URL = process.env.REPO_URL!;
const REPO_NAME = process.env.REPO_NAME!;

const CodeCommit = new AWS.CodeCommit({ apiVersion: "latest" });
const SNS = new AWS.SNS({ apiVersion: "latest" });
const SecretsManager = new AWS.SecretsManager({ apiVersion: "latest" });

const { execSync } = require("child_process");

export interface CodeCommitSecurityEventDetails {
    file: string;
    type: string;
    repositoryArn: string;
    repositoryName: string;
    commitId: string;
    oldCommitId: string;
    branch: string;
    committer: string;
}

export async function RaiseAlert(event: EventBridgeEvent<"CodeCommit Security Event", CodeCommitSecurityEventDetails>) {
    await SNS.publish({
        TopicArn: SNS_TOPIC_ARN,
        Subject: `[ACTION REQUIRED] Secrets discovered in ${event.detail.repositoryName}`,
        Message: `Security credentials were identified in file ${event.detail.file}, committed by ${event.detail.committer} on branch ${event.detail.branch} (${event.detail.commitId})`
    }).promise();
}

export async function LockRepository(event: EventBridgeEvent<"CodeCommit Security Event", CodeCommitSecurityEventDetails>) {
    await CodeCommit.tagResource({
        resourceArn: event.detail.repositoryArn,
        tags: {
            [TAG_NAME]: "locked"
        }
    }).promise();

    await SNS.publish({
        TopicArn: SNS_TOPIC_ARN,
        Subject: `[ACTION REQUIRED] ${event.detail.repositoryName} was locked to protect committed credentials`,
        Message: `Security credentials were identified in file ${event.detail.file}, committed by ${event.detail.committer} on branch ${event.detail.branch} (${event.detail.commitId}). The repository has been locked for normal users and an admin or superuser is required to unlock.`
    }).promise();
}

export async function ForceRevert(event: EventBridgeEvent<"CodeCommit Security Event", CodeCommitSecurityEventDetails>) {
    const gitCredentials = await SecretsManager.getSecretValue({
        SecretId: SECRET_ID
    }).promise();

    const secretJSON = JSON.parse(gitCredentials.SecretString!);
    const urlEncodedPw = encodeURIComponent(secretJSON.password);
    const urlEncodedUser = encodeURIComponent(secretJSON.user);
    const cloneURL = REPO_URL.replace("https://", `https://${urlEncodedUser}:${urlEncodedPw}@`);

    const gitCheckout = `git checkout ${event.detail.branch}`;
    const gitReset = `git reset --hard ${event.detail.oldCommitId}`;
    const gitPush = `git push origin ${event.detail.branch} --force`;
    const commands = [
        "rm -rf /tmp/*",
        `cd /tmp && git clone ${cloneURL}`,
        `cd /tmp/${REPO_NAME} && ${gitCheckout} && ${gitReset} && ${gitPush}`,
    ];

    commands.forEach((cmd) => {
        console.log(cmd);
        const res = execSync(cmd, { encoding: "utf8", stdio: "inherit" });
        if (res !== null) {
            console.log(res.split("\n"));
        }
    });

    await SNS.publish({
        TopicArn: SNS_TOPIC_ARN,
        Subject: `[ACTION REQUIRED] ${event.detail.repositoryName} required git reset --hard because of committed credentials`,
        Message: `Security credentials were identified in file ${event.detail.file}, committed by ${event.detail.committer} on branch ${event.detail.branch} (${event.detail.commitId}). The following commands were executed: 1) ${gitCheckout} 2) ${gitReset} 3) ${gitPush}`
    }).promise();
}
