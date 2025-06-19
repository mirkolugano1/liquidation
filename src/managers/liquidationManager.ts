import BigNumber from "bignumber.js";
import logger from "../shared/logger";
import { Network } from "alchemy-sdk";
import _ from "lodash";
import { LoggingFramework } from "../shared/enums";
import repo from "../shared/repo";
import transactionManager from "./transactionManager";
import common from "../shared/common";
import Constants from "../shared/constants";
import emailManager from "./emailManager";
import redisManager from "./redisManager";

class LiquidationManager {
    private static instance: LiquidationManager;
    public static getInstance(): LiquidationManager {
        if (!LiquidationManager.instance) {
            LiquidationManager.instance = new LiquidationManager();
        }
        return LiquidationManager.instance;
    }

    private constructor() {}

    //#region getUserDebtInBaseCurrency

    getUserDebtInBaseCurrency(
        userReserve: any,
        reserve: any,
        assetPrice: any
    ): BigNumber {
        // Add stable debt (already normalized in currentStableDebt)
        const userTotalDebt = new BigNumber(
            userReserve.currentVariableDebt || 0
        ).plus(new BigNumber(userReserve.currentStableDebt || 0));

        if (userTotalDebt.isZero()) return BigNumber(0);

        // Convert to USD (multiply by price and adjust for price decimals)
        return userTotalDebt
            .dividedBy(new BigNumber(10).pow(reserve.decimals))
            .multipliedBy(new BigNumber(assetPrice));
    }

    //#endregion getUserDebtInBaseCurrency

    //#region checkLiquidateAddresses

    async checkLiquidateAddresses(
        network: Network | string,
        addresses: string | string[] | null = null
    ) {
        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        if (!addresses) {
            addresses = _.map(
                aaveNetworkInfo.addressesObjects,
                (o) => o.address
            );
        } else if (!Array.isArray(addresses)) addresses = [addresses];
        let userAddressesObjects: any[] = [];
        let usersReserves: any[] = [];
        for (const address of addresses) {
            const userAddressesObject =
                aaveNetworkInfo.addressesObjects[address];
            const userReserves = aaveNetworkInfo.usersReserves[address];
            if (!userReserves || userReserves.length == 0) continue;
            userAddressesObjects.push(userAddressesObject);
            usersReserves = _.concat(usersReserves, userReserves);
        }

        await this.checkLiquidateAddressesFromInMemoryObjects(
            aaveNetworkInfo,
            userAddressesObjects,
            usersReserves
        );
    }

    //#endregion checkLiquidateAddresses

    //#region checkLiquidateAddressesFromInMemoryObjects

