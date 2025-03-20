import _ from "lodash";
import sqlManager from "../managers/sqlManager";
import healthFactorCheckEngine from "./healthFactorCheckEngine";
import { ethers } from "ethers";

class WebhookEngine {
    addresses: any = {};
    uniqueAddresses: any = {};

    addAddressTreshold = 0;
    uniqueAddressesHF: any = {};

    ifaceBorrow: any;
    borrowEventAbi: string[] = [
        "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)",
    ];

    ifaceDeposit: any;
    depositEventAbi: string[] = [
        "event Deposit(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referral)",
    ];

    private static instance: WebhookEngine;
    private constructor() {}

    public static getInstance(): WebhookEngine {
        if (!WebhookEngine.instance) {
            WebhookEngine.instance = new WebhookEngine();
        }
        return WebhookEngine.instance;
    }

    //#region Alchemy Webhook

    getVariable(key: string) {
        return JSON.stringify((this as any)[key]);
    }

    async initializeProcessAaveEvent() {
        this.ifaceBorrow = new ethers.Interface(this.borrowEventAbi);
        this.ifaceDeposit = new ethers.Interface(this.depositEventAbi);

        const initAddresses = _.map(
            await sqlManager.execQuery("SELECT * FROM addresses"),
            "address"
        );

        for (const address of initAddresses) {
            if (!this.addresses.hasOwnProperty(address.chain))
                this.addresses[address.chain] = [];
            this.addresses[address.chain].push(address.address);
        }

        this.addresses = initAddresses;
    }

    async processAavePriceOracleEvent(req: any, res: any) {
        let block = req.body.event?.data?.block;
        let chain = req.query.chain ?? "eth";
        let chainEnv = req.query.chainEnv ?? "mainnet";
        //this.processAavePriceOracleEventBlock(block, chain, chainEnv);
        console.log(block);
    }

    async processAaveEvent(req: any, res: any) {
        let block = req.body.event?.data?.block;
        let chain = req.query.chain ?? "eth";
        let chainEnv = req.query.chainEnv ?? "mainnet";
        await this.processBlock(block, chain, chainEnv);
    }

    async processBlock(block: any, chain: string, chainEnv: string) {
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

                //Remove duplicates and empty addresses
                const uniqueAddresses: string[] = _.reject(
                    _.uniq(normalizedAddressesToAdd),
                    (normalizedAddress) => {
                        return (
                            _.isEmpty(normalizedAddress) ||
                            _.includes(this.addresses, normalizedAddress) ||
                            _.includes(this.uniqueAddresses, normalizedAddress)
                        );
                    }
                );

                if (uniqueAddresses.length > 0) {
                    const key = `${chain}-${chainEnv}`;
                    if (!this.uniqueAddresses.hasOwnProperty(key))
                        this.uniqueAddresses[key] = [];

                    this.uniqueAddresses[key] = _.uniq(
                        _.union(this.uniqueAddresses[key], uniqueAddresses)
                    );

                    if (!this.addresses.hasOwnProperty(key))
                        this.addresses[key] = [];

                    this.addresses[key] = _.uniq(
                        _.union(this.addresses[key], uniqueAddresses)
                    );

                    if (
                        this.uniqueAddresses[key].length >
                        this.addAddressTreshold
                    ) {
                        if (!this.uniqueAddressesHF.hasOwnProperty(key))
                            this.uniqueAddressesHF[key] = {};

                        for (const address of this.uniqueAddresses[key]) {
                            this.uniqueAddressesHF[key][address] =
                                await healthFactorCheckEngine.getUserHealthFactor(
                                    chain,
                                    chainEnv,
                                    address
                                );
                        }

                        //only save addresses with healthfactor < 5
                        let addressesListSql = this.uniqueAddresses[key].map(
                            (address: string) =>
                                this.uniqueAddressesHF[key][address] < 5
                                    ? `('${address}', '${key}', ${this.uniqueAddressesHF[key][address]})`
                                    : ""
                        );

                        addressesListSql = _.reject(
                            addressesListSql,
                            _.isEmpty
                        );

                        if (addressesListSql.length > 0) {
                            let query = `INSERT INTO addresses (address, chain, healthfactor) VALUES ${addressesListSql.join(
                                ","
                            )}`;
                            console.log(query);
                            await sqlManager.execQuery(query);
                        }

                        this.uniqueAddresses[key] = [];
                        this.uniqueAddressesHF[key] = [];
                    }
                }
            }
        }
    }

    normalizeAddress(address: string) {
        if (!address) return "";
        const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
        const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
        const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
        return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
    }

    //#endregion Alchemy Webhook
}

export default WebhookEngine.getInstance();
