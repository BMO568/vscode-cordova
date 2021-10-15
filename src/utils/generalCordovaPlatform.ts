import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "../debugger/requestArgs";
import { CordovaWorkspaceManager } from "../extension/cordovaWorkspaceManager";
import { DebugConsoleLogger } from "../debugger/cordovaDebugSession";
import { IProjectType } from "./cordovaProjectHelper";
import { TelemetryGenerator } from "./telemetryHelper";
import { IonicDevServer } from "./ionicDevServer";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export class GeneralCordovaPlatform {
    protected readonly NO_LIVERELOAD_WARNING = localize("IonicLiveReloadIsOnlySupportedForIonic1", "Warning: Ionic live reload is currently only supported for Ionic 1 projects. Continuing deployment without Ionic live reload...");

    protected projectPath: string;
    protected workspaceManager: CordovaWorkspaceManager;
    protected outputLogger: DebugConsoleLogger;
    protected ionicDevServer: IonicDevServer | null;

    constructor(: ICordovaPlatformOptions, platformDeps: any) {
        this.projectPath = projectPath;
        this.workspaceManager = platformDeps.workspaceManager;
        this.outputLogger = platformDeps.outputLogger;
        this.ionicDevServer = null;
    }

    public async launchApp(
        launchArgs: ICordovaLaunchRequestArgs,
        projectType: IProjectType,
        runArguments: string[],
        generator?: TelemetryGenerator
    ): Promise<void> {

    }

    public async prepareForAttach(attachArgs: ICordovaAttachRequestArgs): Promise<void> {

    }

    public dispose(): void {
        if (this.ionicDevServer) {

        }
    }
}
