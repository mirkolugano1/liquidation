import { CloudStorageManager } from "../common/cloudStorageManager";
import common from "../common/common";
import sqlManager from "../data/sqlManager";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import keccak from "../common/keccak";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import webhookEngine from "../engines/webhookEngine";
import _ from "lodash";
require("dotenv").config();

async function main() {
    await sqlManager.initialize();
    const dbAddressesArr = await sqlManager.execQuery(
        "SELECT * FROM addresses"
    );
    const dbAddresses = dbAddressesArr.map((a: any) => a.address);
    const addressesText = await fileUtilities.readFromTextFile(
        common.addressesFilePath
    );
    let addresses = addressesText.split("\r\n");
    //0xf8153167313ce9cfcb45bd4aff2b543513388163
    //0x13c689accec0f42d2d916cde7b1ffa1ee7e0a894
    addresses = _.uniq(addresses);
    addresses = _.reject(addresses, (a) => _.includes(dbAddresses, a));
    addresses = _.map(addresses, (a) => normalizeAddress(a));

    //addresses = [addresses[0], addresses[1]];

    const query = `INSERT INTO addresses VALUES ${addresses
        .map((a) => `('${a}', 'Ethereum mainnet')`)
        .join(",")}`;
    const ep = await sqlManager.execQuery(query);
    console.log(ep);
    return;

    await healthFactorCheckEngine.initializeHealthFactorCheckLoop();
    await healthFactorCheckEngine.test();
}

function normalizeAddress(address: string) {
    if (!address) return "";
    const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
    const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
    const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
    return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
