import { GeneralCordovaPlatform } from "./generalCordovaPlatform";
import { SimulateHelper } from "./simulateHelper";
import { AndroidCordovaPlatform } from "./android/androidCordovaPlatform";
import { IOSCordovaPlatform } from "./ios/iOSCordovaPlatform";
import { BrowserCordovaPlatform } from "./browser/browserCordovaPlatform";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

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

export class CordovaPlatformResolver {
    public resolveCordovaPlatform(
        platformString: string,
        targetString: string,
        platformDeps: any
    ): GeneralCordovaPlatform {
        switch (platformString) {
            case PlatformType.Android:
                if (SimulateHelper.isSimulateTarget(targetString)) {
                    return new BrowserCordovaPlatform(platformDeps);
                } else {
                    return new AndroidCordovaPlatform(platformDeps);
                }
            case PlatformType.IOS:
                if (SimulateHelper.isSimulateTarget(targetString)) {
                    return new BrowserCordovaPlatform(platformDeps);
                } else {
                    return new IOSCordovaPlatform(platformDeps);
                }
            case PlatformType.Windows:
                if (SimulateHelper.isSimulateTarget(targetString)) {
                    return new BrowserCordovaPlatform(platformDeps);
                } else {
                    throw new Error(`Debugging ${platformString} platform is not supported.`);
                }
            case PlatformType.Serve:
                return new BrowserCordovaPlatform(platformDeps);
            // https://github.com/apache/cordova-serve/blob/4ad258947c0e347ad5c0f20d3b48e3125eb24111/src/util.js#L27-L37
            case PlatformType.AmazonFireos:
            case PlatformType.Blackberry10:
            case PlatformType.Firefoxos:
            case PlatformType.Ubuntu:
            case PlatformType.Wp8:
            case PlatformType.Browser:
                return new BrowserCordovaPlatform(platformDeps);
            default:
                throw new Error(localize("UnknownPlatform", "Unknown Platform: {0}", platformString));
        }
    }
}
