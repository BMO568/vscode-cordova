// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as fs from "fs";
import * as nls from "vscode-nls";
import * as vscode from "vscode";
import * as path from "path";
import { ErrorDestination, logger, Logger, LoggingDebugSession, OutputEvent } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { CordovaSessionManager } from "../extension/cordovaSessionManager";
import { CordovaSession, CordovaSessionStatus } from "./debugSessionWrapper";
import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "./requestArgs";
import { findFileInFolderHierarchy, generateRandomPortNumber, isNullOrUndefined } from "../utils/extensionHelper";
import { Telemetry } from "../utils/telemetry";
import { LogLevel } from "../utils/log/logHelper";
import { CordovaWorkspaceManager } from "../extension/cordovaWorkspaceManager";
import { NodeVersionHelper } from "../utils/nodeVersionHelper";
import { TelemetryHelper } from "../utils/telemetryHelper";
import { CordovaProjectHelper } from "../utils/cordovaProjectHelper";
import AbstractPlatform from "../extension/abstractPlatform";
import { SimulateHelper } from "../utils/simulateHelper";
import { IAndroidPlatformOptions, IBrowserPlatformOptions, IIosPlatformOptions } from "../extension/platformOptions";
import { settingsHome } from "../utils/settingsHelper";
import BrowserPlatform from "../extension/browser/browserPlatform";
import simulate = require("cordova-simulate");
import AndroidPlatform from "../extension/android/androidPlatform";
import IosPlatform from "../extension/ios/iosPlatform";
import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { DeferredPromise } from "../common/node/promise";
import { SourcemapPathTransformer } from "./cdp-proxy/sourcemapPathTransformer";
import { JsDebugConfigAdapter } from "./jsDebugConfigAdapter";
import IonicDevServer from "../utils/ionicDevServer";
import AbstractMobilePlatform from "../extension/abstractMobilePlatform";
import { LaunchScenariosManager } from "../utils/launchScenariosManager";
import { IMobileTarget } from "../utils/mobileTarget";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export const CANCELLATION_ERROR_NAME = "tokenCanceled";

export enum TargetType {
    Emulator = "emulator",
    Device = "device",
    Chrome = "chrome",
    Edge = "edge",
}

export enum PwaDebugType {
    Node = "pwa-node",
    Chrome = "pwa-chrome",
}

export enum PlatformType {
    Android = "android",
    IOS = "ios",
    Windows = "windows",
    Serve = "serve",
    AmazonFireos = "amazon_fireos",
    Blackberry10 = "blackberry10",
    Firefoxos = "firefoxos",
    Ubuntu = "ubuntu",
    Wp8 = "wp8",
    Browser = "browser",
}

export type DebugConsoleLogger = (message: string, error?: boolean | string) => void;

