import logger from "../shared/logger";
import Big from "big.js";
import { Network } from "alchemy-sdk";
import _ from "lodash";
import { LogType, LoggingFramework } from "../shared/enums";
import repo from "../shared/repo";
import multicallManager from "./multicallManager";
import common from "../shared/common";
import { r } from "tar";

class LiquidationManager {
    private static instance: LiquidationManager;

    public static getInstance(): LiquidationManager {
        if (!LiquidationManager.instance) {
            LiquidationManager.instance = new LiquidationManager();
        }
        return LiquidationManager.instance;
    }

    private constructor() {}

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
            usersReserves.push(...userReserves);
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
        userAddressesObjects: any[],
        usersReserves: any[] | null = null
    ) {
        let userAddressesObjectsAddresses = _.map(
            userAddressesObjects,
            (o) => o.address
        );
        let liquidatableAddresses: any[] = [];
        const key = aaveNetworkInfo.network.toString();

        if (!usersReserves) {
            usersReserves = _.map(repo.aave[key].usersReserves, (o) =>
                _.includes(userAddressesObjectsAddresses, o.address)
            );
        }

        if (userAddressesObjects.length > 0) {
            for (const userAddressObject of userAddressesObjects) {
                repo.aave[key].addressesObjects[
                    userAddressObject.address
                ].totalCollateralBase =
                    this.calculateTotalCollateralBaseForAddress(
                        userAddressObject.address,
                        aaveNetworkInfo
                    );
                repo.aave[key].addressesObjects[
                    userAddressObject.address
                ].totalDebtBase = this.calculateTotalDebtBaseForAddress(
                    userAddressObject.address,
                    aaveNetworkInfo
                );
                repo.aave[key].addressesObjects[
                    userAddressObject.address
                ].healthFactor = this.calculateHealthFactorOffChain(
                    repo.aave[key].addressesObjects[userAddressObject.address]
                        .totalCollateralBase,
                    repo.aave[key].addressesObjects[userAddressObject.address]
                        .totalDebtBase,
                    userAddressObject.currentLiquidationThreshold
                );

                await this.checkUserAccountDataBeforeLiquidation(
                    userAddressObject.address,
                    aaveNetworkInfo
                );

                if (
                    repo.aave[key].addressesObjects[userAddressObject.address]
                        .healthFactor < 1
                ) {
                    liquidatableAddresses.push(userAddressObject.address);
                }
            }

            /////
            //only for testing purposes, to compare calculated data with on-chain data
            if (!common.isProd) {
                const userAccountDatas = await multicallManager.multicall(
                    aaveNetworkInfo.aaveAddresses.pool,
                    userAddressesObjectsAddresses,
                    "POOL_ABI",
                    "getUserAccountData",
                    aaveNetworkInfo.network
                );

                const userAccountDatasObjects = _.map(
                    userAccountDatas,
                    (userAccountData: any, index: number) => {
                        return {
                            address: userAddressesObjectsAddresses[index],
                            chainTotalCollateralBase: userAccountData[0],
                            chainTotalDebtBase: userAccountData[1],
                            chainHealthFactor:
                                common.getHealthFactorFromUserAccountData(
                                    userAccountData
                                ),
                            offchainTotalCollateralBase:
                                repo.aave[key].addressesObjects[
                                    userAddressesObjectsAddresses[index]
                                ].totalCollateralBase,
                            offchainTotalDebtBase:
                                repo.aave[key].addressesObjects[
                                    userAddressesObjectsAddresses[index]
                                ].totalDebtBase,
                            offchainHealthFactor:
                                repo.aave[key].addressesObjects[
                                    userAddressesObjectsAddresses[index]
                                ].healthFactor,
                        };
                    }
                );

                await logger.log(
                    JSON.stringify(userAccountDatasObjects),
                    "liquidationTriggered",
                    LogType.Trace,
                    LoggingFramework.Table
                );
            }
            ///end of testing purposes

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
                                        this.calculateNetLiquidationReward(
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

                // Log the number of liquidatable addresses and the details of profitable liquidations
                if (!common.isProd) {
                    const profitableLiquidationsAddresses = _.map(
                        profitableLiquidations,
                        (o) => o.address
                    );
                    const uads = await multicallManager.multicall(
                        aaveNetworkInfo.aaveAddresses.pool,
                        profitableLiquidationsAddresses,
                        "POOL_ABI",
                        "getUserAccountData",
                        aaveNetworkInfo.network
                    );
                    for (let i = 0; i < uads.length; i++) {
                        const uad = uads[i];
                        profitableLiquidations[i].test_healthFactorFromChain =
                            common.getHealthFactorFromUserAccountData(uad);
                    }

                    await logger.log(
                        JSON.stringify({
                            liquidatableAddressesCount:
                                liquidatableAddresses.length,
                            profitableLiquidations: profitableLiquidations,
                        }),
                        "liquidationTriggered",
                        LogType.Trace,
                        LoggingFramework.Table
                    );
                }

                if (profitableLiquidations.length > 0) {
                    const liquidationsEnabled = false;
                    if (liquidationsEnabled) {
                        const liquidationsParameters = _.map(
                            profitableLiquidations,
                            (o) => {
                                return [
                                    o.collateralAsset,
                                    o.debtAsset,
                                    o.address,
                                    o.debtToCover,
                                    true, //receive aTokens
                                ];
                            }
                        );

                        //TODO MIRKO Call requestFlashLoan method of the liquidation contract

                        /*
                        await multicallManager.multicall(
                            aaveNetworkInfo.liquidationContractAddress,
                            liquidationsParameters,
                            "LIQUIDATION_ABI",
                            "requestFlashLoan",
                            aaveNetworkInfo.network
                        );
                        */
                    } else {
                        /*
                            await emailManager.sendLogEmail(
                                "Liquidation triggered",
                                "Data: " + JSON.stringify(profitableLiquidations)
                            );
                            */
                        await logger.log(
                            JSON.stringify(profitableLiquidations),
                            "liquidationTriggered",
                            LogType.Trace,
                            LoggingFramework.Table
                        );
                    }
                }
            }
        }
    }

    //#endregion checkLiquidateAddressesFromInMemoryObjects

    async checkUserAccountDataBeforeLiquidation(
        address: string,
        aaveNetworkInfo: any
    ) {
        if (!repo.isCheckUserAccountDataEnabled) return;
        const userAccountData = aaveNetworkInfo.addressesObjects[address];
        if (!userAccountData) return;

        const userAccountDataFromChain = await multicallManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            address,
            "POOL_ABI",
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
            await logger.log(
                `User account data mismatch for address ${address}: ${str}`,
                "checkUserAccountDataBeforeLiquidation",
                LogType.Trace,
                LoggingFramework.Table
            );
        }
    }

    //#region calculateNetLiquidationReward

    calculateNetLiquidationReward(
        collateralAssetObject: any,
        debtAssetObject: any,
        healthFactor: number,
        aaveNetworkInfo: any
    ) {
        const debtAmountTotal: Big = new Big(
            debtAssetObject.currentStableDebt ?? 0
        ).add(new Big(debtAssetObject.currentVariableDebt ?? 0));
        const closeFactor = healthFactor > 0.95 ? 0.5 : 1; // 50% close factor if health factor is > 0.95, otherwise 100%
        const liquidatableDebtAmount: Big = debtAmountTotal
            .mul(closeFactor)
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
        const debtPrice = new Big(debtTokenReserve.price);
        const collateralPrice = new Big(collateralTokenReserve.price);

        // 1. Calculate the base collateral amount (without bonus)
        const baseCollateral = liquidatableDebtAmount
            .mul(debtPrice)
            .mul(10 ** collateralDecimals)
            .div(collateralPrice.mul(10 ** debtDecimals));

        // 2. Calculate the bonus amount
        const bonusAmount = baseCollateral
            .mul(liquidationBonus - 10000) // Subtract 100% to get just the bonus portion
            .div(10000);

        // 3. Calculate the protocol fee (applied only to the bonus portion)
        const protocolFeeAmount = bonusAmount
            .mul(liquidationProtocolFee)
            .div(10000);

        // 4. Calculate the total collateral received after protocol fee (in native units)
        const totalCollateralReceived = baseCollateral
            .add(bonusAmount)
            .sub(protocolFeeAmount);

        // 5. Convert collateral value to USD
        const collateralValueUSD = totalCollateralReceived
            .mul(collateralPrice)
            .div(10 ** collateralDecimals);

        // 6. Convert debt to USD for profit calculation
        const debtValueUSD = liquidatableDebtAmount
            .mul(debtPrice)
            .div(10 ** debtDecimals);

        // 6. Calculate gross profit in USD
        const grossProfitUSD = collateralValueUSD.sub(debtValueUSD);

        // 7. Calculate gas cost in USD with the appropriate multiplier
        // Initial calculation with base fee
        const wethReserve = _.find(_.values(aaveNetworkInfo.reserves), {
            symbol: "WETH",
        });
        const ethPriceUSD = new Big(wethReserve.price).div(
            10 ** wethReserve.decimals
        );
        const baseTxCostWei = new Big(
            aaveNetworkInfo.averageLiquidationGasUnits
        ).mul(aaveNetworkInfo.gasPrice);
        const baseTxCostUSD = baseTxCostWei
            .mul(ethPriceUSD)
            .div(10 ** wethReserve.decimals);

        // Apply fee tier based on gross profit
        const gasFeeMultiplier = grossProfitUSD.gt(new Big(100)) ? 10000 : 5000;
        const scaledGasMultiplier = new Big(gasFeeMultiplier).div(10000);
        const actualTxCostUSD = baseTxCostUSD.mul(scaledGasMultiplier);

        // 8. Calculate net profit in USD
        const netProfitUSD = grossProfitUSD.sub(actualTxCostUSD);

        // Return: [debtToCover in native units, profit in USD]
        return [
            liquidatableDebtAmount, // Amount of debt tokens to repay (native units)
            netProfitUSD, // Profit in USD
        ];
    }

    //#endregion calculateNetLiquidationReward

    //#region calculateTotalDebtBaseForAddress

    calculateTotalDebtBaseForAddress(address: string, aaveNetworkInfo: any) {
        const reserves = _.values(aaveNetworkInfo.reserves);
        const userReserves = aaveNetworkInfo.usersReserves[address];
        if (!userReserves || userReserves.length == 0) return 0;

        let debts = _.map(reserves, (reserve) => {
            const userReserve = _.find(userReserves, (o) => {
                return o.tokenAddress == reserve.address;
            });
            if (!userReserve) return null;
            return {
                price: reserve.price,
                address: reserve.address,
                balance:
                    userReserve.currentVariableDebt +
                    userReserve.currentStableDebt,
                decimals: reserve.decimals,
            };
        });

        debts = _.reject(debts, (o: any) => !o || o.balance == 0);
        if (!debts || debts.length == 0) return 0;
        return debts.reduce((total: any, debt: any) => {
            const { price, address, balance, decimals } = debt;
            const baseAmount = (balance * price) / 10 ** decimals;
            return total + baseAmount;
        }, 0);
    }

    //#endregion calculateTotalDebtBaseForAddress

    //#region calculateTotalCollateralBaseForAddress

    calculateTotalCollateralBaseForAddress(
        address: string,
        aaveNetworkInfo: any
    ) {
        const reserves = _.values(aaveNetworkInfo.reserves);
        const userReserves = aaveNetworkInfo.usersReserves[address];
        if (!userReserves || userReserves.length == 0) return 0;

        let collaterals = _.map(reserves, (reserve) => {
            const userReserve = _.find(userReserves, (o) => {
                return o.tokenAddress == reserve.address;
            });
            if (!userReserve) return null;
            return {
                price: reserve.price,
                address: reserve.address,
                balance: userReserve.currentATokenBalance,
                usageAsCollateralEnabled: userReserve.usageAsCollateralEnabled,
                decimals: reserve.decimals,
            };
        });

        collaterals = _.reject(
            collaterals,
            (o: any) => !o || !o.usageAsCollateralEnabled || o.balance == 0
        );
        if (!collaterals || collaterals.length == 0) return 0;
        const externalCollateral =
            aaveNetworkInfo.addressesObjects[address].externalCollateral ?? 0;
        return (
            externalCollateral +
            collaterals.reduce((total: any, debt: any) => {
                const { price, address, balance, decimals } = debt;
                const baseAmount = (balance * price) / 10 ** decimals;
                return total + baseAmount;
            }, 0)
        );
    }

    //#endregion calculateTotalCollateralBaseForAddress

    //#region calculateHealthFactorOffChain

    calculateHealthFactorOffChain(
        totalCollateralBase: number | Big,
        totalDebtBase: number | Big,
        currentLiquidationThreshold: number | Big
    ) {
        if (totalDebtBase == 0) return 0;
        const totalCollateralBaseBig = new Big(totalCollateralBase);
        const totalDebtBaseBig = new Big(totalDebtBase);
        const currentLiquidationThresholdBig = new Big(
            currentLiquidationThreshold
        ).div(10 ** 4);
        const healthFactor = totalCollateralBaseBig
            .times(currentLiquidationThresholdBig)
            .div(totalDebtBaseBig)
            .toNumber();
        return healthFactor;
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
