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
    /*
    const dbAddressesArr = await sqlManager.execQuery(
        "SELECT TOP 1 * FROM addresses where address IN ('0x00227dd82fae1220bdac630297753bb2cb4e8ddd')"
    );
    const _addresses = _.map(dbAddressesArr, (a: any) => a.address);
    */
    const _addresses = [
        "0x9892444271b9b238c88c7a3af651b8d10a74d95b",
        "0x1de7bdcc56472b29473a36af0b22ab18fc35765c",
        "0xf3c3f14dd7bdb7e03e6ebc3bc5ffc6d66de12251",
        "0xf78c0b11f0ec3180f15ecbf09abc05ebb65bd8bc",
        "0x9d5bca1d46ee491ebafbbffdf532ae7d313d91d5",
        "0xcf3074e5730a23775a07a01afbcdc66220757d05",
        "0x227daf4134ccd8eac97e6cadf6c83b6835d30fa4",
        "0x0e7121299279d976c246957617db97a81a9a1a4b",
        "0x75204972052a89196fee3226e948accdc78a1f1b",
    ];
    const userReserves = await healthFactorCheckEngine.fetchAllUsersReserves(
        _addresses
    );

    //console.log(JSON.stringify(userReserves));

    for (const address of _addresses) {
        const addressUserReserves = _.filter(
            userReserves,
            (ur) => ur.user.id == address
        );
        const hfFromReserves =
            healthFactorCheckEngine.calculateHealthFactor(addressUserReserves);
        const hfFromChain = await healthFactorCheckEngine.getHealthFactor(
            "arb",
            "mainnet",
            address
        );

        console.log(hfFromReserves, hfFromChain);
    }

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