    async checkLiquidateAddressesFromInMemoryObjects(
        aaveNetworkInfo: any,
        userAddressesObjects: any[] | null = null,
        usersReserves: any[] | null = null
    ) {
        if (!userAddressesObjects)
            userAddressesObjects = await redisManager.getList(
                `addresses:${aaveNetworkInfo.network}:*`
            );

        let userAddressesObjectsAddresses = _.map(
            userAddressesObjects,
            (o) => o.address
        );
        let liquidatableAddresses: any[] = [];
        const key = aaveNetworkInfo.network.toString();

        if (!usersReserves) {
            const reserves = aaveNetworkInfo.reserves;
            let usersReservesKeys: string[] = [];
            _.each(userAddressesObjectsAddresses, (o) => {
                _.each(reserves, (reserve: any) => {
                    usersReservesKeys.push(
                        `usersReserves:${aaveNetworkInfo.network}:${o}:${reserve.address}`
                    );
                });
            });
            usersReserves = await redisManager.getMultipleJsonKeys(
                usersReservesKeys
            );
        }

        //mirko
        if (userAddressesObjects && userAddressesObjects.length > 0) {
            for (const userAddressObject of userAddressesObjects) {
                const healthFactor = this.calculateHealthFactorOffChain(
                    userAddressObject,
                    aaveNetworkInfo,
                    usersReserves.filter(
                        (o) => o.address == userAddressObject.address
                    )
                );

                //as long as liquidations are not enabled, we check the results from chain
                //to ensure that the off-chain calculations are correct
                if (!repo.liquidationsEnabled) {
                    await this.checkUserAccountDataBeforeLiquidation(
                        userAddressObject.address,
                        aaveNetworkInfo
                    );
                }

                if (healthFactor < 1)
                    liquidatableAddresses.push(userAddressObject.address);
            }

            if (liquidatableAddresses.length > 0) {
                const liquidatableUserAddressObjects = _.filter(
                    userAddressesObjects,
                    (o) => _.includes(liquidatableAddresses, o.address)
                );

                let profitableLiquidations: any[] = [];
                for (const liquidatableUserAddressObject of liquidatableUserAddressObjects) {
                    const userReserves =
                        repo.aave[key].usersReserves[
                            liquidatableUserAddressObject.address
                        ];
                    if (!userReserves || userReserves.length == 0) continue;

                    let potentialProfitableLiquidation: any = {
                        profit: 0,
                    };
                    for (const userReserve of userReserves) {
                        if (
                            userReserve.usageAsCollateralEnabled &&
                            this.isReserveUsedAsCollateral(
                                liquidatableUserAddressObject.userConfiguration,
                                userReserve.tokenAddress,
                                aaveNetworkInfo
                            ) &&
                            userReserve.currentATokenBalance > 0
                        ) {
                            for (const debtUserReserve of userReserves) {
                                if (
                                    userReserve.tokenAddress !=
                                        debtUserReserve.tokenAddress &&
                                    (debtUserReserve.currentStableDebt > 0 ||
                                        debtUserReserve.variabledebt > 0)
                                ) {
                                    //we are in a collateral / debt pair whose balance is both > 0.
                                    //calculate potential profit of liquidation for this asset pair
                                    const [debtToCover, profitInUSD] =
                                        await this.calculateNetLiquidationReward(
                                            userReserve,
                                            debtUserReserve,
                                            liquidatableUserAddressObject.healthFactor,
                                            aaveNetworkInfo
                                        );

                                    const profitInUSDNumber =
                                        profitInUSD.toNumber();
                                    if (
                                        profitInUSDNumber >
                                        potentialProfitableLiquidation.profit
                                    ) {
                                        potentialProfitableLiquidation = {
                                            profit: profitInUSDNumber,
                                            collateralAsset:
                                                userReserve.tokenAddress,
                                            debtAsset:
                                                debtUserReserve.tokenAddress,
                                            address:
                                                liquidatableUserAddressObject.address,
                                            debtToCover: debtToCover,
                                        };
                                    }
                                }
                            }
                        }
                    }

                    if (potentialProfitableLiquidation.profit > 0)
                        profitableLiquidations.push(
                            potentialProfitableLiquidation
                        );
                }

                if (profitableLiquidations.length > 0) {
                    if (repo.liquidationsEnabled) {
                        const liquidationsPromises = _.map(
                            profitableLiquidations,
                            (o) => {
                                return transactionManager.sendSingleTransaction(
                                    aaveNetworkInfo,
                                    "requestFlashLoan",
                                    [
                                        o.collateralAsset,
                                        o.debtAsset,
                                        o.address,
                                        o.debtToCover,
                                        true, //receive aTokens
                                    ]
                                );
                            }
                        );

                        if (liquidationsPromises.length > 0) {
                            const liquidationsResults = await Promise.all(
                                liquidationsPromises
                            );
                            await logger.log(
                                "Liquidations results: " +
                                    JSON.stringify(liquidationsResults),
                                LoggingFramework.Table
                            );
                        }
                    } else {
                        await emailManager.sendLogEmail(
                            "Liquidation triggered",
                            "Data: " + JSON.stringify(profitableLiquidations)
                        );
                    }
                }

                await logger.log(
                    "checkLiquidateAddressesFromInMemoryObjects: " +
                        JSON.stringify(profitableLiquidations),
                    LoggingFramework.Table
                );
            }
        }
    }

    //#endregion checkLiquidateAddressesFromInMemoryObjects

    async checkUserAccountDataBeforeLiquidation(
        address: string,
        aaveNetworkInfo: any
    ) {
        const userAccountData = aaveNetworkInfo.addressesObjects[address];
        if (!userAccountData) return;

        const userAccountDataFromChain = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            address,
            Constants.ABIS.POOL_ABI,
            "getUserAccountData",
            aaveNetworkInfo.network
        );

        if (!userAccountDataFromChain || userAccountDataFromChain.length == 0)
            return;
        const userAccountDataFromChainObject: any = {
            totalCollateralBase: userAccountDataFromChain[0][0],
            totalDebtBase: userAccountDataFromChain[0][1],
            currentLiquidationThreshold: userAccountDataFromChain[0][2],
            ltv: userAccountDataFromChain[0][3],
            healthFactor: common.getHealthFactorFromUserAccountData(
                userAccountDataFromChain[0]
            ),
        };

