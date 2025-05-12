import _ from "lodash";
import dotenv from "dotenv";
import engine from "../engines/engine";
import { Wallet } from "ethers";
import fs from "fs";

dotenv.config();
//logger.initialize("sandbox");
//aa
async function main() {
    try {
        //await engine.updateReservesPrices();
        //await engine.doTest();
    } catch (error) {
        console.error("Error in main function:", error);
    }
}

function createDerFile(hexPrivateKey: string) {
    const fs = require("fs");
    const EC = require("elliptic").ec;
    const asn1 = require("asn1.js");

    // Initialize the secp256k1 curve
    const ec = new EC("secp256k1");

    // Create a key pair from the private key
    const keyPair = ec.keyFromPrivate(hexPrivateKey, "hex");

    // Define the ASN.1 structure for an EC private key
    const ECPrivateKeyASN = asn1.define("ECPrivateKey", function (this: any) {
        this.seq().obj(
            this.key("version").int(),
            this.key("privateKey").octstr(),
            this.key("parameters").explicit(0).optional().objid(),
            this.key("publicKey").explicit(1).optional().bitstr()
        );
    });

    // Encode the private key into ASN.1 DER format
    const derKey = ECPrivateKeyASN.encode(
        {
            version: 1,
            privateKey: Buffer.from(keyPair.getPrivate("hex"), "hex"),
            parameters: [1, 3, 132, 0, 10], // Object Identifier for secp256k1 curve
            publicKey: {
                data: Buffer.from(keyPair.getPublic(false, "hex"), "hex"),
                unused: 0,
            },
        },
        "der"
    );

    // Save the DER key to a file
    fs.writeFileSync("private-key.der", derKey);
    console.log("DER key saved to private-key.der");
}

main();
