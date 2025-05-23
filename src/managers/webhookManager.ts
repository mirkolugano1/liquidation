import _ from "lodash";
import engine from "../engines/engine";
import common from "../shared/common";
import logger from "../shared/logger";
import repo from "../shared/repo";
import liquidationManager from "./liquidationManager";
import sqlManager from "./sqlManager";
import moment from "moment";
import { LoggingFramework, LogType } from "../shared/enums";

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
                    break;

                //Deposit
                case "0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951":
                    const decodedLogDeposit = repo.ifaceDeposit.parseLog(log);
                    const userDeposit = decodedLogDeposit.args.user;
                    if (userDeposit) addressesToAdd.push(userDeposit);
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //onBehalfOf The beneficiary of the deposit, receiving the aTokens
                    break;

                //Borrow
                case "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b":
                    const decodedLogBorrow = repo.ifaceBorrow.parseLog(log);
                    const borrowOnBehalfOf = log.topics[3];
                    const userBorrow = decodedLogBorrow.args.user;
                    if (userBorrow) addressesToAdd.push(userBorrow);
                    if (borrowOnBehalfOf && borrowOnBehalfOf != userBorrow) {
                        addressesToAdd.push(borrowOnBehalfOf); //onBehalfOf The beneficiary of the borrow, receiving the aTokens
                    }
                    break;

                case "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": //Repay
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The beneficiary of the repayment, getting his debt reduced
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //repayer The address of the user initiating the repay(), providing the funds
                    break;

                case "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": //Supply
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    const onBehalfOf = log.topics[3];
                    const topicAddress = log.topics[2];
                    if (onBehalfOf && onBehalfOf != topicAddress) {
                        addressesToAdd.push(onBehalfOf);
                    }
                    break;

                case "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": //ReserveUsedAsCollateralDisabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                case "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": //ReserveUsedAsCollateralEnabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
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
                    break;

                default:
                    return;
            }

            await engine.syncInMemoryData(block, true, network);

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
                } //mirko
                if (!repo.aave[key].hasOwnProperty("batchAddressesList")) {
                    repo.aave[key].batchAddressesList = [];
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
                            `('${address}', '${key}', null, GETUTCDATE())`
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
                                    ${repo.aave[key].batchAddressesListSql.join(
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
