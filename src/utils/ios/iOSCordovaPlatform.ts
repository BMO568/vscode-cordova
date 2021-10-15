import * as os from "os";
import { GeneralCordovaPlatform } from "../generalCordovaPlatform";
import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "../../debugger/requestArgs";
import { IProjectType, CordovaProjectHelper } from "../cordovaProjectHelper";
import { TargetType } from "../../debugger/cordovaDebugSession";
import { execCommand, cordovaRunCommand, killChildProcess, cordovaStartCommand } from "../../debugger/extension";
import { CordovaIosDeviceLauncher } from "../../debugger/cordovaIosDeviceLauncher";
import { TelemetryGenerator } from "../telemetryHelper";
import { IonicDevServer } from "../ionicDevServer";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export class IOSCordovaPlatform extends GeneralCordovaPlatform {

    public async launchApp(
        launchArgs: ICordovaLaunchRequestArgs,
        projectType: IProjectType,
        runArguments: string[],
        generator?: TelemetryGenerator
    ): Promise<void> {
        if (os.platform() !== "darwin") {
            return Promise.reject<void>(localize("UnableToLaunchiOSOnNonMacMachnines", "Unable to launch iOS on non-mac machines"));
        }
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        this.outputLogger(localize("LaunchingApp", "Launching app (This may take a while)..."));

        let iosDebugProxyPort = launchArgs.iosDebugProxyPort || 9221;

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        // Launch the app
        if (launchArgs.target.toLowerCase() === TargetType.Device) {
            let args = ["run", "ios", "--device"];

            if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                const launchRunArgs = this.addBuildFlagToArgs(launchArgs.runArguments);
                args.push(...launchRunArgs);
            } else if (runArguments && runArguments.length) {
                const runArgs = this.addBuildFlagToArgs(runArguments);
                args.push(...runArgs);
            } else {
                const buildArg = this.addBuildFlagToArgs();
                args.push(...buildArg);

                if (launchArgs.ionicLiveReload) { // Verify if we are using Ionic livereload
                    if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
                        // Livereload is enabled, let Ionic do the launch
                        // '--external' parameter is required since for iOS devices, port forwarding is not yet an option (https://github.com/ionic-team/native-run/issues/20)
                        args.push("--livereload", "--external");
                    } else {
                        this.outputLogger(this.NO_LIVERELOAD_WARNING);
                    }
                }
            }

            if (args.indexOf("--livereload") > -1) {
                if (!this.ionicDevServer) {
                    this.ionicDevServer = new IonicDevServer(this.outputLogger);
                }
                return this.ionicDevServer.startIonicDevServer(launchArgs, args).then(() => void 0);
            }

            // cordova run ios does not terminate, so we do not know when to try and attach.
            // Therefore we parse the command's output to find the special key, which means that the application has been successfully launched.
            this.outputLogger(localize("InstallingAndLaunchingAppOnDevice", "Installing and launching app on device"));
            return cordovaRunCommand(command, args, launchArgs.allEnv, workingDirectory, this.outputLogger)
                .then(() => {
                    return CordovaIosDeviceLauncher.startDebugProxy(iosDebugProxyPort);
                })
                .then(() => void (0));
        } else {
            let target = launchArgs.target.toLowerCase() === TargetType.Emulator ? TargetType.Emulator : launchArgs.target;
            return this.checkIfTargetIsiOSSimulator(target, command, launchArgs.allEnv, workingDirectory).then(() => {
                let args = ["emulate", "ios"];
                if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
                    args.push("--");
                }

                if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                    const launchRunArgs = this.addBuildFlagToArgs(launchArgs.runArguments);
                    args.push(...launchRunArgs);
                } else if (runArguments && runArguments.length) {
                    const runArgs = this.addBuildFlagToArgs(runArguments);
                    args.push(...runArgs);
                } else {
                    const buildArg = this.addBuildFlagToArgs();
                    args.push(...buildArg);

                    if (target === TargetType.Emulator) {
                        args.push("--target=" + target);
                    }
                    // Verify if we are using Ionic livereload
                    if (launchArgs.ionicLiveReload) {
                        if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
                            // Livereload is enabled, let Ionic do the launch
                            args.push("--livereload");
                        } else {
                            this.outputLogger(this.NO_LIVERELOAD_WARNING);
                        }
                    }
                }

                if (args.indexOf("--livereload") > -1) {
                    if (!this.ionicDevServer) {
                        this.ionicDevServer = new IonicDevServer(this.outputLogger);
                    }
                    return this.ionicDevServer.startIonicDevServer(launchArgs, args).then(() => void 0);
                }

                return cordovaRunCommand(command, args, launchArgs.allEnv, workingDirectory, this.outputLogger)
                    .catch((err) => {
                        if (target === TargetType.Emulator) {
                            return cordovaRunCommand(command, ["emulate", "ios", "--list"], launchArgs.allEnv, workingDirectory).then((output) => {
                                // List out available targets
                                errorLogger(localize("UnableToRunWithGivenTarget", "Unable to run with given target."));
                                errorLogger(output[0].replace(/\*+[^*]+\*+/g, "")); // Print out list of targets, without ** RUN SUCCEEDED **
                                throw err;
                            });
                        }

                        throw err;
                    });
            });
        }
    }

    private addBuildFlagToArgs(runArgs: Array<string> = []): Array<string> {
        const hasBuildFlag = runArgs.findIndex((arg) => arg.includes("--buildFlag")) > -1;

        if (!hasBuildFlag) {
            // Workaround for dealing with new build system in XCode 10
            // https://github.com/apache/cordova-ios/issues/407

            runArgs.unshift("--buildFlag=-UseModernBuildSystem=0");
        }

        return runArgs;
    }

    private checkIfTargetIsiOSSimulator(target: string, cordovaCommand: string, env: any, workingDirectory: string): Promise<void> {
        const simulatorTargetIsNotSupported = () => {
            const message = localize("InvalidTargetPleaseCheckTargetParameter", "Invalid target. Please, check target parameter value in your debug configuration and make sure it's a valid iPhone device identifier. Proceed to https://aka.ms/AA3xq86 for more information.");
            throw new Error(message);
        };
        if (target === TargetType.Emulator) {
            simulatorTargetIsNotSupported();
        }
        return cordovaRunCommand(cordovaCommand, ["emulate", "ios", "--list"], env, workingDirectory).then((output) => {
            // Get list of emulators as raw strings
            output[0] = output[0].replace(/Available iOS Simulators:/, "");

            // Clean up each string to get real value
            const emulators = output[0].split("\n").map((value) => {
                let match = value.match(/(.*)(?=,)/gm);
                if (!match) {
                    return null;
                }
                return match[0].replace(/\t/, "");
            });

            return (emulators.indexOf(target) >= 0);
        })
            .then((result) => {
                if (result) {
                    simulatorTargetIsNotSupported();
                }
            });
    }
}
