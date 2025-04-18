import _ from "lodash";
import encryption from "../managers/encryptionManager";
import Big from "big.js";

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

    convertUSDtoETH(
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

    public getJsonObjectFromArray(
        array: any[],
        key: string,
        value: any = null
    ) {
        return Object.fromEntries(
            _.map(array, (item: any) => [item[key], value ? item[value] : item])
        );
    }

    public intToBinary(integerValue: any) {
        return integerValue.toString(2);
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
