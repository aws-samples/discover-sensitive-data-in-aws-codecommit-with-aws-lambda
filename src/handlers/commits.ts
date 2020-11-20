/* tslint:disable:max-line-length no-submodule-imports */
import { EventBridgeEvent, S3CreateEvent } from "aws-lambda";
import * as AWS from "aws-sdk";
import { PutEventsRequestEntryList } from "aws-sdk/clients/eventbridge";

import { CodeCommitSecurityEventDetails } from "./remediations";

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const SECURITY_USER_ARN = process.env.SECURITY_USER_ARN!;
const DETAIL_TYPE = process.env.DETAIL_TYPE!;

const CodeCommit = new AWS.CodeCommit({ apiVersion: "latest" });
const EventBridge = new AWS.EventBridge({ apiVersion: "latest" });

interface CodeCommitEventDetails {
    callerUserArn: string;
    commitId: string;
    oldCommitId: string;
    event: string;
    referenceFullName: string;
    referenceName: string;
    referenceType: string;
    repositoryId: string;
    repositoryName: string;
}

function checkForCredentials(text: string) {
    const regexes: string[][] = require("./regex.json");
    const lines = text.split("\n");
    for (const line of lines) {
        const match = regexes.find((regex) => (new RegExp(regex[1], "ig").test(line)));
        if (match !== undefined) {
            return match;
        }
    }
    return null;
}

export async function InspectCommit(event: EventBridgeEvent<"CodeCommit Repository State Change", CodeCommitEventDetails>) {
    const { repositoryName, commitId, oldCommitId, callerUserArn } = event.detail;

    if (callerUserArn === SECURITY_USER_ARN) {
        console.log(`Request triggered by Security User (${callerUserArn}). Not processing`);
        return;
    }
    const repositoryInformation = await CodeCommit.getRepository({
        repositoryName
    }).promise();

    const repositoryArn = repositoryInformation.repositoryMetadata?.Arn!;
    const commit = await CodeCommit.getCommit({
        commitId,
        repositoryName
    }).promise();
    console.log(commit);

    const differences = await CodeCommit.getDifferences({
        repositoryName,
        beforeCommitSpecifier: oldCommitId,
        afterCommitSpecifier: commitId
    }).promise();

    const EventBridgeMessages: PutEventsRequestEntryList = [];
    for (const difference of differences.differences!) {
        const afterBlob = await CodeCommit.getBlob({
            repositoryName,
            blobId: difference.afterBlob?.blobId!
        }).promise();

        const blobContent = afterBlob.content.toString();
        console.log(blobContent);
        const credentialsInBlob = checkForCredentials(blobContent);

        if (credentialsInBlob === null) {
            console.log(`No credentials found in ${difference.afterBlob?.path!}`);
            continue;
        }

        console.log(`Credentials found in ${difference.afterBlob?.path!}`);

        const secretInfo = {
            file: difference.afterBlob?.path!,
            type: "AWS_CREDENTIALS",
            repositoryArn,
            repositoryName,
            commitId,
            oldCommitId,
            branch: event.detail.referenceName,
            committer: commit.commit.committer?.email!
        };

        EventBridgeMessages.push({
            DetailType: DETAIL_TYPE,
            Detail: JSON.stringify(secretInfo),
            EventBusName: EVENT_BUS_NAME,
            Source: "securitycheck.codecommit"
        });
    }

    if (EventBridgeMessages.length > 0) {
        console.log(`Secrets found in commit ${commitId}`);
        await EventBridge.putEvents({
            Entries: EventBridgeMessages
        }).promise();
    } else {
        console.log(`No secrets found in commit ${commitId}`);
    }

    return event;
}
