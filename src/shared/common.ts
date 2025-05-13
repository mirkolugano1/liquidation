import _ from "lodash";
import encryption from "../managers/encryptionManager";
import Big from "big.js";
import repo from "./repo";
import { ethers, formatUnits } from "ethers";
import { Network } from "alchemy-sdk";

class Common {
    public isProd: boolean;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";
    }

    public async getAppSetting(key: string) {
        if (!process.env.hasOwnProperty(key)) {
            const value = await encryption.getSecretFromKeyVault(key, true);
            if (value) return value;
            else
                throw new Error("Missing required environment variable " + key);
        }
        return process.env[key];
    }

    public convertUSDtoETH(
        tokenPriceInUSD: number | string | Big,
        ethPriceInUSD: number | string | Big
    ) {
        // Convert to Big if not already a Big instance
        const tokenPrice =
            tokenPriceInUSD instanceof Big
                ? tokenPriceInUSD
                : new Big(tokenPriceInUSD);

        const ethPrice =
            ethPriceInUSD instanceof Big
                ? ethPriceInUSD
                : new Big(ethPriceInUSD);

        if (ethPrice.lte(0)) {
            throw new Error("ETH price must be greater than zero");
        }

        // Perform division to get the ETH price
        // Big.js handles decimal arithmetic directly, no need for scaling factors
        return tokenPrice.div(ethPrice).toNumber();
    }

    public convertETHtoUSD(
        tokenPriceInETH: number | string | Big,
        ethPriceInUSD: number | string | Big
    ) {
        // Convert to Big if not already a Big instance
        const tokenPrice =
            tokenPriceInETH instanceof Big
                ? tokenPriceInETH
                : new Big(tokenPriceInETH);

        const ethPrice =
            ethPriceInUSD instanceof Big
                ? ethPriceInUSD
                : new Big(ethPriceInUSD);

        // Simple multiplication to get the USD price
        return tokenPrice.mul(ethPrice).toNumber();
    }

    //#region normalizeAddress

    public normalizeAddress(address: string) {
        if (!address) return "";
        const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
        const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
        const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
        return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
    }

    //#endregion normalizeAddress

    //#region getHealthFactorFromUserAccountData

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    //#endregion getHealthFactorFromUserAccountData

    //#region getContract

    getContract(address: string, contractAbi: any, network: Network) {
        const networkInfo = this.getAaveNetworkInfo(network);
        return new ethers.Contract(
            address,
            contractAbi,
            networkInfo.alchemyProvider
        );
    }

    //#endregion getContract

    //#region getAaveNetworkInfo

    public getAaveNetworkInfo(network: Network | string) {
        if (!network) throw new Error("No network provided");
        const key = network.toString();
        let obj = repo.aave[key];
        if (!obj)
            throw new Error(`Aave network info not found for network ${key}`);
        return obj;
    }

    //#endregion getAaveNetworkInfo

    //#region getContractInterface

    public getContractInterface(contractABI: any) {
        if (!contractABI) throw new Error("No contractABI provided");
        const contractABIString = JSON.stringify(contractABI);

        if (!repo.contractInterfaces[contractABIString]) {
            repo.contractInterfaces[contractABIString] = new ethers.Interface(
                contractABI
            );
        }
        return repo.contractInterfaces[contractABIString];
    }

    //#endregion getContractInterface

    public createDerFile(hexPrivateKey: string) {
        const fs = require("fs");
        const EC = require("elliptic").ec;
        const asn1 = require("asn1.js");

        // Initialize the secp256k1 curve
        const ec = new EC("secp256k1");

        // Create a key pair from the private key
        const keyPair = ec.keyFromPrivate(hexPrivateKey, "hex");

        // Define the ASN.1 structure for an EC private key
        const ECPrivateKeyASN = asn1.define(
            "ECPrivateKey",
            function (this: any) {
                this.seq().obj(
                    this.key("version").int(),
                    this.key("privateKey").octstr(),
                    this.key("parameters").explicit(0).optional().objid(),
                    this.key("publicKey").explicit(1).optional().bitstr()
                );
            }
        );

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

    public getJsonObjectFromKeyValuesArray(
        array: any[],
        key: string,
        value: any = null
    ) {
        return Object.fromEntries(
            _.map(array, (item: any) => [item[key], value ? item[value] : item])
        );
    }

    public async sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }
}

export default Common.getInstance();
