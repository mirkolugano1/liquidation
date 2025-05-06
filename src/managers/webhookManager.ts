import _ from "lodash";
import engine from "../engines/engine";
import common from "../shared/common";
import logger from "../shared/logger";
import repo from "../shared/repo";
import liquidationManager from "./liquidationManager";
import sqlManager from "./sqlManager";

class WebhookManager {
    private static instance: WebhookManager;

    public static getInstance(): WebhookManager {
        if (!WebhookManager.instance) {
            WebhookManager.instance = new WebhookManager();
        }
        return WebhookManager.instance;
    }

    private constructor() {}

    //#region #ProcessAaveEvent (Alchemy Webhook)

    async processAaveEvent(req: any, res: any) {
        if (!repo.isWebServerInitialized) return;
        let block = req.body.event?.data?.block;
        let network = req.query.network ?? "eth-mainnet";
        await this.processBlock(block, network);
    }

    async processBlock(block: any, network: string) {
        const key = network;
        for (let log of block.logs) {
            let topics = log.topics;
            let eventHash = topics[0];
            let addressesToAdd: string[] = [];
            let from = log.transaction?.from?.address;
            const addressesObjectsAddresses = _.map(
                repo.aave[key].addressesObjects,
                (o) => o.address
            );

            switch (eventHash) {
                case "0x9c369e2bdbd7c7a5b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f": //SwapBorrowRateMode
                    addressesToAdd.push(log.topics[2]);
                    break;

                case "0x121ca0f2b1a8b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f8f9": //UserEModeSet
                    addressesToAdd.push(log.topics[1]);
                    break;

                case "0xd3d8717c9c7a8b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f8f9": //BackUnbacked
                    addressesToAdd.push(log.topics[2]);
                    break;

                case "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9": //MintUnbacked
                    addressesToAdd.push(log.topics[3]); //onBehalfOf The address of the user
                    break;

                case "0xe6cd5d3f2cfd1bf39c09a4afc6cfbfbce2a3c2c5c9d64e7464b3a8b5c2eecb1e": //FlashLoan
                    const flashloanTarget = log.topics[1];
                    if (flashloanTarget) addressesToAdd.push(flashloanTarget);
                    const flashloanInitiator = log.topics[2];
                    if (flashloanInitiator)
                        addressesToAdd.push(flashloanInitiator);
                    break;

                case "0x9a2f48d3aa6146e0a0f4e8622b5ff4b9d90a3c4f5e9a3b69c8523e213f775bfe": //LiquidationCall
                    const decodedLogLiquidationCall =
                        repo.ifaceLiquidationCall.parseLog(log);
                    const userLiquidator =
                        decodedLogLiquidationCall.args.liquidator;
                    if (userLiquidator) addressesToAdd.push(userLiquidator);
                    const userLiquidated = log.topics[3];
                    addressesToAdd.push(userLiquidated); //liquidated user
                    const liquidationCollateralAsset = log.topics[1];
                    const liquidationDebtAsset = log.topics[2];
                    const liquidatedCollateralAmount =
                        decodedLogLiquidationCall.args
                            .liquidatedCollateralAmount;
                    const debtToCover =
                        decodedLogLiquidationCall.args.debtToCover;
                    const receiveAToken =
                        decodedLogLiquidationCall.args.receiveAToken;

                    if (addressesObjectsAddresses.includes(userLiquidated)) {
                        //detract the liquidated collateral amount from the user's collateral
                        repo.aave[key].usersReserves[userLiquidated][
                            liquidationCollateralAsset
                        ].currentATokenBalance -= liquidatedCollateralAmount;

                        //detract the debt to cover from the user's debt
                        if (
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt >= debtToCover
                        ) {
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt -= debtToCover;
                        } else {
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentVariableDebt -= debtToCover;
                        }

                        await engine.updateUserConfiguration(
                            userLiquidated,
                            key
                        );
                    }

                    if (addressesObjectsAddresses.includes(userLiquidator)) {
                        if (receiveAToken) {
                            //add the liquidated collateral amount to the liquidator's collateral
                            repo.aave[key].usersReserves[userLiquidator][
                                liquidationCollateralAsset
                            ].currentATokenBalance +=
                                liquidatedCollateralAmount;
                        }

                        //not necessary to check for liquidation, since collateral has increased
                        //not necessary to update userConfiguration. If reserve was already set as collateral,
                        //this does not change anyway.
                    }
                    break;

                //Deposit
                case "0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951":
                    const decodedLogDeposit = repo.ifaceDeposit.parseLog(log);
                    const userDeposit = decodedLogDeposit.args.user;
                    if (userDeposit) addressesToAdd.push(userDeposit);
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //onBehalfOf The beneficiary of the deposit, receiving the aTokens

                    const depositReserve = log.topics[1];
                    const depositAmount = decodedLogDeposit.args.amount;
                    const depositOnBehalfOf = log.topics[3];
                    if (
                        addressesObjectsAddresses.includes(depositOnBehalfOf) &&
                        liquidationManager.isReserveUsedAsCollateral(
                            repo.aave[key].addressesObjects[depositOnBehalfOf]
                                .userConfiguration,
                            depositReserve,
                            key
                        )
                    ) {
                        repo.aave[key].usersReserves[depositOnBehalfOf][
                            depositReserve
                        ].currentATokenBalance += depositAmount;
                    }
                    break;

                //Borrow
                case "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b":
                    const decodedLogBorrow = repo.ifaceBorrow.parseLog(log);
                    const borrowOnBehalfOf = log.topics[3];
                    const borrowReserve = log.topics[1];
                    const borrowedAmount = decodedLogBorrow.args.amount;
                    const borrowRateMode = decodedLogBorrow.args.borrowRateMode;

                    const userBorrow = decodedLogBorrow.args.user;
                    if (userBorrow) addressesToAdd.push(userBorrow);
                    if (borrowOnBehalfOf && borrowOnBehalfOf != userBorrow) {
                        addressesToAdd.push(borrowOnBehalfOf); //onBehalfOf The beneficiary of the borrow, receiving the aTokens
                    }

                    if (addressesObjectsAddresses.includes(borrowOnBehalfOf)) {
                        if (borrowRateMode == 1) {
                            repo.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentStableDebt += borrowedAmount;
                        } else {
                            repo.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentVariableDebt += borrowedAmount;
                        }

                        await liquidationManager.checkLiquidateAddresses(
                            borrowOnBehalfOf,
                            key
                        );
                    }

                    break;

                case "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": //Repay
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The beneficiary of the repayment, getting his debt reduced
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //repayer The address of the user initiating the repay(), providing the funds

                    const repayReserve = log.topics[1];
                    const decodedLogRepay = repo.ifaceRepay.parseLog(log);
                    const amountRepayed = decodedLogRepay.args.amount;
                    const useATokens = decodedLogRepay.args.useATokens;

                    //detract the amount repaid from the repayer's collateral
                    if (
                        addressesObjectsAddresses.includes(log.topics[3]) &&
                        useATokens
                    ) {
                        repo.aave[key].usersReserves[log.topics[3]][
                            repayReserve
                        ].currentATokenBalance -= amountRepayed;
                    }

                    //detract the repaid amount from the beneficiary's debt
                    if (addressesObjectsAddresses.includes(log.topics[2])) {
                        const address = log.topics[2];
                        const repayUserReserve =
                            repo.aave[key].usersReserves[address][repayReserve];

                        //I cannot know if the debt being repaid is stable or variable, since this info
                        //is not present in the Repay event. So I check the amount of the variable debt and
                        //evtl then even the stable debt, since in the end I am interested in the total debt
                        if (
                            repayUserReserve.currentStableDebt == 0 ||
                            repayUserReserve.currentVariableDebt >=
                                amountRepayed
                        ) {
                            repo.aave[key].usersReserves[address][
                                repayReserve
                            ].currentVariableDebt -= amountRepayed;
                        } else {
                            repo.aave[key].usersReserves[address][
                                repayReserve
                            ].currentStableDebt -= amountRepayed;
                        }

                        await liquidationManager.checkLiquidateAddresses(
                            address,
                            key
                        );
                        await engine.updateUserConfiguration(address, key);
                    }
                    break;

                case "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": //Supply
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    const decodedLogSupply = repo.ifaceSupply.parseLog(log);
                    const amount = decodedLogSupply.args.amount;
                    const onBehalfOf = log.topics[3];
                    const topicAddress = log.topics[2];
                    let address = topicAddress; //the actual beneficiary of the supply
                    if (onBehalfOf && onBehalfOf != topicAddress) {
                        address = onBehalfOf; //the actual beneficiary of the supply
                        addressesToAdd.push(onBehalfOf);
                    }
                    if (_.includes(addressesObjectsAddresses, address)) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            repo.aave[key].addressesObjects[address]
                                .userConfiguration;
                        if (
                            liquidationManager.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            )
                        ) {
                            repo.aave[key].usersReserves[address][
                                reserve
                            ].currentATokenBalance += amount;

                            if (
                                repo.aave[key].usersReserves[address][reserve]
                                    .usageAsCollateralEnabled
                            ) {
                                await liquidationManager.checkLiquidateAddresses(
                                    address,
                                    key
                                );
                                await engine.updateUserConfiguration(
                                    address,
                                    key
                                );
                            }
                        }
                    }

                    break;

                case "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": //ReserveUsedAsCollateralDisabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        repo.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = false;

                        await liquidationManager.checkLiquidateAddresses(
                            network,
                            address
                        );

                        const query = `UPDATE usersreserves SET usageAsCollateralEnabled = 0 WHERE address = '${address}' AND tokenAddress = '${reserve}' AND network = '${key}'`;
                        await sqlManager.execQuery(query);

                        await engine.updateUserConfiguration(address, key);
                    }

