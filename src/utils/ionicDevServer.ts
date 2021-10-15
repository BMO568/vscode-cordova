import * as child_process from "child_process";
import * as os from "os";
import { ICordovaLaunchRequestArgs } from "../debugger/requestArgs";
import { DebugConsoleLogger } from "../debugger/cordovaDebugSession";
import { CordovaProjectHelper } from "./cordovaProjectHelper";
import { cordovaStartCommand } from "../debugger/extension";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export class IonicDevServer {
    private ionicLivereloadProcess: child_process.ChildProcess;
    private ionicDevServerUrls: string[];
    private outputLogger: DebugConsoleLogger;

    constructor(outputLogger: DebugConsoleLogger) {
        this.outputLogger = outputLogger;
    }

    /**
     * Starts an Ionic livereload server ("serve" or "run / emulate --livereload"). Returns a promise fulfilled with the full URL to the server.
     */
     public startIonicDevServer(launchArgs: ICordovaLaunchRequestArgs, cliArgs: string[]): Promise<string[]> {
        enum IonicDevServerStatus {
            ServerReady,
            AppReady,
        }

        if (!launchArgs.runArguments || launchArgs.runArguments.length === 0) {
            if (launchArgs.devServerAddress) {
                cliArgs.push("--address", launchArgs.devServerAddress);
            }

            if (launchArgs.hasOwnProperty("devServerPort")) {
                if (typeof launchArgs.devServerPort === "number" && launchArgs.devServerPort >= 0 && launchArgs.devServerPort <= 65535) {
                    cliArgs.push("--port", launchArgs.devServerPort.toString());
                } else {
                    return Promise.reject(new Error(localize("TheValueForDevServerPortMustBeInInterval", "The value for \"devServerPort\" must be a number between 0 and 65535")));
                }
            }
        }

        let isServe: boolean = cliArgs[0] === "serve";
        let errorRegex: RegExp = /error:.*/i;
        let ionicLivereloadProcessStatus = {
            serverReady: false,
            appReady: false,
        };
        let serverReadyTimeout: number = launchArgs.devServerTimeout || 60000;
        let appReadyTimeout: number = launchArgs.devServerTimeout || 120000; // If we're not serving, the app needs to build and deploy (and potentially start the emulator), which can be very long
        let serverOut: string = "";
        let serverErr: string = "";
        const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
        const isIonic4: boolean = CordovaProjectHelper.isIonicCliVersionGte(launchArgs.cwd, "4.0.0");
        let getServerErrorMessage = (channel: string) => {

            // Skip Ionic 4 searching port errors because, actually, they are not errors
            // https://github.com/ionic-team/ionic-cli/blob/4ee312ad983922ff4398b5900dcfcaebb6ef57df/packages/%40ionic/utils-network/src/index.ts#L85
            if (isIonic4) {
                const skipErrorMatch = /utils-network error while checking/.test(channel);
                if (skipErrorMatch) {
                    return null;
                }
            }

            let errorMatch = errorRegex.exec(channel);

            if (errorMatch) {
                return localize("ErrorInTheIonicLiveReloadServer", "Error in the Ionic live reload server: {0}", os.EOL + errorMatch[0]);
            }

            return null;
        };

        let getRegexToResolveAppDefer = (cliArgs: string[]): RegExp => {
            // Now that the server is ready, listen for the app to be ready as well. For "serve", this is always true, because no build and deploy is involved. For android, we need to
            // wait until we encounter the "launch success", for iOS device, the server output is different and instead we need to look for:
            //
            // ios devices:
            // (lldb)     run
            // success
            //
            // ios simulators:
            // "build succeeded"

            let isIosDevice: boolean = cliArgs.indexOf("ios") !== -1 && cliArgs.indexOf("--device") !== -1;
            let isIosSimulator: boolean = cliArgs.indexOf("ios") !== -1 && cliArgs.indexOf("emulate") !== -1;
            let iosDeviceAppReadyRegex: RegExp = /created bundle at path|\(lldb\)\W+run\r?\nsuccess/i;
            let iosSimulatorAppReadyRegex: RegExp = /build succeeded/i;
            let appReadyRegex: RegExp = /launch success|run successful/i;

            if (isIosDevice) {
                return iosDeviceAppReadyRegex;
            }

            if (isIosSimulator) {
                return iosSimulatorAppReadyRegex;
            }

            return appReadyRegex;
        };

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(launchArgs.cwd);

        this.ionicLivereloadProcess = cordovaStartCommand(command, cliArgs, launchArgs.allEnv, launchArgs.cwd);

        const serverStarting = new Promise((_resolve, reject) => {
            let rejectTimeout = setTimeout(() => {
                reject(localize("StartingIonicDevServerTimedOut", "Starting the Ionic dev server timed out ({0} ms)", serverReadyTimeout));
            }, serverReadyTimeout);

            let resolveIfPossible = (ready: IonicDevServerStatus, serverUrls?: string[]) => {
                if (ready === IonicDevServerStatus.ServerReady && !ionicLivereloadProcessStatus.serverReady) {
                    clearTimeout(rejectTimeout);
                    ionicLivereloadProcessStatus.serverReady = true;
                    this.outputLogger("Building and deploying app");
                    rejectTimeout = setTimeout(() => {
                        reject(localize("BuildingAndDeployingTheAppTimedOut", "Building and deploying the app timed out ({0} ms)", appReadyTimeout));
                    }, appReadyTimeout);
                } else if (ready === IonicDevServerStatus.AppReady && ionicLivereloadProcessStatus.serverReady) {
                    clearTimeout(rejectTimeout);
                    ionicLivereloadProcessStatus.appReady = true;
                    _resolve(serverUrls);
                }
            };

            this.ionicLivereloadProcess.on("error", (err: { code: string }) => {
                if (err.code === "ENOENT") {
                    reject(new Error(localize("IonicNotFound", "Ionic not found, please run 'npm install –g ionic' to install it globally")));
                } else {
                    reject(err);
                }
            });
            this.ionicLivereloadProcess.on("exit", (() => {
                this.ionicLivereloadProcess = null;

                let exitMessage: string = "The Ionic live reload server exited unexpectedly";
                let errorMsg = getServerErrorMessage(serverErr);

                if (errorMsg) {
                    // The Ionic live reload server has an error; check if it is related to the devServerAddress to give a better message
                    if (errorMsg.indexOf("getaddrinfo ENOTFOUND") !== -1 || errorMsg.indexOf("listen EADDRNOTAVAIL") !== -1) {
                        exitMessage += os.EOL + localize("InvalidAddress", "Invalid address: please provide a valid IP address or hostname for the \"devServerAddress\" property in launch.json");
                    } else {
                        exitMessage += os.EOL + errorMsg;
                    }
                }

                if (!ionicLivereloadProcessStatus.serverReady && !ionicLivereloadProcessStatus.appReady) {
                    // We are already debugging; disconnect the session
                    this.outputLogger(exitMessage, true);
                    // this.stop(); // TODO emit event
                    // throw new Error(exitMessage);
                    reject(new Error(exitMessage));
                } else {
                    // The Ionic dev server wasn't ready yet, so reject its promises
                    reject(new Error(exitMessage));
                }
            }).bind(this));

            let serverOutputHandler = (data: Buffer) => {
                serverOut += data.toString();
                this.outputLogger(data.toString(), "stdout");

                // Listen for the server to be ready. We check for the "Running dev server:  http://localhost:<port>/" and "dev server running: http://localhost:<port>/" strings to decide that.

                // Example output of Ionic 1 dev server:
                //
                // [OK] Development server running!
                //      Local: http://localhost:8100
                //      External: http://10.0.75.1:8100, http://172.28.124.161:8100, http://169.254.80.80:8100, http://192.169.8.39:8100

                // Example output of Ionic 2 dev server:
                //
                // Running live reload server: undefined
                // Watching: 0=www/**/*, 1=!www/lib/**/*
                // Running dev server:  http://localhost:8100
                // Ionic server commands, enter:
                // restart or r to restart the client app from the root
                // goto or g and a url to have the app navigate to the given url
                // consolelogs or c to enable/disable console log output
                // serverlogs or s to enable/disable server log output
                // quit or q to shutdown the server and exit
                //
                // ionic $

                // Example output of Ionic dev server (for Ionic2):
                //
                // > ionic-hello-world@ ionic:serve <path>
                // > ionic-app-scripts serve "--v2" "--address" "0.0.0.0" "--port" "8100" "--livereload-port" "35729"
                // ionic-app-scripts
                // watch started
                // build dev started
                // clean started
                // clean finished
                // copy started
                // transpile started
                // transpile finished
                // webpack started
                // copy finished
                // webpack finished
                // sass started
                // sass finished
                // build dev finished
                // watch ready
                // dev server running: http://localhost:8100/

                const SERVER_URL_RE = /(dev server running|Running dev server|Local):.*(http:\/\/.[^\s]*)/gmi;
                let localServerMatchResult = SERVER_URL_RE.exec(serverOut);
                if (!ionicLivereloadProcessStatus.serverReady && localServerMatchResult) {
                    resolveIfPossible(IonicDevServerStatus.ServerReady);
                }

                if (ionicLivereloadProcessStatus.serverReady && !ionicLivereloadProcessStatus.appReady) {
                    let regex: RegExp = getRegexToResolveAppDefer(cliArgs);

                    if (isServe || regex.test(serverOut)) {
                        const serverUrls = [localServerMatchResult[2]];
                        const externalUrls = /External:\s(.*)$/im.exec(serverOut);
                        if (externalUrls) {
                            const urls = externalUrls[1].split(", ").map(x => x.trim());
                            serverUrls.push(...urls);
                        }
                        launchArgs.devServerPort = CordovaProjectHelper.getPortFromURL(serverUrls[0]);
                        resolveIfPossible(IonicDevServerStatus.AppReady, serverUrls);
                    }
                }

                if (/Multiple network interfaces detected/.test(serverOut)) {
                    // Ionic does not know which address to use for the dev server, and requires human interaction; error out and let the user know
                    let errorMessage: string = localize("YourMachineHasMultipleNetworkAddresses",
                        `Your machine has multiple network addresses. Please specify which one your device or emulator will use to communicate with the dev server by adding a \"devServerAddress\": \"ADDRESS\" property to .vscode/launch.json.
    To get the list of addresses run "ionic cordova run PLATFORM --livereload" (where PLATFORM is platform name to run) and wait until prompt with this list is appeared.`);
                    let addresses: string[] = [];
                    let addressRegex = /(\d+\) .*)/gm;
                    let match: string[] = addressRegex.exec(serverOut);

                    while (match) {
                        addresses.push(match[1]);
                        match = addressRegex.exec(serverOut);
                    }

                    if (addresses.length > 0) {
                        // Give the user the list of addresses that Ionic found
                        // NOTE: since ionic started to use inquirer.js for showing _interactive_ prompts this trick does not work as no output
                        // of prompt are sent from ionic process which we starts with --no-interactive parameter
                        errorMessage += [localize("AvailableAdresses", " Available addresses:")].concat(addresses).join(os.EOL + " ");
                    }

                    reject(new Error(errorMessage));
                }

                let errorMsg = getServerErrorMessage(serverOut);

                if (errorMsg) {
                    reject(new Error(errorMsg));
                }
            };

            let serverErrorOutputHandler = (data: Buffer) => {
                serverErr += data.toString();

                let errorMsg = getServerErrorMessage(serverErr);

                if (errorMsg) {
                    reject(new Error(errorMsg));
                }
            };

            this.ionicLivereloadProcess.stdout.on("data", serverOutputHandler);
            this.ionicLivereloadProcess.stderr.on("data", (data: Buffer) => {
                if (isIonic4) {
                    // Ionic 4 writes all logs to stderr completely ignoring stdout
                    serverOutputHandler(data);
                }
                serverErrorOutputHandler(data);
            });

            this.outputLogger(localize("StartingIonicDevServer", "Starting Ionic dev server (live reload: {0})", launchArgs.ionicLiveReload));
        });

        return serverStarting.then((ionicDevServerUrls: string[]) => {

            if (!ionicDevServerUrls || !ionicDevServerUrls.length) {
                throw new Error(localize("UnableToDetermineTheIonicDevServerAddress", "Unable to determine the Ionic dev server address, please try re-launching the debugger"));
            }

            // The dev server address is the captured group at index 1 of the match
            this.ionicDevServerUrls = ionicDevServerUrls;

            // When ionic 2 cli is installed, output includes ansi characters for color coded output.
            this.ionicDevServerUrls = this.ionicDevServerUrls.map(url => url.replace(ansiRegex, ""));
            return this.ionicDevServerUrls;
        });
    }
}
