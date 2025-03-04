import { CloudStorageManager } from "../managers/cloudStorageManager";
import common from "../common/common";
import sqlManager from "../managers/sqlManager";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import keccak from "../common/keccak";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import webhookEngine from "../engines/webhookEngine";
import _, { add, forEach } from "lodash";
import dotenv from "dotenv";
dotenv.config();

async function main() {
    const dbAddressesArr = await sqlManager.execQuery(
        "SELECT TOP 2 * FROM addresses"
    );
    const _addresses = _.map(dbAddressesArr, (a: any) => a.address);
    console.log(dbAddressesArr[0]);
    /*
    let addresses: string[] = [];

    for (let i = 30; i < _addresses.length; i++) {
        addresses.push(_addresses[i]);
    }

    //await healthFactorCheckEngine.initializeHealthFactorCheckLoop();
    const ure = await healthFactorCheckEngine.fetchUsersReserves(addresses);
    const ur = ure.userReserves;
    const hf = await healthFactorCheckEngine.getHF(addresses);

    forEach(ur, (item) => {
        let found: any = _.find(hf, (r: any) => r.user.id == item.address);
        if (found) _.assign(ur, found);
    });
    console.log(ur);
    */
    //await healthFactorCheckEngine.performHealthFactorCheckPeriodic();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    })
    .finally(() => process.exit(0));