                    break;

                case "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": //ReserveUsedAsCollateralEnabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        repo.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = true;

                        await liquidationManager.checkLiquidateAddresses(
                            network,
                            address
                        );

                        const query = `UPDATE usersreserves SET usageAsCollateralEnabled = 1 WHERE address = '${address}' AND tokenAddress = '${reserve}' AND network = '${key}'`;
                        await sqlManager.execQuery(query);

                        await engine.updateUserConfiguration(address, key);
                    }

                    break;

                case "0x9f439ae0c81e41a04d3fdfe07aed54e6a179fb0db15be7702eb66fa8ef6f5300": //RebalanceStableBorrowRate
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                case "0xea368a40e9570069bb8e6511d668293ad2e1f03b0d982431fd223de9f3b70ca6": //Swap
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                case "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": //Withdraw
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address initiating the withdrawal, owner of aTokens
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //to Address that will receive the underlying

                    const decodedLogWithdraw = repo.ifaceWithdraw.parseLog(log);
                    const amountWithdrawn = decodedLogWithdraw.args.amount;
                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            repo.aave[key].addressesObjects[log.topics[2]]
                                .userConfiguration;
                        if (
                            liquidationManager.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            ) &&
                            repo.aave[key].usersReserves[log.topics[2]][reserve]
                                .usageAsCollateralEnabled
                        ) {
                            repo.aave[key].usersReserves[log.topics[2]][
                                reserve
                            ].currentATokenBalance -= amountWithdrawn;

                            await liquidationManager.checkLiquidateAddresses(
                                log.topics[2],
                                key
                            );
                            await engine.updateUserConfiguration(
                                log.topics[2],
                                key
                            );
                        }
                    }
                    break;

                default:
                    return;
            }

            if (addressesToAdd.length > 0) {
                //the "from" address is the one that initiated the transaction
                //and should be added only if it was part of one of the relevant events
                if (from) addressesToAdd.push(from);

                //normalize addresses
                let normalizedAddressesToAdd = _.map(
                    addressesToAdd,
                    (address) => common.normalizeAddress(address)
                );

                //initialize the batchAddressesListSql array for this network
                //if it doesn't exist yet
                if (!repo.aave[key].hasOwnProperty("batchAddressesListSql")) {
                    repo.aave[key].batchAddressesListSql = [];
                }
                if (!repo.aave[key].hasOwnProperty("batchAddressesList")) {
                    repo.aave[key].batchAddressesList[key] = [];
                }

                //Remove empty addresses or addresses already present in the DB or in the
                //current batch of addresses to be saved
                const uniqueAddresses: string[] = _.reject(
                    _.uniq(normalizedAddressesToAdd),
                    (normalizedAddress) => {
                        return (
                            _.isEmpty(normalizedAddress) ||
                            _.includes(
                                repo.aave[key].addresses,
                                normalizedAddress
                            ) ||
                            _.includes(
                                repo.aave[key].batchAddressesList,
                                normalizedAddress
                            )
                        );
                    }
                );

                //if there are any unique addresses to add, get their health factor and user configuration
                if (uniqueAddresses.length > 0) {
                    let addressesListSql: string[] = [];
                    let addressesList: string[] = [];

                    for (const address of uniqueAddresses) {
                        addressesListSql.push(
                            `('${address}', '${key}', null, GETDATE())`
                        );
                        addressesList.push(address);
                    }

                    //if there are addresses with healthFactor < 2
                    //add them to the batchAddressesListSql array for this network
                    //to be monitored and saved in the database
                    if (addressesListSql.length > 0) {
                        if (
                            !repo.aave[key].hasOwnProperty(
                                "batchAddressesListSql"
                            )
                        ) {
                            repo.aave[key].batchAddressesListSql = [];
                        }
                        if (!repo.aave[key].hasOwnProperty("addresses"))
                            repo.aave[key].addresses = [];

                        repo.aave[key].batchAddressesListSql = _.union(
                            repo.aave[key].batchAddressesListSql,
                            addressesListSql
                        );
                        repo.aave[key].batchAddressesList = _.union(
                            repo.aave[key].batchAddressesList,
                            addressesList
                        );

                        if (
                            repo.aave[key].batchAddressesListSql.length >=
                            repo.batchAddressesTreshold
                        ) {
                            let query = `
                                MERGE INTO addresses AS target
                                USING (VALUES 
                                    ${repo.aave[key].batchAddressesList.join(
                                        ","
                                    )}
                                ) AS source (address, network, healthFactor, addedOn)
                                ON (target.address = source.address AND target.network = source.network)
                                WHEN NOT MATCHED BY TARGET THEN
                                    INSERT (address, network, healthFactor, addedOn)
                                    VALUES (source.address, source.network, source.healthFactor, source.addedOn);
                            `;

                            await sqlManager.execQuery(query);

                            await logger.log(
                                "Addresses added to the database: " +
                                    JSON.stringify(
                                        repo.aave[key].batchAddressesList
                                    ),
                                "WebserverEngineProcessBlock"
                            );

                            repo.aave[key].batchAddressesListSql = [];
                            repo.aave[key].batchAddressesList = [];
                            repo.aave[key].addresses = _.uniq(
                                _.union(
                                    repo.aave[key].addresses,
                                    uniqueAddresses
                                )
                            );
                        }
                    }
                }
            }
        }
    }

    //#endregion processAaveEvent (Alchemy Webhook)
}
export default WebhookManager.getInstance();