export interface WebviewData {
    devtoolsFrontendUrl: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export default class CordovaDebugSession extends LoggingDebugSession {
    private static readonly CANCELLATION_ERROR_NAME = "tokenCanceled";
    private static readonly STOP_COMMAND = "workbench.action.debug.stop"; // the command which simulates a click on the "Stop" button
    private static readonly CDP_PROXY_HOST_ADDRESS = "127.0.0.1"; // localhost
    private static CDP_PROXY_PORT: number;

    private readonly pwaSessionName: PwaDebugType;

    private istelemetryInitialized: boolean = false;
    private isSettingsInitialized: boolean = false; // used to prevent parameters reinitialization when attach is called from launch function
    private attachedDeferred: DeferredPromise<void> = new DeferredPromise<void>();

    private workspaceManager: CordovaWorkspaceManager;
    private cordovaCdpProxy: CordovaCDPProxy | null;
    private vsCodeDebugSession: vscode.DebugSession;
    private platform: AbstractPlatform | undefined;
    private onDidTerminateDebugSessionHandler: vscode.Disposable;
    private jsDebugConfigAdapter: JsDebugConfigAdapter = new JsDebugConfigAdapter();

    private cdpProxyLogLevel: LogLevel;
    private cancellationTokenSource: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
    private outputLogger: DebugConsoleLogger = (message: string, error?: boolean | string) => {
        let category = "console";
        if (error === true) {
            category = "stderr";
        }
        if (typeof error === "string") {
            category = error;
        }

        let newLine = "\n";
        if (category === "stdout" || category === "stderr") {
            newLine = "";
        }
        this.sendEvent(new OutputEvent(message + newLine, category));
    };

    constructor(
        private cordovaSession: CordovaSession,
        private sessionManager: CordovaSessionManager
    ) {
        super();
        CordovaDebugSession.CDP_PROXY_PORT = generateRandomPortNumber();
        this.vsCodeDebugSession = cordovaSession.getVSCodeDebugSession();
        if (this.vsCodeDebugSession.configuration.platform === PlatformType.IOS
            && (this.vsCodeDebugSession.configuration.target === TargetType.Emulator || this.vsCodeDebugSession.configuration.target === TargetType.Device)
        ) {
            this.pwaSessionName = PwaDebugType.Node; // the name of Node debug session created by js-debug extension
        } else {
            this.pwaSessionName = PwaDebugType.Chrome; // the name of Chrome debug session created by js-debug extension
        }
        this.onDidTerminateDebugSessionHandler = vscode.debug.onDidTerminateDebugSession(
            this.handleTerminateDebugSession.bind(this)
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async launchRequest(response: DebugProtocol.LaunchResponse, launchArgs: ICordovaLaunchRequestArgs, request?: DebugProtocol.Request): Promise<void> {
        try {
            if (isNullOrUndefined(launchArgs.cwd)) {
                throw new Error(localize("CwdUndefined", "Launch argument 'cwd' is undefined, please add it to your launch.json. Example: 'cwd': '${workspaceFolder}' to point to your current working directory."));
            }
            await this.initializeTelemetry(launchArgs.cwd);
            await this.initializeSettings(launchArgs);
            this.platform = await this.resolvePlatform(launchArgs);

            if (this.platform instanceof AbstractMobilePlatform) {
                await this.resolveAndSaveMobileTarget(this.platform, launchArgs);
            }

            await TelemetryHelper.generate("launch", async (generator) => {
                TelemetryHelper.sendPluginsList(launchArgs.cwd, CordovaProjectHelper.getInstalledPlugins(launchArgs.cwd));
                generator.add("target", CordovaDebugSession.getTargetType(launchArgs.target), false);
                generator.add("projectType", this.platform.getPlatformOpts().projectType, false);
                generator.add("platform", launchArgs.platform, false);
                this.outputLogger(localize("LaunchingForPlatform", "Launching for {0} (This may take a while)...", launchArgs.platform));

                const launchOptions = await (this.platform as BrowserPlatform).launchApp();
                Object.assign(launchArgs, launchOptions);

                await this.vsCodeDebugSession.customRequest("attach", launchArgs);

                this.sendResponse(response);
                this.cordovaSession.setStatus(CordovaSessionStatus.Activated);
            });
        } catch (error) {
            this.outputLogger(error.message || error, true);
            await this.cleanUp();
            this.showError(error, response);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async attachRequest(response: DebugProtocol.AttachResponse, attachArgs: ICordovaAttachRequestArgs, request?: DebugProtocol.Request): Promise<void> {
        try {
            await this.initializeTelemetry(attachArgs.cwd);
            await this.initializeSettings(attachArgs);
            attachArgs.port = attachArgs.port || 9222;
            if (!this.platform) {
                this.platform = await this.resolvePlatform(attachArgs);
            }
            if (this.platform instanceof AbstractMobilePlatform && !this.platform.target) {
                await this.resolveAndSaveMobileTarget(this.platform, attachArgs, true);
            }
            const projectType = this.platform.getPlatformOpts().projectType;

            await TelemetryHelper.generate("attach", async (generator) => {
                TelemetryHelper.sendPluginsList(attachArgs.cwd, CordovaProjectHelper.getInstalledPlugins(attachArgs.cwd));
                generator.add("target", CordovaDebugSession.getTargetType(attachArgs.target), false);
                generator.add("projectType", projectType, false);
                generator.add("platform", attachArgs.platform, false);

                const sourcemapPathTransformer = new SourcemapPathTransformer(attachArgs.cwd, attachArgs.platform, projectType, attachArgs.request, attachArgs.ionicLiveReload, attachArgs.address);
                this.cordovaCdpProxy = new CordovaCDPProxy(
                    CordovaDebugSession.CDP_PROXY_HOST_ADDRESS,
                    CordovaDebugSession.CDP_PROXY_PORT,
                    sourcemapPathTransformer,
                    projectType,
                    attachArgs
                );
                this.cordovaCdpProxy.setApplicationTargetPort(attachArgs.port || 9222);
                await this.cordovaCdpProxy.createServer(this.cdpProxyLogLevel, this.cancellationTokenSource.token);

                this.outputLogger(localize("AttachingToPlatform", "Attaching to {0}", attachArgs.platform));
                const attachOpts = await this.platform.prepareForAttach();
                this.outputLogger(localize("AttachingToApp", "Attaching to app"));
                this.outputLogger("", true); // Send blank message on stderr to include a divider between prelude and app starting
                const processedAttachArgs = Object.assign({}, attachArgs, attachOpts);
                if (processedAttachArgs.webSocketDebuggerUrl) {
                    this.cordovaCdpProxy.setBrowserInspectUri(processedAttachArgs.webSocketDebuggerUrl);
                }
                this.cordovaCdpProxy.configureCDPMessageHandlerAccordingToProcessedAttachArgs(processedAttachArgs);
                await this.establishDebugSession(processedAttachArgs);

                this.attachedDeferred.resolve();
                this.sendResponse(response);
                this.cordovaSession.setStatus(CordovaSessionStatus.Activated);
            });
        } catch (error) {
            this.outputLogger(error.message || error, true);
            await this.cleanUp();
            this.showError(error, response);
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {
        await this.cleanUp(args.restart);
        super.disconnectRequest(response, args, request);
    }

    private async resolveAndSaveMobileTarget(mobilePlatform: AbstractMobilePlatform, args: ICordovaLaunchRequestArgs | ICordovaAttachRequestArgs, isAttachRequest: boolean = false): Promise<void> {
        if (args.target && !mobilePlatform.getTargetFromRunArgs()) {
            const isAnyTarget =
                args.target.toLowerCase() === TargetType.Emulator ||
                args.target.toLowerCase() === TargetType.Device;
            const additionalFilter = isAttachRequest ? (el: IMobileTarget) => el.isOnline : undefined;
            const resultTarget = await mobilePlatform.resolveMobileTarget(args.target, additionalFilter);

            // Save the result to config in case there are more than one possible target with this type (simulator/device)
            if (resultTarget && isAnyTarget) {
                const targetsCount = await mobilePlatform.getTargetsCountByFilter(
                    target => target.isVirtualTarget === resultTarget.isVirtualTarget,
                );
                if (targetsCount > 1) {
                    const launchScenariosManager = new LaunchScenariosManager(args.cwd);
                    launchScenariosManager.updateLaunchScenario(args, {
                        target:
                            args.platform === PlatformType.Android
                                ? resultTarget.name
                                : resultTarget.id,
                    });
                }
            }
        }
    }

    private showError(error: Error, response: DebugProtocol.Response): void {

        // We can't print error messages after the debugging session is stopped. This could break the extension work.
        if (error.name === CordovaDebugSession.CANCELLATION_ERROR_NAME) {
            return;
        }
        const errorString = error.message || error.name || "Error";
        this.sendErrorResponse(
            response,
            { format: errorString, id: 1 },
            undefined,
            undefined,
            ErrorDestination.User
        );
    }

    private async cleanUp(restart?: boolean): Promise<void> {
        if (this.platform) {
            await this.platform.stopAndCleanUp();
            this.platform = null;
        }

        if (this.cordovaCdpProxy) {
            await this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }

        this.cancellationTokenSource.cancel();
        this.cancellationTokenSource.dispose();

        this.onDidTerminateDebugSessionHandler.dispose();
        this.sessionManager.terminate(this.cordovaSession.getSessionId(), !!restart);

        await logger.dispose();
    }

    private async establishDebugSession(
        attachArgs: ICordovaAttachRequestArgs
    ): Promise<void> {
        if (this.cordovaCdpProxy) {
            const attachArguments = this.pwaSessionName === PwaDebugType.Chrome ?
                this.jsDebugConfigAdapter.createChromeDebuggingConfig(
                    attachArgs,
                    CordovaDebugSession.CDP_PROXY_PORT,
                    this.pwaSessionName,
                    this.cordovaSession.getSessionId()
                ) :
                this.jsDebugConfigAdapter.createSafariDebuggingConfig(
                    attachArgs,
                    CordovaDebugSession.CDP_PROXY_PORT,
                    this.pwaSessionName,
                    this.cordovaSession.getSessionId()
                );

            const childDebugSessionStarted = await vscode.debug.startDebugging(
                this.workspaceManager.workspaceRoot,
                attachArguments,
                {
                    parentSession: this.vsCodeDebugSession,
                    consoleMode: vscode.DebugConsoleMode.MergeWithParent,
                }
            );
            if (!childDebugSessionStarted) {
                throw new Error(localize("CannotStartChildDebugSession", "Cannot start child debug session"));
            }
        } else {
            throw new Error(localize("CannotConnectToDebuggerWorkerProxyOffline", "Cannot connect to debugger worker: Chrome debugger proxy is offline"));
        }
    }

    private handleTerminateDebugSession(debugSession: vscode.DebugSession) {
        if (
            debugSession.configuration.cordovaDebugSessionId === this.cordovaSession.getVSCodeDebugSession().id
            && debugSession.type === this.pwaSessionName
        ) {
            vscode.commands.executeCommand(CordovaDebugSession.STOP_COMMAND, undefined, { sessionId: this.vsCodeDebugSession.id });
        }
    }

    private async resolvePlatform(args: ICordovaAttachRequestArgs | ICordovaLaunchRequestArgs): Promise<AbstractPlatform> {
        const [projectType, runArgs, cordovaExecutable] = await Promise.all([
            TelemetryHelper.determineProjectTypes(args.cwd),
            this.workspaceManager.getRunArguments(args.cwd),
            this.workspaceManager.getCordovaExecutable(args.cwd),
        ]);
        const ionicDevServer = new IonicDevServer(args.cwd, this.stop, this.outputLogger, args.devServerAddress, args.devServerPort, (args as any).devServerTimeout, cordovaExecutable);
        const env = CordovaProjectHelper.getEnvArgument(args.env, args.envFile);
        const runArguments = (args as any).runArguments || runArgs;
        const userDataDir = (args as any).userDataDir || path.join(settingsHome(), BrowserPlatform.CHROME_DATA_DIR);
        const iosDebugProxyPort = (args as any).iosDebugProxyPort || 9221;
        const webkitRangeMin = args.webkitRangeMin || 9223;
        const webkitRangeMax = args.webkitRangeMax || 9322;
        const attachAttempts = args.attachAttempts || 20;
        const attachDelay = args.attachDelay || 1000;
        const port = args.port || 9222;
        const platformOptions: IBrowserPlatformOptions & IIosPlatformOptions & IAndroidPlatformOptions = Object.assign({
            ionicDevServer,
            projectType,
            runArguments,
            cordovaExecutable,
            projectRoot: args.cwd,
            workspaceManager: this.workspaceManager,
            cancellationTokenSource: this.cancellationTokenSource,
            port,
            userDataDir,
            iosDebugProxyPort,
            webkitRangeMin,
            webkitRangeMax,
            attachAttempts,
            attachDelay,
            protocolServerStop: this.stop,
            changeSimulateViewport: this.changeSimulateViewport,
        }, args, {
            env,
        });

        if (SimulateHelper.isSimulateTarget(args.target)) {
            return new BrowserPlatform(platformOptions, this.outputLogger);
        } else {
            switch (args.platform) {
                case PlatformType.Android:
                    return new AndroidPlatform(platformOptions, this.outputLogger);
                case PlatformType.IOS:
                    return new IosPlatform(platformOptions, this.outputLogger);
                case PlatformType.Serve:
                // https://github.com/apache/cordova-serve/blob/4ad258947c0e347ad5c0f20d3b48e3125eb24111/src/util.js#L27-L37
                case PlatformType.Windows:
                case PlatformType.AmazonFireos:
                case PlatformType.Blackberry10:
                case PlatformType.Firefoxos:
                case PlatformType.Ubuntu:
                case PlatformType.Wp8:
                case PlatformType.Browser:
                    return new BrowserPlatform(platformOptions, this.outputLogger);
                default:
                    throw new Error(localize("UnknownPlatform", "Unknown Platform: {0}", args.platform));
            }
        }
    }

    private changeSimulateViewport(data: simulate.ResizeViewportData): Promise<void> {
        return this.attachedDeferred.promise
            .then(() => {
                if (this.cordovaCdpProxy) {
                    this.cordovaCdpProxy.getSimPageTargetAPI()?.Emulation.setDeviceMetricsOverride({
                        width: data.width,
                        height: data.height,
                        deviceScaleFactor: 0,
                        mobile: true,
                    });
                }
            });
    }

    private async initializeTelemetry(projectRoot: string): Promise<void> {
        if (!this.istelemetryInitialized) {
            let version = JSON.parse(fs.readFileSync(findFileInFolderHierarchy(__dirname, "package.json"), "utf-8")).version;
            // Enable telemetry, forced on for now.
            try {
                return Telemetry.init("cordova-tools-debug-adapter", version, { isExtensionProcess: false, projectRoot: projectRoot });
            } catch (e) {
                this.outputLogger(localize("CouldNotInitializeTelemetry", "Could not initialize telemetry. {0}", e.message || e.error || e.data || e));
            }
            this.istelemetryInitialized = true;
        }
    }

    private async initializeSettings(args: ICordovaAttachRequestArgs | ICordovaLaunchRequestArgs): Promise<void> {
        if (!this.isSettingsInitialized) {
            this.workspaceManager = CordovaWorkspaceManager.getWorkspaceManagerByProjectRootPath(args.cwd);
            logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Log);
            this.cdpProxyLogLevel = args.trace ? LogLevel.Custom : LogLevel.None;

            if (args.runtimeVersion) {
                NodeVersionHelper.nvmSupport(args);
            }

            if (!args.target) {
                if (args.platform === PlatformType.Browser) {
                    args.target = "chrome";
                } else {
                    args.target = TargetType.Emulator;
                }
                this.outputLogger(`Parameter target is not set - ${args.target} will be used`);
            }

            this.isSettingsInitialized = true;
        }
    }

    private static getTargetType(target: string): string {
        if (/emulator/i.test(target)) {
            return TargetType.Emulator;
        }

        if (/chrom/i.test(target)) {
            return TargetType.Chrome;
        }

        return TargetType.Device;
    }
}
