import { GeneralCordovaPlatform } from "../generalCordovaPlatform";
import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "../../debugger/requestArgs";
import { SimulateHelper } from "../simulateHelper";

export class BrowserCordovaPlatform extends GeneralCordovaPlatform {

    public async launchApp(launchArgs: ICordovaLaunchRequestArgs): Promise<void> {

    }

}
