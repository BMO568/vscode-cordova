// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { DefaultApp } from './command/commandParams';

export class ACStrings {
    public static OkBtnLabel: string = 'Ok';
    public static UserMustSignIn: string = 'You are signed out. Please login to App Center';
    public static SelectLoginTypeMsg: string = 'Select the way you would like to authenticate with App Center';
    public static PleaseProvideToken: string = 'Please provide token to authenticate';
    public static PleaseLoginViaBrowser: string = 'We are about to launch a browser window so you can automatically create an App Center API token.';
    public static UserLoggedOutMsg: string = 'Successfully logged out of App Center';
    public static UserIsNotLoggedInMsg: string = 'You are not logged into App Center';
    public static LogoutPrompt: string = 'Please execute logout to signoff from App Center';
    public static NoCodePushDetectedMsg: string = 'Please install Cordova Code Push package to run this command.';
    public static NoCurrentAppSetMsg: string = 'No current app specified';
    public static NoCurrentDeploymentSetMsg: string = 'No current deployment';
    public static PleaseProvideCurrentAppMsg: string = 'Please click here to specify current app';
    public static PleaseProvideCurrentDeploymentMsg: string = 'Please click here to specify current deployment';
    public static ProvideCurrentAppPromptMsg: string = 'Please specify an App Center app';
    public static InvalidCurrentAppNameMsg: string = 'Sorry, provided app name is invalid';
    public static InvalidAppVersionParamMsg: string = 'Sorry, provided app version is invalid';
    public static FailedToExecuteLoginMsg: string = 'Failed to execute login to App Center';
    public static SelectCurrentDeploymentMsg: string = 'Please select current deployment';
    public static FetchAppsStatusBarMessage: string = 'Fetching current apps for you...';
    public static FetchDeploymentsStatusBarMessage: string = 'Fetching app deployments for you...';
    public static GettingAppInfoMessage: string = 'Getting app info...';
    public static DetectingAppVersionMessage: string = 'Detecting app version...';
    public static RunningReactNativeBundleCommandMessage: string = 'Running \"react-native bundle\" command...';
    public static ArchivingUpdateContentsMessage: string = 'Archiving update contents...';
    public static ReleasingUpdateContentsMessage: string = 'Releasing update contents to CodePush...';
    public static LoginToAppCenterButton: string = 'Login to App Center';
    public static PleaseProvideTargetBinaryVersion: string = 'Please provide semver compliant version';
    public static LogoutMenuLabel: string = 'Logout';
    public static MenuTitlePlaceholder: string = 'Please select action';

    public static YouAreLoggedInMsg: (name: string) => string = (name: string) => {
         return `You are logged in to App Center as '${name}'`;
    }

    public static YourCurrentAppMsg: (appName: string) => string = (appName: string) => {
        return `Your current app is '${appName}'`;
    }

    public static YourCurrentAppAndDeployemntMsg: (appName: string, deploymentName: string) => string = (appName: string, deploymentName: string) => {
        if (deploymentName) {
            return `Your current app is '${appName}', current deployment is '${deploymentName}'`;
        } else {
            return `Your current app is '${appName}', you have no deployments specified`;
        }
    }

    public static YourCurrentDeploymentMsg: (deploymentName: string) => string = (deploymentName: string) => {
        return `Your current deployment is '${deploymentName}'`;
    }

    public static ReleaseReactMenuText: (app: DefaultApp | null) => string = (app: DefaultApp | null) => {
        if (app) {
            return `Release '${app.appName}' to '${app.currentAppDeployments.currentDeploymentName}' deployment`;
        } else {
            return `Release cordova (please specify current app first)`;
        }
    }

    public static SetCurrentAppMenuText: (app: DefaultApp | null) => string = (app: DefaultApp | null) => {
        if (app) {
            return `Change '${app.appName}' to a different app`;
        } else {
            return `Set current app`;
        }
    }

    public static SetCurrentAppDeploymentText: (app: DefaultApp) => string = (app: DefaultApp) => {
        return `Change '${app.currentAppDeployments.currentDeploymentName}' to a different deployment`;
    }

    public static SetCurrentAppTargetBinaryVersionText: (app: DefaultApp) => string = (app: DefaultApp) => {
        const targetBinaryVersionProvided = app.targetBinaryVersion !== undefined && app.targetBinaryVersion;
        return `Change ${targetBinaryVersionProvided ? `'${app.targetBinaryVersion}'` : 'automatically fetched'} target binary version`;
    }

    public static SetCurrentAppIsMandatoryText: (app: DefaultApp) => string = (app: DefaultApp) => {
        const isMandatory = app.isMandatory !== undefined && app.isMandatory;
        return `Change release to ${isMandatory ? 'be not Mandatory' : 'be Mandatory'}`;
    }
}
