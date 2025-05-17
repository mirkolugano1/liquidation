import _ from "lodash";
import encryption from "../managers/encryptionManager";
import Big from "big.js";
import repo from "./repo";
import { ethers, formatUnits } from "ethers";
import { Network } from "alchemy-sdk";
import Constants from "../shared/constants";

class Common {
    public isProd: boolean;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";
    }

    public getNetworkInfos() {
        return this.isProd
            ? _.filter(Constants.AAVE_NETWORKS_INFOS, { isActive: true })
            : Constants.AAVE_NETWORKS_INFOS;
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

    /**
     * Call this method to create a PEM file from a hex private key.
     * Then use the PEM file to import the key into Azure Key Vault by following the procedure below:
     *
     * # (in WSL) First check if your current key can be read by OpenSSL
     * openssl ec -inform PEM -in pkcs8_key.pem -text -noout
     *
     *  # (in WSL) If the above works, convert to named curve format
     * openssl ec -inform PEM -in pkcs8_key.pem -outform PEM -out named_curve_key.pem -param_enc named_curve
     *
     * # (in Windows) Try importing with the new file
     * az keyvault key import --vault-name liquidation \
     *                --name ethereum-signing-key \
     *                --pem-file named_curve_key.pem \
     *                --kty EC \
     *                --curve P-256K
     *
     * @param hexPrivateKey The private key of the wallet in hex format
     */
    public createPemFileFromPrivateKey(hexPrivateKey: string) {
        const fs = require("fs");
        const crypto = require("crypto");

        // Convert to Buffer
        const privateKeyBuffer = Buffer.from(hexPrivateKey, "hex");

        // Create EC key pair
        const ecdh = crypto.createECDH("secp256k1");
        ecdh.setPrivateKey(privateKeyBuffer);

        // Create an ASN.1 structure for PKCS#8
        // Note: This is a simplified version and may need adjustments
        const asn1 = Buffer.concat([
            Buffer.from("302e0201010420", "hex"), // ASN.1 header for EC private key
            privateKeyBuffer, // Private key bytes
            Buffer.from("a00706052b8104000a", "hex"), // secp256k1 OID
        ]);

        // Convert to PEM format
        const pemKey =
            "-----BEGIN PRIVATE KEY-----\n" +
            (asn1.toString("base64").match(/.{1,64}/g) || []).join("\n") +
            "\n-----END PRIVATE KEY-----\n";

        // Write to file
        fs.writeFileSync("pkcs8_key.pem", pemKey);
        console.log("Private key saved to pkcs8_key.pem");
    }

    public isObjectIterable(obj: any) {
        // Check for null and undefined
        if (obj == null) {
            return false;
        }

        // The best way: check if Symbol.iterator exists and is a function
        return typeof obj[Symbol.iterator] === "function";
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
