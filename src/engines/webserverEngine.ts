import _ from "lodash";
import sqlManager from "../managers/sqlManager";
import { ethers } from "ethers";
import logger from "../shared/logger";
import Constants from "../shared/constants";
import serviceBusManager from "../managers/serviceBusManager";

class WebserverEngine {
    //#region variables

    //these are in the form of {network: [address1, address2, ...]}
    addresses: any = {};
    isInitialized: boolean = false;
    batchAddressesListSql: any = {};
    batchAddressesList: any = {};
    batchAddressesTreshold: number = 25;

    ifaceBorrow: any;
    ifaceDeposit: any;

    //#endregion variables

    private static instance: WebserverEngine;
    private constructor() {}

    public static getInstance(): WebserverEngine {
        if (!WebserverEngine.instance) {
            WebserverEngine.instance = new WebserverEngine();
        }
        return WebserverEngine.instance;
    }

    //#region Initialization

    async initialize() {
        if (this.isInitialized) return;

        await serviceBusManager.listenToMessages(async (message: any) => {
            console.log(message);
        });

        this.ifaceBorrow = new ethers.Interface(
            Constants.ABIS.BORROW_EVENT_ABI
        );
        this.ifaceDeposit = new ethers.Interface(
            Constants.ABIS.DEPOSIT_EVENT_ABI
        );

        const initAddresses = _.map(
            await sqlManager.execQuery("SELECT * FROM addresses"),
            "address"
        );

        for (const address of initAddresses) {
            if (!this.addresses.hasOwnProperty(address.network))
                this.addresses[address.network] = [];
            this.addresses[address.network].push(address.address);
        }

        this.isInitialized = true;
    }

    //#endregion Initialization

    //#region normalizeAddress

    normalizeAddress(address: string) {
        if (!address) return "";
        const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
        const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
        const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
        return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
    }

    //#endregion normalizeAddress

    //#region Alchemy Webhook "processAaveEvent"

    async processAaveEvent(req: any, res: any) {
        if (!this.isInitialized) return;
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
                //Deposit
                case "0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951":
                    const decodedLogDeposit = this.ifaceDeposit.parseLog(log);
                    const userDeposit = decodedLogDeposit.args.user;
                    if (userDeposit) addressesToAdd.push(userDeposit);
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //onBehalfOf The beneficiary of the deposit, receiving the aTokens
                    break;

                //Borrow
                case "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b":
                    const decodedLogBorrow = this.ifaceBorrow.parseLog(log);
                    const userBorrow = decodedLogBorrow.args.user;
                    if (userBorrow) addressesToAdd.push(userBorrow);
                    break;

                //Repay
                case "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051":
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The beneficiary of the repayment, getting his debt reduced
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //repayer The address of the user initiating the repay(), providing the funds
                    break;

                case "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": //Supply
                case "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": //ReserveUsedAsCollateralDisabled
                case "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": //ReserveUsedAsCollateralEnabled
                case "0x9f439ae0c81e41a04d3fdfe07aed54e6a179fb0db15be7702eb66fa8ef6f5300": //RebalanceStableBorrowRate
                case "0xea368a40e9570069bb8e6511d668293ad2e1f03b0d982431fd223de9f3b70ca6": //Swap
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                //Withdraw
                case "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7":
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address initiating the withdrawal, owner of aTokens
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //to Address that will receive the underlying
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
                    (address) => this.normalizeAddress(address)
                );

                //initialize the batchAddressesListSql array for this network
                //if it doesn't exist yet
                if (!this.batchAddressesListSql.hasOwnProperty(key)) {
                    this.batchAddressesListSql[key] = [];
                }
                if (!this.batchAddressesList.hasOwnProperty(key)) {
                    this.batchAddressesList[key] = [];
                }

                //Remove empty addresses or addresses already present in the DB or in the
                //current batch of addresses to be saved
                const uniqueAddresses: string[] = _.reject(
                    _.uniq(normalizedAddressesToAdd),
                    (normalizedAddress) => {
                        return (
                            _.isEmpty(normalizedAddress) ||
                            _.includes(
                                this.addresses[key],
                                normalizedAddress
                            ) ||
                            _.includes(
                                this.batchAddressesList[key],
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
                        if (!this.batchAddressesListSql.hasOwnProperty(key)) {
                            this.batchAddressesListSql[key] = [];
                        }
                        if (!this.addresses.hasOwnProperty(key))
                            this.addresses[key] = [];

                        this.batchAddressesListSql[key] = _.union(
                            this.batchAddressesListSql[key],
                            addressesListSql
                        );
                        this.batchAddressesList[key] = _.union(
                            this.batchAddressesList[key],
                            addressesList
                        );

                        if (
                            this.batchAddressesListSql[key].length >=
                            this.batchAddressesTreshold
                        ) {
                            let query = `
                            MERGE INTO addresses AS target
                            USING (VALUES 
                                ${this.batchAddressesListSql[key].join(",")}
                            ) AS source (address, network, healthFactor, addedon)
                            ON (target.address = source.address AND target.network = source.network)
                            WHEN NOT MATCHED BY TARGET THEN
                                INSERT (address, network, healthFactor, addedon)
                                VALUES (source.address, source.network, source.healthFactor, source.addedon);
                        `;

                            await sqlManager.execQuery(query);

                            await logger.log(
                                "Addresses added to the database: " +
                                    JSON.stringify(
                                        this.batchAddressesList[key]
                                    ),
                                "WebserverEngineProcessBlock"
                            );

                            this.batchAddressesListSql[key] = [];
                            this.batchAddressesList[key] = [];
                            this.addresses[key] = _.uniq(
                                _.union(this.addresses[key], uniqueAddresses)
                            );
                        }
                    }
                }
            }
        }
    }

    //#endregion Alchemy Webhook
}

export default WebserverEngine.getInstance();