        const userAccountDataFromChainObjectKeys = _.keys(
            userAccountDataFromChainObject
        );
        let str = "";
        for (const key of userAccountDataFromChainObjectKeys) {
            if (
                userAccountData[key] !=
                userAccountDataFromChainObject[key].toString()
            ) {
                str += `${key}: ${
                    userAccountData[key]
                } != ${userAccountDataFromChainObject[key].toString()}\n`;
            }
        }
        if (str.length > 0) {
            console.log(
                `checkUserAccountDataBeforeLiquidation: User account data mismatch for address ${address}: ${str}`
            );
            /*
            await logger.log(
                `checkUserAccountDataBeforeLiquidation: User account data mismatch for address ${address}: ${str}`,
                LoggingFramework.Table
            );
            */
        }
    }

    //#region calculateNetLiquidationReward

    async calculateNetLiquidationReward(
        collateralAssetObject: any,
        debtAssetObject: any,
        healthFactor: number,
        aaveNetworkInfo: any
    ) {
        const debtAmountTotal: BigNumber = new BigNumber(
            debtAssetObject.currentStableDebt ?? 0
        ).plus(new BigNumber(debtAssetObject.currentVariableDebt ?? 0));
        const closeFactor = healthFactor > 0.95 ? 0.5 : 1; // 50% close factor if health factor is > 0.95, otherwise 100%
        const liquidatableDebtAmount: BigNumber = debtAmountTotal
            .times(closeFactor)
            .div(10000);

        const debttokenAddress = debtAssetObject.tokenAddress;
        const collateraltokenAddress = collateralAssetObject.tokenAddress;
        const debtTokenReserve = aaveNetworkInfo.reserves[debttokenAddress];
        const collateralTokenReserve =
            aaveNetworkInfo.reserves[collateraltokenAddress];
        const debtDecimals = debtTokenReserve.decimals;
        const collateralDecimals = collateralTokenReserve.decimals;
        const liquidationProtocolFee =
            collateralTokenReserve.liquidationProtocolFee;
        const liquidationBonus = collateralTokenReserve.liquidationBonus;
        const debtPrice = new BigNumber(debtTokenReserve.price);
        const collateralPrice = new BigNumber(collateralTokenReserve.price);

        // 1. Calculate the base collateral amount (without bonus)
        const baseCollateral = liquidatableDebtAmount
            .times(debtPrice)
            .times(10 ** collateralDecimals)
            .dividedBy(collateralPrice.times(10 ** debtDecimals));

        // 2. Calculate the bonus amount
        const bonusAmount = baseCollateral
            .times(liquidationBonus - 10000) // Subtract 100% to get just the bonus portion
            .dividedBy(10000);

        // 3. Calculate the protocol fee (applied only to the bonus portion)
        const protocolFeeAmount = bonusAmount
            .times(liquidationProtocolFee)
            .dividedBy(10000);

        // 4. Calculate the total collateral received after protocol fee (in native units)
        const totalCollateralReceived = baseCollateral
            .plus(bonusAmount)
            .minus(protocolFeeAmount);

        // 5. Convert collateral value to USD
        const collateralValueUSD = totalCollateralReceived
            .times(collateralPrice)
            .dividedBy(10 ** collateralDecimals);

        // 6. Convert debt to USD for profit calculation
        const debtValueUSD = liquidatableDebtAmount
            .times(debtPrice)
            .dividedBy(10 ** debtDecimals);

        // 6. Calculate gross profit in USD
        const grossProfitUSD = collateralValueUSD.minus(debtValueUSD);

        // 7. Calculate gas cost in USD with the appropriate multiplier
        // Initial calculation with base fee
        const wethReserve = _.find(_.values(aaveNetworkInfo.reserves), {
            symbol: "WETH",
        });
        const ethPriceUSD = new BigNumber(wethReserve.price).div(
            10 ** wethReserve.decimals
        );
        const gasPrice = await redisManager.getValue(
            `gasPrice:${aaveNetworkInfo.network}`
        );
        const baseTxCostWei = new BigNumber(
            aaveNetworkInfo.averageLiquidationGasUnits
        ).times(BigNumber(gasPrice));
        const baseTxCostUSD = baseTxCostWei
            .times(ethPriceUSD)
            .dividedBy(10 ** wethReserve.decimals);

        // Apply fee tier based on gross profit
        const gasFeeMultiplier = grossProfitUSD.isGreaterThan(BigNumber(100))
            ? 10000
            : 5000;
        const scaledGasMultiplier = new BigNumber(gasFeeMultiplier).dividedBy(
            10000
        );
        const actualTxCostUSD = baseTxCostUSD.times(scaledGasMultiplier);

        // 8. Calculate net profit in USD
        const netProfitUSD = grossProfitUSD.minus(actualTxCostUSD);

        // Return: [debtToCover in native units, profit in USD]
        return [
            liquidatableDebtAmount, // Amount of debt tokens to repay (native units)
            netProfitUSD, // Profit in USD
        ];
    }

    //#endregion calculateNetLiquidationReward

    //#region calculateTotalDebtBaseForAddress

    calculateTotalDebtBaseForAddress(
        userAddressObject: any,
        aaveNetworkInfo: any,
        usersReserves: any[] | null = null
    ): BigNumber {
        const reserves = _.values(aaveNetworkInfo.reserves);
        if (!usersReserves || usersReserves.length == 0) return BigNumber(0);

        let totalDebt = BigNumber(0);

        for (const reserve of reserves) {
            const userReserve = _.find(usersReserves, (o) => {
                return o.tokenAddress == reserve.address;
            });

            if (!userReserve) continue;

            // Get the appropriate price
            let reservePrice = reserve.price;
            if (
                reserve.eModeAssetPrice &&
                reserve.eModeAssetPrice != 0 &&
                userAddressObject.userEModeCategory ==
                    reserve.eModeAssetCategory
            ) {
                reservePrice = reserve.eModeAssetPrice;
            }

            // Calculate total debt for this reserve
            const debtInUSD = this.getUserDebtInBaseCurrency(
                userReserve,
                reserve,
                reservePrice
            );

            totalDebt = totalDebt.plus(debtInUSD);
        }

        return totalDebt;
    }

    //#endregion calculateTotalDebtBaseForAddress

    //#region calculateTotalCollateralBaseForAddress

    calculateTotalCollateralBaseForAddress(
        userAddressObject: any,
        aaveNetworkInfo: any,
        usersReserves: any[] | null = null
    ): BigNumber {
        const reserves = _.values(aaveNetworkInfo.reserves);
        if (!usersReserves || usersReserves.length == 0) return BigNumber(0);

        let totalCollateral = new BigNumber(0);

        for (const reserve of reserves) {
            const userReserve = _.find(usersReserves, (o) => {
                return o.tokenAddress == reserve.address;
            });

            if (
                !userReserve ||
                !userReserve.usageAsCollateralEnabled ||
                userReserve.currentATokenBalance == "0" ||
                !reserve.reserveLiquidationThreshold ||
                reserve.reserveLiquidationThreshold == 0
            ) {
                continue;
            }

            // Get the appropriate price
            let reservePrice = reserve.price;
            if (
                reserve.eModeAssetPrice &&
                reserve.eModeAssetPrice != 0 &&
                userAddressObject.userEModeCategory ==
                    reserve.eModeAssetCategory
            ) {
                reservePrice = reserve.eModeAssetPrice;
            }

            // Convert currentATokenBalance to base currency (USD)
            // currentATokenBalance is already in wei/smallest unit
            const balanceInUSD = new BigNumber(userReserve.currentATokenBalance)
                .dividedBy(new BigNumber(10).pow(reserve.decimals))
                .multipliedBy(new BigNumber(reservePrice));

            totalCollateral = totalCollateral.plus(balanceInUSD);
        }

        return totalCollateral;
    }

    //#endregion calculateTotalCollateralBaseForAddress

    //#region calculateHealthFactorOffChain

    calculateHealthFactorOffChain(
        userAddressObject: any,
        aaveNetworkInfo: any,
        usersReserves: any[] | null = null
    ) {
        if (!userAddressObject || !aaveNetworkInfo) {
            throw new Error(
                "Invalid user address object or Aave network info."
            );
        }
        if (!usersReserves || usersReserves.length == 0) {
            throw new Error(
                "No user reserves provided for health factor calculation."
            );
        }
        const totalCollateralBase = this.calculateTotalCollateralBaseForAddress(
            userAddressObject,
            aaveNetworkInfo,
            usersReserves
        );
        const totalDebtBase = this.calculateTotalDebtBaseForAddress(
            userAddressObject,
            aaveNetworkInfo,
            usersReserves
        );

        if (totalDebtBase.isZero()) return 9999999999; // No debt means health factor is very high
        const currentLiquidationThresholdBig = new BigNumber(
            userAddressObject.currentLiquidationThreshold
        ).div(10 ** 4);
        return totalCollateralBase
            .times(currentLiquidationThresholdBig)
            .div(totalDebtBase)
            .toNumber();
    }

    //#endregion calculateHealthFactorOffChain

    //#region isReserveUsedAsCollateral

    isReserveUsedAsCollateral(
        userConfiguration: string,
        reserveAddress: string,
        aaveNetworkInfo: any
    ) {
        // Find the index of the reserve in the reserves list
        const reservesList = _.keys(aaveNetworkInfo.reserves);
        const reserveIndex = reservesList.indexOf(reserveAddress);
        if (reserveIndex === -1) {
            throw new Error("Reserve address not found in the reserves list.");
        }

        // Convert the userConfiguration to a BigInt for bitwise operations
        const userConfigBigInt = BigInt(userConfiguration);

        // Calculate the position of the collateral bit for the reserve
        const collateralBitPosition = reserveIndex * 2; // Each reserve has 2 bits (collateral and borrow)

        // Check if the collateral bit is set (1) or not (0)
        const isCollateral =
            (userConfigBigInt >> BigInt(collateralBitPosition)) & BigInt(1);

        // Return true if the collateral bit is 1, false otherwise
        return isCollateral === BigInt(1);
    }

    //#endregion isReserveUsedAsCollateral
}
export default LiquidationManager.getInstance();
