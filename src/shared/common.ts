import _ from "lodash";
import encryption from "../managers/encryptionManager";
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

    getCronScheduleByJobName(jobName: string) {
        if (!jobName) throw new Error("No job name provided");
        switch (jobName) {
            case "updateReservesPricesTimer":
                return this.isProd ? "*/5 * * *" : "0 0 * * *"; // Every hour in prod, every 5 minutes in dev
            case "updateUserAccountDataAndUsersReservesTimer":
                return this.isProd ? "*/15 * * * *" : "0 0 * * *"; // Every hour in prod, every 5 minutes in dev
            default:
                throw new Error("No cron schedule found for job " + jobName);
        }
    }

    getProcessingAddressesKey(network: Network | string) {
        if (!network) throw new Error("No network provided");
        return `processingAddresses:${network.toString()}`;
    }

    normalizeRedisKey(key: string) {
        return key?.toLowerCase().replace("-", "_");
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

    //#region normalizeAddress

    public normalizeAddress(address: string) {
        if (!address) return "";
        const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
        const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
        const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
        return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
    }

    //#endregion normalizeAddress

    //#region escapeHtml

    escapeHtml(str: string) {
        return str.replace(
            /[&<>'"]/g,
            (c) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    "'": "&#39;",
                    '"': "&quot;",
                }[c] || c)
        );
    }

    //#endregion escapeHtml

    //#region getHealthFactorFromUserAccountData

    getHealthFactorFromUserAccountData(userAccountData: any) {
        try {
            const healthFactorStr = formatUnits(userAccountData[5], 18);

            return parseFloat(healthFactorStr);
        } catch (error) {
            console.error("Error parsing health factor:", userAccountData);
            return 0;
        }
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
