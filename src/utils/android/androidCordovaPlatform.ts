import { GeneralCordovaPlatform } from "../generalCordovaPlatform";
import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "../../debugger/requestArgs";
import { SimulateHelper } from "../simulateHelper";
import { execCommand, cordovaRunCommand, killChildProcess, cordovaStartCommand } from "../../debugger/extension";
import { IProjectType, CordovaProjectHelper } from "../cordovaProjectHelper";
import { TargetType } from "../../debugger/cordovaDebugSession";
import { AdbHelper } from "./adb";
import { AndroidTargetManager, AndroidTarget } from "../android/androidTargetManager";
import { LaunchScenariosManager } from "../launchScenariosManager";
import { TelemetryGenerator } from "../telemetryHelper";
import * as nls from "vscode-nls";
import { IonicDevServer } from "../ionicDevServer";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export class AndroidCordovaPlatform extends GeneralCordovaPlatform {
    private adbHelper: AdbHelper;

    // constructor() {}

    public async launchApp(
        launchArgs: ICordovaLaunchRequestArgs,
        projectType: IProjectType,
        runArguments: string[],
        generator?: TelemetryGenerator
    ): Promise<void> {
        let workingDirectory = launchArgs.cwd;

        // Prepare the command line args
        let args = ["run", "android"];

        if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
            args.push(...launchArgs.runArguments);
        } else if (runArguments && runArguments.length) {
            args.push(...runArguments);
        } else {
            const targetArgs = await this.getCommandLineArgsForAndroidTarget(launchArgs);
            args.push(...targetArgs);

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
        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        let cordovaResult = cordovaRunCommand(
                command,
                args,
                launchArgs.allEnv,
                workingDirectory,
                this.outputLogger,
            ).then((output) => {
                let runOutput = output[0];
                let stderr = output[1];

                // Ionic ends process with zero code, so we need to look for
                // strings with error content to detect failed process
                let errorMatch = /(ERROR.*)/.test(runOutput) || /error:.*/i.test(stderr);
                if (errorMatch) {
                    throw new Error(localize("ErrorRunningAndroid", "Error running android"));
                }

                this.outputLogger(localize("AppSuccessfullyLaunched", "App successfully launched"));
            });

        return cordovaResult;
    }

    public async prepareForAttach(attachArgs: ICordovaAttachRequestArgs): Promise<void> {
        let errorLogger = (message: string) => this.outputLogger(message, true);

        // Determine which device/emulator we are targeting
        let resolveTagetPromise = new Promise<string>(async (resolve, reject) => {
            try {
                const devicesOutput = await this.runAdbCommand(["devices"], errorLogger);
                try {
                    const result = await this.resolveAndroidTarget(attachArgs, true);
                    if (!result) {
                        errorLogger(devicesOutput);
                        reject(new Error(`Unable to find target ${attachArgs.target}`));
                    }
                    resolve(result.id);
                } catch (error) {
                    reject(error);
                }
            } catch (error) {
                let errorCode: string = (<any>error).code;
                if (errorCode && errorCode === "ENOENT") {
                    throw new Error(localize("UnableToFindAdb", "Unable to find adb. Please ensure it is in your PATH and re-open Visual Studio Code"));
                }
                throw error;
            }
        });

        let packagePromise: Promise<string> = fs.promises.readFile(path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH))
            .catch((err) => {
                if (err && err.code === "ENOENT") {
                    return fs.promises.readFile(path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH_8));
                }
                throw err;
            })
            .then((manifestContents) => {
                let parsedFile = elementtree.XML(manifestContents.toString());
                let packageKey = "package";
                return parsedFile.attrib[packageKey];
            });

        return Promise.all([packagePromise, resolveTagetPromise])
            .then(([appPackageName, targetDevice]) => {
                let pidofCommandArguments = ["-s", targetDevice, "shell", "pidof", appPackageName];
                let getPidCommandArguments = ["-s", targetDevice, "shell", "ps"];
                let getSocketsCommandArguments = ["-s", targetDevice, "shell", "cat /proc/net/unix"];

                let findAbstractNameFunction = () =>
                    // Get the pid from app package name
                    this.runAdbCommand(pidofCommandArguments, errorLogger)
                        .then((pid) => {
                            if (pid && /^[0-9]+$/.test(pid.trim())) {
                                return pid.trim();
                            }

                            throw Error(CordovaDebugSession.pidofNotFoundError);

                        }).catch((err) => {
                            if (err.message !== CordovaDebugSession.pidofNotFoundError) {
                                return;
                            }

                            return this.runAdbCommand(getPidCommandArguments, errorLogger)
                                .then((psResult) => {
                                    const lines = psResult.split("\n");
                                    const keys = lines.shift().split(PS_FIELDS_SPLITTER_RE);
                                    const nameIdx = keys.indexOf("NAME");
                                    const pidIdx = keys.indexOf("PID");
                                    for (const line of lines) {
                                        const fields = line.trim().split(PS_FIELDS_SPLITTER_RE).filter(field => !!field);
                                        if (fields.length < nameIdx) {
                                            continue;
                                        }
                                        if (fields[nameIdx] === appPackageName) {
                                            return fields[pidIdx];
                                        }
                                    }
                                });
                        })
                        // Get the "_devtools_remote" abstract name by filtering /proc/net/unix with process inodes
                        .then(pid =>
                            this.runAdbCommand(getSocketsCommandArguments, errorLogger)
                                .then((getSocketsResult) => {
                                    const lines = getSocketsResult.split("\n");
                                    const keys = lines.shift().split(/[\s\r]+/);
                                    const flagsIdx = keys.indexOf("Flags");
                                    const stIdx = keys.indexOf("St");
                                    const pathIdx = keys.indexOf("Path");
                                    for (const line of lines) {
                                        const fields = line.split(/[\s\r]+/);
                                        if (fields.length < 8) {
                                            continue;
                                        }
                                        // flag = 00010000 (16) -> accepting connection
                                        // state = 01 (1) -> unconnected
                                        if (fields[flagsIdx] !== "00010000" || fields[stIdx] !== "01") {
                                            continue;
                                        }
                                        const pathField = fields[pathIdx];
                                        if (pathField.length < 1 || pathField[0] !== "@") {
                                            continue;
                                        }
                                        if (pathField.indexOf("_devtools_remote") === -1) {
                                            continue;
                                        }

                                        if (pathField === `@webview_devtools_remote_${pid}`) {
                                            // Matches the plain cordova webview format
                                            return pathField.substr(1);
                                        }

                                        if (pathField === `@${appPackageName}_devtools_remote`) {
                                            // Matches the crosswalk format of "@PACKAGENAME_devtools_remote
                                            return pathField.substr(1);
                                        }
                                        // No match, keep searching
                                    }
                                })
                        );

                return retryAsync(
                    findAbstractNameFunction,
                    (match) => !!match,
                    5,
                    1,
                    5000,
                    localize("UnableToFindLocalAbstractName", "Unable to find 'localabstract' name of Cordova app"),
                    this.cancellationTokenSource.token
                )
                    .then((abstractName) => {
                        // Configure port forwarding to the app
                        let forwardSocketCommandArguments = ["-s", targetDevice, "forward", `tcp:${attachArgs.port}`, `localabstract:${abstractName}`];
                        this.outputLogger(localize("ForwardingDebugPort", "Forwarding debug port"));
                        return this.runAdbCommand(forwardSocketCommandArguments, errorLogger).then(() => {
                            this.adbPortForwardingInfo = { targetDevice, port: attachArgs.port };
                        });
                    });
            }).then(() => {
                return attachArgs;
            });
    }

    private async getCommandLineArgsForAndroidTarget(launchArgs: ICordovaLaunchRequestArgs): Promise<string[]> {
        let targetArgs: string[] = ["--verbose"];

        const useDefaultCLI = async () => {
            this.outputLogger("Continue using standard CLI workflow.");
            targetArgs = ["--verbose"];
            const adbHelper = new AdbHelper(launchArgs.cwd);
            const debuggableDevices = await adbHelper.getOnlineTargets();
            // By default, if the target is not specified, Cordova CLI uses the first online target from ‘adb devices’ list (launched emulators are placed after devices).
            // For more information, see https://github.com/apache/cordova-android/blob/bb7d733cdefaa9ed36ec355a42f8224da610a26e/bin/templates/cordova/lib/run.js#L57-L68
            launchArgs.target = debuggableDevices.length ? debuggableDevices[0].id : TargetType.Emulator;
        };

        try {
            const target = await this.resolveAndroidTarget(launchArgs, false);
            if (target) {
                targetArgs.push(target.isVirtualTarget ? "--emulator" : "--device");
                targetArgs.push(`--target=${target.id}`);
            } else {
                this.outputLogger(`Could not find debugable target '${launchArgs.target}'.`, true);
                await useDefaultCLI();
            }
        } catch (error) {
            this.outputLogger(error.message || error, true);
            await useDefaultCLI();
        }

        return targetArgs;
    }

    private async resolveAndroidTarget(configArgs: ICordovaLaunchRequestArgs | ICordovaAttachRequestArgs, isAttachScenario: boolean): Promise<AndroidTarget | undefined> {
        const adbHelper = new AdbHelper(configArgs.cwd);

        const getFirstOnlineAndroidTarget = async (): Promise<AndroidTarget | undefined> => {
            const onlineTargets = await adbHelper.getOnlineTargets();
            if (onlineTargets.length) {
                const firstDevice = onlineTargets[0];
                configArgs.target = firstDevice.id;
                return AndroidTarget.fromInterface(firstDevice);
            }
        };

        if (configArgs.target) {
            const androidEmulatorManager = new AndroidTargetManager(adbHelper);
            const isAnyEmulator = configArgs.target.toLowerCase() === TargetType.Emulator;
            const isAnyDevice = configArgs.target.toLowerCase() === TargetType.Device;
            const isVirtualTarget = await androidEmulatorManager.isVirtualTarget(configArgs.target);

            const saveResult = async (target: AndroidTarget): Promise<void> => {
            const launchScenariousManager = new LaunchScenariosManager(configArgs.cwd);
                if (isAttachScenario) {
                    // Save the selected target for attach scenario only if there are more then one online target
                    const onlineDevices = await adbHelper.getOnlineTargets();
                    if (onlineDevices.filter(device => target.isVirtualTarget === device.isVirtualTarget).length > 1) {
                        launchScenariousManager.updateLaunchScenario(configArgs, {target: target.name});
                    }
                } else {
                    launchScenariousManager.updateLaunchScenario(configArgs, {target: target.name});
                }
            };

            await androidEmulatorManager.collectTargets();
            let targetDevice = await androidEmulatorManager.selectAndPrepareTarget(target => {
                const conditionForAttachScenario = isAttachScenario ? target.isOnline : true;
                const conditionForNotAnyTarget = isAnyEmulator || isAnyDevice ? true : target.name === configArgs.target || target.id === configArgs.target;
                const conditionForVirtualTarget = isVirtualTarget === target.isVirtualTarget;
                return conditionForVirtualTarget && conditionForNotAnyTarget && conditionForAttachScenario;
            });
            if (targetDevice) {
                if (isAnyEmulator || isAnyDevice) {
                    await saveResult(targetDevice);
                }
                configArgs.target = targetDevice.id;
            } else if (isAttachScenario && (isAnyEmulator || isAnyDevice)) {
                this.outputLogger("Target has not been selected. Trying to use the first online Android device");
                targetDevice = await getFirstOnlineAndroidTarget();
            }

            return targetDevice;
        } else {
            // If there is no a target in debug config, use the first online device
            const targetDevice = await getFirstOnlineAndroidTarget();
            if (!targetDevice) {
                throw new Error(localize("ThereIsNoAnyOnlineDebuggableDevice", "The 'target' parameter in the debug configuration is undefined, and there are no any online debuggable targets"));
            }
            return targetDevice;
        }
    }
}
