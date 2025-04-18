import common from "../shared/common";
import _ from "lodash";
import moment from "moment";
import encryption from "../managers/encryptionManager";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";
import emailManager from "../managers/emailManager";
import axios from "axios";

class Engine {
    private static instance: Engine;
    private constructor() {}

    public static getInstance(): Engine {
        if (!Engine.instance) {
            Engine.instance = new Engine();
        }
        return Engine.instance;
    }

    //#region Initialization

    async initializeWebServer() {
        if (this.isWebServerInitialized) return;

        this.webappUrl = await common.getAppSetting("WEBAPPURL");

        this.ifaceBorrow = new ethers.Interface(
            Constants.ABIS.BORROW_EVENT_ABI
        );
        this.ifaceDeposit = new ethers.Interface(
            Constants.ABIS.DEPOSIT_EVENT_ABI
        );

        await this.initializeAlchemy();
        await this.initializeAddresses();
        await this.initializeReserves();
        await this.initializeUsersReserves();

        this.isWebServerInitialized = true;
    }

    async initializeAddresses() {
        const initAddresses = _.map(
            await sqlManager.execQuery("SELECT * FROM addresses"),
            "address"
        );

        for (const address of initAddresses) {
            if (!this.aave[address.network].hasOwnProperty("addresses"))
                this.aave[address.network] = [];
            this.aave[address.network].push(address.address);
        }
    }

    async initializeUsersReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        const _key = network ? this.getAaveNetworkString(network) : null;
        let query = `SELECT * FROM usersreserves`;
        if (_key) query += ` WHERE network = '${_key}'`;
        const dbUsersReserves = await sqlManager.execQuery(query);
        if (!dbUsersReserves || dbUsersReserves.length == 0) {
            await logger.log(
                "No reserves found in DB. Please run the updateReservesData function first.",
                "functionAppExecution"
            );
            return;
        }

        let usersReserves: any = {};
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            if (_key && key != _key) continue;

            const networkUsersReserves = _.filter(dbUsersReserves, {
                network: key,
            });
            for (let networkUserReserves of networkUsersReserves) {
                if (!usersReserves[networkUserReserves.address])
                    usersReserves[networkUserReserves.address] = {};
                usersReserves[networkUserReserves.address][
                    networkUserReserves.tokenaddress
                ] = networkUserReserves;
            }
            this.aave[key] = _.assign(aaveNetworkInfo, {
                usersReserves: usersReserves,
            });
        }
    }

    async initializeReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        const _key = network ? this.getAaveNetworkString(network) : null;
        let query = `SELECT * FROM reserves ORDER BY sorting`;
        if (_key) query += ` WHERE network = '${_key}'`;
        const dbReserves = await sqlManager.execQuery(query);
        if (!dbReserves || dbReserves.length == 0) {
            await logger.log(
                "No reserves found in DB. Please run the updateReservesData function first.",
                "functionAppExecution"
            );
            return;
        }

        let reserves: any = {};
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            if (_key && key != _key) continue;

            const networkReserves = _.filter(dbReserves, { network: key });
            for (let networkReserve of networkReserves) {
                reserves[networkReserve.address] = networkReserve;
            }
            this.aave[key] = _.assign(aaveNetworkInfo, { reserves: reserves });
        }
    }

    async initializeAlchemy() {
        if (this.aave) return;
        this.aave = {};

        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );

        if (!alchemyKey) {
            await logger.log(
                "No Alchemy key found. Please set the ALCHEMYKEYENCRYPTED environment variable.",
                "functionAppExecution"
            );
            return;
        }

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);

            const config = {
                apiKey: alchemyKey, // Replace with your API key
                network: aaveNetworkInfo.network,
            };
            const alchemy = new Alchemy(config);
            const alchemyProvider = await alchemy.config.getProvider();

            let networkInfo: any = _.assign(aaveNetworkInfo, {
                alchemy: alchemy,
                alchemyProvider: alchemyProvider,
            });

            this.aave[key] = networkInfo;

            const addresses = await this.multicall(
                aaveNetworkInfo.addresses.poolAddressesProvider,
                null,
                "ADDRESSES_PROVIDER_ABI",
                ["getPoolDataProvider", "getPriceOracle", "getPool"],
                aaveNetworkInfo.network
            );

            if (!addresses) {
                await logger.log(
                    `No addresses found for network ${this.getAaveNetworkString(
                        aaveNetworkInfo
                    )}`,
                    "functionAppExecution"
                );
                return;
            }

            networkInfo.addresses.poolDataProvider = addresses[0]?.toString();
            networkInfo.addresses.aaveOracle = addresses[1]?.toString();
            networkInfo.addresses.pool = addresses[2]?.toString();
        }
    }

    //#endregion Initialization

    //#region Variables

    aave: any;
    contractInterfaces: any = {};

    webappUrl: string = "";
    isWebServerInitialized: boolean = false;
    batchAddressesTreshold: number = 25;

    ifaceBorrow: any;
    ifaceDeposit: any;

    //#endregion Variables

    //#region Helper methods

    normalizeAddress(address: string) {
        if (!address) return "";
        const addressWithoutPrefix = address.slice(2); // Remove the "0x" prefix
        const firstNonZeroIndex = addressWithoutPrefix.search(/[^0]/); // Find the index of the first non-zero character
        const normalized = addressWithoutPrefix.slice(firstNonZeroIndex); // Slice from the first non-zero character to the end
        return "0x" + normalized.padStart(40, "0"); // Ensure the address is 40 characters long by padding with zeros if necessary
    }

    setCloseEvent() {
        process.on("SIGINT", async () => {
            console.log("Closing...");
            await sqlManager.closePool();
            process.exit(0);
        });
    }

    calculateTotalDebtBaseForAddress(address: string, network: Network) {
        const networkInfo = this.getAaveNetworkInfo(network);
        const reserves = _.values(networkInfo.reserves);
        const userReserves = networkInfo.usersReserves[address];
        if (!userReserves || userReserves.length == 0) return 0;

        let debts = _.map(reserves, (reserve) => {
            const userReserve = _.find(userReserves, (o) => {
                return o.tokenaddress == reserve.address;
            });
            if (!userReserve) return null;
            return {
                price: reserve.price,
                address: reserve.address,
                balance:
                    userReserve.currentvariabledebt +
                    userReserve.currentstabledebt,
                decimals: reserve.decimals,
            };
        });

        debts = _.reject(debts, (o: any) => o.balance == 0);
        if (!debts || debts.length == 0) return 0;
        return debts.reduce((total: any, debt: any) => {
            const { price, address, balance, decimals } = debt;
            const baseAmount = (balance * price) / 10 ** decimals;
            return total + baseAmount;
        }, 0);
    }

    getAaveNetworkString(aaveNetworkInfo: any) {
        return aaveNetworkInfo.hasOwnProperty("network")
            ? aaveNetworkInfo.network.toString()
            : aaveNetworkInfo.toString();
    }

    async saveChanges(type: string, network: string, changes: any = null) {
        const timestamp = moment.utc().format("YYYY-MM-DD HH:mm:ss");
        const query = `INSERT INTO changes (network, timestamp, data, type) VALUES ('${network}', '${timestamp}', '${JSON.stringify(
            changes
        )}', '${type}')`;
        await sqlManager.execQuery(query);

        //notify the webapp about the changes
        await this.callLoadChanges(timestamp, network);
    }

    async callLoadChanges(timestamp: string, network: string) {
        try {
            await axios.get(
                `${this.webappUrl}/loadChanges?timestamp=${timestamp}&network=${network}`
            );
        } catch (error) {
            await logger.log(`Error calling loadChanges: ${error}`, "error");
        }
    }

    async loadChanges(req: any) {
        const timestamp = req.query?.timestamp;
        let network = req.query.network ?? "eth-mainnet";

        const changes = await sqlManager.execQuery(`
            SELECT * FROM changes WHERE network = '${network}' AND timestamp >= '${timestamp}' ORDER BY timestamp DESC`);

        let alreadyUpdatedReserves = false;
        let alreadyUpdatedUsersReserves = false;
        let alreadyUpdatedPrices = false;
        if (changes.length > 0) {
            for (const change of changes) {
                switch (change.type) {
                    case "updateReserves":
                        if (alreadyUpdatedReserves) continue;
                        await this.initializeReserves(network);
                        alreadyUpdatedReserves = true;
                        break;
                    case "updateUsersReserves":
                        if (alreadyUpdatedUsersReserves) continue;
                        await this.initializeUsersReserves(network);
                        alreadyUpdatedUsersReserves = true;
                        break;
                    case "updatePrices":
                        if (alreadyUpdatedPrices) continue;
                        await this.updatePrices(change, network);
                        alreadyUpdatedPrices = true;
                    default:
                        break;
                }
            }
        }
    }

    updatePrices(reservesChangedCheck: any, network: string) {
        const networkInfo = this.aave[network];
        const addressesDb = this.aave[network].addresses;

        //define object (map) of user assets that have the changed reserves either as collateral or as debt
        //userAssets: {address: {collateral: [reserves], debt: [reserves]}}
        let userAssets: any = {};

        //loop through loaded addresses from DB
        for (const addressRecord of addressesDb) {
            //loop through reserves
            for (let reserveChangedCheck of reservesChangedCheck) {
                //if reserve price has not changed, we skip it
                if (reserveChangedCheck.check != "none") {
                    if (reserveChangedCheck.check == "debt") {
                        if (!userAssets.hasOwnProperty(addressRecord.address))
                            userAssets[addressRecord.address] = {};
                        if (
                            !userAssets[addressRecord.address].hasOwnProperty(
                                "debt"
                            )
                        )
                            userAssets[addressRecord.address].debt = [];

                        userAssets[addressRecord.address].debt.push(
                            reserveChangedCheck.reserve
                        );
                    } else if (reserveChangedCheck.check == "collateral") {
                        if (!userAssets.hasOwnProperty(addressRecord.address))
                            userAssets[addressRecord.address] = {};
                        if (
                            !userAssets[addressRecord.address].hasOwnProperty(
                                "collateral"
                            )
                        )
                            userAssets[addressRecord.address].collateral = [];

                        userAssets[addressRecord.address].collateral.push(
                            reserveChangedCheck.reserve
                        );
                    }
                }
            }
        }

        //get list of addresses for which to check health factor from the userAssets object
        const addressesToCheck = Object.keys(userAssets);

        this.checkLiquidateAddresses(
            addressesToCheck,
            networkInfo.network,
            userAssets
        );
    }

    //#region Alchemy Webhook "processAaveEvent"

    async processAaveEvent(req: any, res: any) {
        if (!this.isWebServerInitialized) return;
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
                if (!this.aave[key].hasOwnProperty("batchAddressesListSql")) {
                    this.aave[key].batchAddressesListSql = [];
                }
                if (!this.aave[key].hasOwnProperty("batchAddressesList")) {
                    this.aave[key].batchAddressesList[key] = [];
                }

                //Remove empty addresses or addresses already present in the DB or in the
                //current batch of addresses to be saved
                const uniqueAddresses: string[] = _.reject(
                    _.uniq(normalizedAddressesToAdd),
                    (normalizedAddress) => {
                        return (
                            _.isEmpty(normalizedAddress) ||
                            _.includes(
                                this.aave[key].addresses,
                                normalizedAddress
                            ) ||
                            _.includes(
                                this.aave[key].batchAddressesList,
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
                            !this.aave[key].hasOwnProperty(
                                "batchAddressesListSql"
                            )
                        ) {
                            this.aave[key].batchAddressesListSql = [];
                        }
                        if (!this.aave[key].hasOwnProperty("addresses"))
                            this.aave[key].addresses = [];

                        this.aave[key].batchAddressesListSql = _.union(
                            this.aave[key].batchAddressesListSql,
                            addressesListSql
                        );
                        this.aave[key].batchAddressesList = _.union(
                            this.aave[key].batchAddressesList,
                            addressesList
                        );

                        if (
                            this.aave[key].batchAddressesListSql.length >=
                            this.batchAddressesTreshold
                        ) {
                            let query = `
                            MERGE INTO addresses AS target
                            USING (VALUES 
                                ${this.aave[key].batchAddressesList.join(",")}
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
                                        this.aave[key].batchAddressesList
                                    ),
                                "WebserverEngineProcessBlock"
                            );

                            this.aave[key].batchAddressesListSql = [];
                            this.aave[key].batchAddressesList = [];
                            this.aave[key].addresses = _.uniq(
                                _.union(
                                    this.aave[key].addresses,
                                    uniqueAddresses
                                )
                            );
                        }
                    }
                }
            }
        }
    }

    //#endregion Alchemy Webhook

    /**
     * TODO Decide which asset pair to liquidate for a given user
     *
     * @param address
     * @param assets is an object with two arrays: collateral and debt
     * @returns Array of asset pair to liquidate [collateralAsset, debtAsset]
     */
    async decideWhichAssetPairToLiquidate(address: any, assets: any) {
        //TODO how to decide which asset pair to liquidate?
        //TODO: check if the liquidation is profitable otherwise skip it

        const userCollateralAssets = assets.collateral;
        const userDebtAssets = assets.debt;

        /*
        // Iterate through each reserve and get user data
        for (const reserve of reservesList) {
            const reserveData = await this.poolContract.getReserveData(
                reserve
            );

            // Check user's balances for the collateral and debt tokens
            const aTokenContract = new ethers.Contract(
                reserveData.aTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );
            const stableDebtTokenContract = new ethers.Contract(
                reserveData.stableDebtTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );
            const variableDebtTokenContract = new ethers.Contract(
                reserveData.variableDebtTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );

            const aTokenBalance = await aTokenContract.balanceOf(address);
            const stableDebtBalance = await stableDebtTokenContract.balanceOf(
                address
            );
            const variableDebtBalance =
                await variableDebtTokenContract.balanceOf(address);

            return {
                collateralAsset: "",
                debtAsset: "",
            };
        }
            */
        return ["", ""];
    }

    getHealthFactorOffChain(
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

    async getUserAccountDataForAddresses(
        _addresses: string[],
        network: Network
    ) {
        if (!_addresses || _addresses.length == 0) return [];
        const networkInfo = await this.getAaveNetworkInfo(network);

        const userAccountData = await this.multicall(
            networkInfo.addresses.pool,
            _addresses,
            "POOL_ABI",
            "getUserAccountData",
            network
        );

        //check immediately after retrieving userAccountData if the health factor is less than 1, liquidate concerned addresses
        let liquidateHealthFactorAddresses: string[] = [];
        let userAccountObjects: any[] = [];
        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            const healthFactor = this.getHealthFactorFromUserAccountData(
                userAccountData[i]
            );
            const totalCollateralBase = userAccountData[i][0].toString();
            const totalDebtBase = userAccountData[i][1].toString();
            const currentLiquidationThreshold =
                userAccountData[i][3].toString();
            userAccountObjects.push({
                address: address,
                network: network,
                healthFactor: healthFactor,
                currentLiquidationThreshold: currentLiquidationThreshold,
                totalCollateralBase: totalCollateralBase,
                totalDebtBase: totalDebtBase,
            });
            if (healthFactor < 1) {
                liquidateHealthFactorAddresses.push(address);
            }
        }

        await this.checkLiquidateAddresses(
            liquidateHealthFactorAddresses,
            network
        );

        return userAccountObjects;
    }

    async multicallEstimateGas(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ) {
        const estimate = await this.multicall(
            targetAddresses,
            paramAddresses,
            contractABIsKeys,
            methodNames,
            network,
            true
        );
        return Number(estimate);
    }

    checkMulticallInputs(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ): [string[], string[], string[], string[]] {
        if (!network) throw new Error("No network provided");
        if (!paramAddresses) paramAddresses = [];

        if (!targetAddresses || targetAddresses.length == 0)
            throw new Error("No targetAddresses provided");

        if (!Array.isArray(targetAddresses))
            targetAddresses = [targetAddresses];

        if (!Array.isArray(methodNames)) methodNames = [methodNames];

        if (targetAddresses.length == 1 && paramAddresses.length > 1) {
            for (let i = 1; i < paramAddresses.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        } else if (targetAddresses.length == 1 && methodNames.length > 1) {
            for (let i = 1; i < methodNames.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        }

        if (!Array.isArray(paramAddresses)) paramAddresses = [paramAddresses];

        if (
            paramAddresses.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                paramAddresses.push(paramAddresses[0]);
            }
        }

        if (
            paramAddresses.length > 0 &&
            targetAddresses.length != paramAddresses.length
        ) {
            throw new Error(
                "targetAddresses and paramAddresses length mismatch"
            );
        }

        if (!methodNames || methodNames.length == 0)
            throw new Error("No methodNames provided");

        if (
            methodNames.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                methodNames.push(methodNames[0]);
            }
        }

        if (targetAddresses.length != methodNames.length) {
            throw new Error("targetAddresses and methodNames length mismatch");
        }

        if (!contractABIsKeys || contractABIsKeys.length == 0)
            throw new Error("No contractABIs provided");

        if (!Array.isArray(contractABIsKeys))
            contractABIsKeys = [contractABIsKeys];

        if (
            contractABIsKeys.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                contractABIsKeys.push(contractABIsKeys[0]);
            }
        }

        if (targetAddresses.length != contractABIsKeys.length) {
            throw new Error("targetAddresses and contractABIs length mismatch");
        }

        return [targetAddresses, paramAddresses, contractABIsKeys, methodNames];
    }

    getContractInterface(contractABI: any) {
        if (!contractABI) throw new Error("No contractABI provided");
        const contractABIString = JSON.stringify(contractABI);

        if (!this.contractInterfaces[contractABIString]) {
            this.contractInterfaces[contractABIString] = new ethers.Interface(
                contractABI
            );
        }
        return this.contractInterfaces[contractABIString];
    }

    /**
     * Batches multiple calls to a smartContract using the Multicall3 contract.
     *
     * @param targetAddresses the smartContract addresses(es) to call the method on
     * @param paramAddresses the method parameters for each smartContract address
     * @param contractABI the smartContract ABI of the function to be called
     * @param methodName the method name to be called
     * @param network the blockchain network from the AlchemySDK e.g. Network.ETH_MAINNET
     * @returns
     */
    async multicall(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network,
        estimateGas: boolean = false
    ) {
        [targetAddresses, paramAddresses, contractABIsKeys, methodNames] =
            this.checkMulticallInputs(
                targetAddresses,
                paramAddresses,
                contractABIsKeys,
                methodNames,
                network
            );

        const multicallContract = this.getContract(
            Constants.MULTICALL3_ADDRESS,
            Constants.ABIS.MULTICALL3_ABI,
            network
        );

        const calls = _.map(
            targetAddresses,
            (targetAddress: string, index: number) => {
                const contractInterface = this.getContractInterface(
                    Constants.ABIS[contractABIsKeys[index]]
                );
                const calldata =
                    !paramAddresses || paramAddresses.length == 0
                        ? contractInterface.encodeFunctionData(
                              methodNames[index]
                          )
                        : contractInterface.encodeFunctionData(
                              methodNames[index],
                              Array.isArray(paramAddresses[index])
                                  ? paramAddresses[index]
                                  : [paramAddresses[index]]
                          );
                return {
                    target: targetAddress,
                    callData: calldata,
                };
            }
        );

        if (estimateGas) {
            const aaveNetworkInfo = this.getAaveNetworkInfo(network);
            return await aaveNetworkInfo.alchemyProvider.estimateGas(calls);
        }

        // Split into chunks of 1000 or fewer calls
        const callBatches = _.chunk(calls, Constants.CHUNK_SIZE);

        // Create a tracking array to map chunk results back to original indices
        const callIndices = Array.from({ length: calls.length }, (_, i) => i);
        const indexBatches = _.chunk(callIndices, Constants.CHUNK_SIZE);

        // Execute each chunk
        const chunkPromises = callBatches.map(async (callBatch) => {
            return multicallContract.aggregate(callBatch);
        });

        const chunkResults = await Promise.all(chunkPromises);

        // Process results from each chunk
        const allDecodedResults = [];

        for (
            let chunkIndex = 0;
            chunkIndex < chunkResults.length;
            chunkIndex++
        ) {
            const [blockNumber, chunkReturnData] = chunkResults[chunkIndex];
            const originalIndices = indexBatches[chunkIndex];

            // Decode each result in this chunk
            for (let i = 0; i < chunkReturnData.length; i++) {
                const originalIndex = originalIndices[i];
                const contractInterface = this.getContractInterface(
                    Constants.ABIS[contractABIsKeys[originalIndex]]
                );

                const decodedResult = contractInterface.decodeFunctionResult(
                    methodNames[originalIndex],
                    chunkReturnData[i]
                );

                // Store at the original position to maintain order
                allDecodedResults[originalIndex] = decodedResult;
            }
        }

        return allDecodedResults;
    }

    getAaveNetworkInfo(network: Network) {
        if (!network) throw new Error("No network provided");
        const key = this.getAaveNetworkString(network);
        let obj = this.aave[key];
        if (!obj) {
            throw new Error(`Aave network info not found for network ${key}`);
        }
        return obj;
    }

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    getContract(address: string, contractAbi: any, network: Network) {
        const networkInfo = this.getAaveNetworkInfo(network);
        return new ethers.Contract(
            address,
            contractAbi,
            networkInfo.alchemyProvider
        );
    }

    async checkLiquidateAddresses(
        addresses: string[],
        network: Network,
        userAssets: any = null
    ) {
        if (addresses.length > 0) {
            //TODO check if there are profitable liquidation opportunities
            const profitableLiquidationAddresses = [];
            const aaveNetworkInfo = this.getAaveNetworkInfo(network);
            const reserves = aaveNetworkInfo.reserves;
            const userReserves = aaveNetworkInfo.usersReserves;
            /*
            //decide which asset pair to liquidate for the user based on the userAssets collateral and debt properties
            const assetsToLiquidate: string[] =
                await this.decideWhichAssetPairToLiquidate(
                    addresses[0],
                    userReserves[addresses[0]]
                );
*/
            if (profitableLiquidationAddresses.length > 0) {
                await emailManager.sendLogEmail(
                    "Liquidation triggered",
                    "Addresses: " + addresses.join(", ")
                );
                //TODO MIRKO implement liquidation logic
                // const aaveNetworkInfo = this.getAaveNetworkInfo(network);
                // const poolContract = this.getContract(
                //     aaveNetworkInfo.addresses.pool,
                //     Constants.ABIS.POOL_ABI,
                //     network
                // );
            }
        }
    }

    //#endregion Helper methods

    //#region Scheduled azure functions

    /**
     * This method should be scheduled to run every day at midnight, since data does should change very often
     *
     * Periodically update the reserves data in the DB
     *
     * @param context the InvocationContext of the function app on azure (for Application Insights)
     */
    async updateReservesData(context: InvocationContext | null = null) {
        //#region initialization

        logger.initialize(
            "function:updateReservesData",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log("Start updateReservesData", "functionAppExecution");
        await this.initializeAlchemy();

        //#endregion initialization

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);

            const results = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                null,
                "POOL_DATA_PROVIDER_ABI",
                "getAllReservesTokens",
                aaveNetworkInfo.network
            );

            const allReserveTokens: any[] = _.map(results[0][0], (o) => {
                return {
                    network: key,
                    symbol: o[0].toString(),
                    address: o[1].toString(),
                };
            });

            const reserveTokenAddresses = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                _.map(allReserveTokens, (o) => o.address),
                "POOL_DATA_PROVIDER_ABI",
                "getReserveTokensAddresses",
                aaveNetworkInfo.network
            );

            //const reserveTokenAddresses = results[1][0];
            for (let i = 0; i < reserveTokenAddresses.length; i++) {
                allReserveTokens[i].atokenaddress =
                    reserveTokenAddresses[i][0].toString();
                allReserveTokens[i].stabledebttokenaddress =
                    reserveTokenAddresses[i][1].toString();
                allReserveTokens[i].variabledebttokenaddress =
                    reserveTokenAddresses[i][2].toString();
            }

            const allReserveTokensAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const reservesData1 = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveData",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesData1.length; i++) {
                allReserveTokens[i].liquidityindex =
                    reservesData1[i][9].toString();
                allReserveTokens[i].variableborrowindex =
                    reservesData1[i][10].toString();
                allReserveTokens[i].liquidityrate =
                    reservesData1[i][5].toString();
                allReserveTokens[i].variableborrowrate =
                    reservesData1[i][6].toString();
                allReserveTokens[i].totalstabledebt =
                    reservesData1[i][3].toString();
                allReserveTokens[i].lastupdatetimestamp =
                    reservesData1[i][11].toString();
                allReserveTokens[i].totalvariabledebt =
                    reservesData1[i][4].toString();
            }

            const reservesConfigData1 = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveConfigurationData",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesConfigData1.length; i++) {
                allReserveTokens[i].decimals = reservesConfigData1[i][0];
                allReserveTokens[i].ltv = reservesConfigData1[i][1].toString();
                allReserveTokens[i].reserveliquidationthreshold =
                    reservesConfigData1[i][2].toString();
                allReserveTokens[i].reserveliquidationbonus =
                    reservesConfigData1[i][3].toString();
                allReserveTokens[i].reservefactor =
                    reservesConfigData1[i][4].toString();
                allReserveTokens[i].usageascollateralenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][5]);
                allReserveTokens[i].borrowingenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][6]);
                allReserveTokens[i].stableborrowrateenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][7]);
                allReserveTokens[i].isactive = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][8]
                );
                allReserveTokens[i].isfrozen = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][9]
                );
            }

            //check if there are reserves in the DB which are not in the reservesList
            //and in case delete them from the DB
            const fetchedReservesAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            //delete reserves and usersreserves data where token address is not in the reserves list
            const sqlQueryDelete = `DELETE FROM usersreserves WHERE tokenaddress NOT IN ('${fetchedReservesAddresses.join(
                "','"
            )}') AND network = '${key}';`;
            await sqlManager.execQuery(sqlQueryDelete);

            const sqlQuery = `DELETE FROM reserves WHERE address NOT IN ('${fetchedReservesAddresses.join(
                "','"
            )}') AND network = '${key}';`;
            await sqlManager.execQuery(sqlQuery);

            //prepare query to update reserves list in DB
            //and update DB
            let reservesSQLList: string[] = _.map(
                allReserveTokens,
                (o, index) => {
                    return `('${o.address}', '${key}', '${o.symbol}', ${
                        o.decimals
                    }, '${o.reserveliquidationthreshold}', '${
                        o.reserveliquidationbonus
                    }', '${o.reservefactor}', ${
                        o.usageascollateralenabled
                    }, ${sqlManager.getBitFromBoolean(
                        o.borrowingenabled
                    )}, ${sqlManager.getBitFromBoolean(
                        o.stableborrowrateenabled
                    )}, ${sqlManager.getBitFromBoolean(
                        o.isactive
                    )}, ${sqlManager.getBitFromBoolean(o.isfrozen)}, '${
                        o.liquidityindex
                    }', '${o.variableborrowindex}', '${o.liquidityrate}', '${
                        o.variableborrowrate
                    }', '${o.lastupdatetimestamp}', '${o.atokenaddress}','${
                        o.variabledebttokenaddress
                    }', '${o.stabledebttokenaddress}', '${
                        o.totalstabledebt
                    }', '${o.totalvariabledebt}', '${
                        o.ltv
                    }', ${index}, GETUTCDATE())`;
                }
            );

            if (reservesSQLList.length > 0) {
                const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, variabledebttokenaddress, stabledebttokenaddress, totalstabledebt, totalvariabledebt, ltv, sorting, modifiedon)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                        
                        symbol = source.symbol,
                        decimals = source.decimals,                        
                        reserveliquidationtreshold = source.reserveliquidationtreshold,
                        reserveliquidationbonus = source.reserveliquidationbonus,
                        reservefactor = source.reservefactor,
                        usageascollateralenabled = source.usageascollateralenabled,
                        borrowingenabled = source.borrowingenabled,
                        stableborrowrateenabled = source.stableborrowrateenabled,
                        isactive = source.isactive,
                        isfrozen = source.isfrozen,
                        liquidityindex = source.liquidityindex,
                        variableborrowindex = source.variableborrowindex,
                        liquidityrate = source.liquidityrate,
                        variableborrowrate = source.variableborrowrate,                        
                        lastupdatetimestamp = source.lastupdatetimestamp,
                        atokenaddress = source.atokenaddress,
                        variabledebttokenaddress = source.variabledebttokenaddress,
                        stabledebttokenaddress = source.stabledebttokenaddress,
                        totalstabledebt = source.totalstabledebt,
                        totalvariabledebt = source.totalvariabledebt,
                        ltv = source.ltv,
                        sorting = source.sorting,
                        modifiedon = source.modifiedon
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, network, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, variabledebttokenaddress, stabledebttokenaddress, totalstabledebt, totalvariabledebt, ltv, sorting, modifiedon)
                        VALUES (source.address, source.network, source.symbol, source.decimals, source.reserveliquidationtreshold, source.reserveliquidationbonus, source.reservefactor, source.usageascollateralenabled, source.borrowingenabled, source.stableborrowrateenabled, source.isactive, source.isfrozen, source.liquidityindex, source.variableborrowindex, source.liquidityrate, source.variableborrowrate, source.lastupdatetimestamp, source.atokenaddress, source.variabledebttokenaddress, source.stabledebttokenaddress, source.totalstabledebt, source.totalvariabledebt, source.ltv, source.sorting, source.modifiedon);
                `;

                await sqlManager.execQuery(sqlQuery);

                await this.saveChanges("updateReserves", key);
            }
        }
    }

    /**
     * This method should be scheduled to run every 2-3 hours
     *
     * Periodically fetches
     * - userAccountData
     * - userReserves (for each user, for each token)
     * for all addresses in the DB with health factor < 2
     */
    async updateUserAccountDataAndUserReserves(
        context: InvocationContext | null = null
    ) {
        //#region initialization

        logger.initialize(
            "function:updateHealthFactrAndUserReserves",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log(
            "Start updateHealthFactorAndUserReserves",
            "functionAppExecution"
        );

        await this.initializeAlchemy();
        await this.initializeReserves();

        //#endregion initialization

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            let dbAddressesArr: any[];
            let offset = 0;
            do {
                dbAddressesArr = await sqlManager.execQuery(
                    `SELECT * FROM addresses WHERE network = '${key}'
                     ORDER BY addedon OFFSET ${offset} ROWS FETCH NEXT ${Constants.CHUNK_SIZE} ROWS ONLY
                `
                );
                if (dbAddressesArr.length == 0) break;
                offset += Constants.CHUNK_SIZE;
                const _addresses = _.map(dbAddressesArr, (a: any) => a.address);

                //update all reserves for all users. I do it before getting the userAccountData,
                //because if there are users with hf < 1 I have to check their tokens balances
                //to calculate liquidation profitability
                await this.updateUsersReservesData(
                    dbAddressesArr,
                    aaveNetworkInfo
                );

                const results = await this.getUserAccountDataForAddresses(
                    _addresses,
                    aaveNetworkInfo.network
                );

                //Save data to the DB:
                //NOTE: it is not necessary to save the totaldebtbase to the DB, since
                //it will be calculated anyway from the usersreserves data.
                //I leave it here anyway for now, since it is not a big deal to save it
                let deleteAddresses: string[] = [];
                const chunks = _.chunk(results, Constants.CHUNK_SIZE);
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];

                    let query =
                        chunk.length > 0
                            ? `
                UPDATE addresses 
                SET 
                    modifiedon = GETUTCDATE(),
                    healthfactor = CASE
                        {0}
                    ELSE healthfactor
                    END,                                        
                    currentliquidationthreshold = CASE
                        {1}
                    ELSE currentliquidationthreshold
                    END,
                    totalcollateralbase = CASE
                        {2}
                    ELSE totalcollateralbase
                    END,
                    totaldebtbase = CASE
                        {3}
                    ELSE totaldebtbase
                    END
                WHERE address IN ({4}) AND network = '${key}';
            `
                            : "";

                    let arr0 = [];
                    let arr1 = [];
                    let arr2 = [];
                    let arr3 = [];
                    let arr4 = [];
                    for (let i = 0; i < chunk.length; i++) {
                        if (chunk[i].healthFactor < 2) {
                            arr0.push(
                                `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN ${chunk[i].healthFactor}`
                            );
                            arr1.push(
                                `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].currentLiquidationThreshold}'`
                            );
                            arr2.push(
                                `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalCollateralBase}'`
                            );
                            arr3.push(
                                `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalDebtBase}'`
                            );
                            arr4.push(`'${chunk[i].address}'`);
                        } else {
                            deleteAddresses.push(chunk[i].address);
                        }
                    }

                    query = query.replace("{0}", arr0.join(" "));
                    query = query.replace("{1}", arr1.join(" "));
                    query = query.replace("{2}", arr2.join(" "));
                    query = query.replace("{3}", arr3.join(" "));
                    query = query.replace("{4}", arr4.join(","));

                    if (query) await sqlManager.execQuery(query);
                }

                if (deleteAddresses.length > 0) {
                    const chunks = _.chunk(
                        deleteAddresses,
                        Constants.CHUNK_SIZE
                    );
                    for (let i = 0; i < chunks.length; i++) {
                        const sqlQuery = `
                    DELETE FROM addresses WHERE address IN ('${chunks[i].join(
                        "','"
                    )}') AND network = '${key}';
                    DELETE FROM usersreserves WHERE address IN ('${chunks[
                        i
                    ].join("','")}') AND network = '${key}';
                    `;
                        await sqlManager.execQuery(sqlQuery);
                    }
                }
            } while (dbAddressesArr.length > 0);

            await this.saveChanges("updateUsersReserves", key);
        }

        await logger.log(
            "End updateHealthFactorAndUserReserves",
            "functionAppExecution"
        );
    }

    async updateUsersReservesData(
        userAddressesObjects: any[],
        aaveNetworkInfo: any
    ) {
        const key = this.getAaveNetworkString(aaveNetworkInfo);

        let multicallUserReserveDataParameters: any[] = [];
        const reservesAddresses = _.keys(aaveNetworkInfo.reserves);

        //load usersreserves data for each user for each reserve
        for (let i = 0; i < userAddressesObjects.length; i++) {
            const userAddressObject = userAddressesObjects[i];

            for (let j = 0; j < reservesAddresses.length; j++) {
                const reserveAddress = reservesAddresses[j];
                multicallUserReserveDataParameters.push([
                    reserveAddress,
                    userAddressObject.address,
                ]);
            }
        }

        const results = await this.multicall(
            aaveNetworkInfo.addresses.poolDataProvider,
            multicallUserReserveDataParameters,
            "POOL_DATA_PROVIDER_ABI",
            "getUserReserveData",
            aaveNetworkInfo.network
        );

        let sqlQueries: string[] = [];
        const userReserveDataChunks = _.chunk(results, Constants.CHUNK_SIZE);
        for (let j = 0; j < userReserveDataChunks.length; j++) {
            const userReserveDataChunk: any = userReserveDataChunks[j];

            if (userReserveDataChunk.length > 0) {
                let userReservesObjects: any[] = _.map(
                    userReserveDataChunk,
                    (userReserveData, i) => {
                        const userAddress =
                            multicallUserReserveDataParameters[i][1].toString();
                        const reserveAddress =
                            multicallUserReserveDataParameters[i][0].toString();
                        return {
                            tokenAddress: reserveAddress,
                            userAddress: userAddress,
                            currentATokenBalance: userReserveData[0],
                            currentStableDebt: userReserveData[1],
                            currentVariableDebt: userReserveData[2],
                            principalStableDebt: userReserveData[3],
                            scaledVariableDebt: userReserveData[4],
                            stableBorrowRate: userReserveData[5],
                            liquidityRate: userReserveData[6],
                            stableRateLastUpdated:
                                userReserveData[7].toString(),
                            usageAsCollateralEnabled:
                                sqlManager.getBitFromBoolean(
                                    userReserveData[8].toString()
                                ),
                        };
                    }
                );

                let sqlQuery = `                        
                        MERGE INTO usersreserves AS target
                        USING (VALUES 
                            ${_.map(
                                userReservesObjects,
                                (o) =>
                                    `('${o.userAddress}', '${o.tokenAddress}', '${key}', '${o.currentATokenBalance}', '${o.currentStableDebt}', '${o.currentVariableDebt}', '${o.principalStableDebt}', '${o.scaledVariableDebt}', '${o.stableBorrowRate}', '${o.liquidityRate}', '${o.stableRateLastUpdated}', ${o.usageAsCollateralEnabled}, GETUTCDATE())`
                            ).join(",")}
                        ) AS source (address, tokenaddress, network, currentatokenbalance, currentstabledebt, currentvariabledebt, principalstabledebt, scaledvariabledebt, stableborrowrate, liquidityrate, stableratelastupdated, usageascollateralenabled, modifiedon)
                        ON (target.address = source.address AND target.tokenaddress = source.tokenaddress AND target.network = source.network)
                        WHEN MATCHED THEN
                        UPDATE SET                        
                            currentatokenbalance = source.currentatokenbalance,
                            currentstabledebt = source.currentstabledebt,
                            currentvariabledebt = source.currentvariabledebt,
                            principalstabledebt = source.principalstabledebt,
                            scaledvariabledebt = source.scaledvariabledebt,
                            stableborrowrate = source.stableborrowrate,
                            liquidityrate = source.liquidityrate,
                            stableratelastupdated = source.stableratelastupdated,
                            usageascollateralenabled = source.usageascollateralenabled,
                            modifiedon = source.modifiedon
                            WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, tokenaddress, network, currentatokenbalance, currentstabledebt, currentvariabledebt, principalstabledebt, scaledvariabledebt, stableborrowrate, liquidityrate, stableratelastupdated, usageascollateralenabled, modifiedon)
                        VALUES (source.address, source.tokenaddress, source.network, source.currentatokenbalance, source.currentstabledebt, source.currentvariabledebt, source.principalstabledebt, source.scaledvariabledebt, source.stableborrowrate, source.liquidityrate, source.stableratelastupdated, source.usageascollateralenabled, source.modifiedon);
                            `;

                sqlQueries.push(sqlQuery);
            }
        }

        //TODO evtl even before updating the database, check which users have HF < 1 and
        //check if liquidation is profitable

        if (sqlQueries.length > 0) {
            for (const sqlQuery of sqlQueries) {
                await sqlManager.execQuery(sqlQuery);
            }
        } else {
            //we should actually never come here, but just in case
            throw new Error(
                "No user reserves data found for the given addresses"
            );
        }
    }

    /**
     *  Gets the newest assets prices for the given network or all networks and updates the prices in the DB if the prices have changed
     *  beyond a certain treshold (currently set at 0.0005 ETH), then it
     *  calculates the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidates them if their health factor is below 1. The method is defined as a function and called periodically on azure
     *
     * //TODO implement logic to decide which asset pair to liquidate for a given user
     * //TODO connect to smart contract for liquidation process
     *
     * @param network
     * @param context the InvocationContext of the function app on azure (for Application Insights logging)
     */
    async updateTokensPrices(
        context: InvocationContext | null = null,
        network: Network | null = null //if network is not defined, loop through all networks
    ) {
        logger.initialize(
            "function:updateTokensPrices",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Start updateTokensPrices");

        await this.initializeAlchemy();
        await this.initializeReserves(network);
        //load all addresses from the DB that have health factor < 2 since higher health factors are not interesting
        const allAddressesDb = await sqlManager.execQuery(
            `SELECT * FROM addresses WHERE healthfactor < 2 ORDER BY healthfactor;`
        );

        if (allAddressesDb.length == 0) {
            await logger.log("No addresses found in DB with health factor < 2");
            return;
        }

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            if (network && network != aaveNetworkInfo.network) continue;
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            const addressesDb = _.filter(
                allAddressesDb,
                (o) => o.network == key
            );

            if (addressesDb.length == 0) {
                await logger.log(
                    `Network: ${key} No addresses found in DB with health factor < 2`
                );
                return;
            }

            //get last saved reserves prices from the DB
            let dbAssetsPrices = common.getJsonObjectFromArray(
                aaveNetworkInfo.reserves,
                "address",
                "price"
            );

            //get current reserves prices from the network
            const aaveOracleContract = this.getContract(
                aaveNetworkInfo.addresses.aaveOracle,
                Constants.ABIS.AAVE_ORACLE_ABI,
                aaveNetworkInfo.network
            );
            const reservesAddresses = Object.keys(aaveNetworkInfo.reserves);
            const currentAssetsPrices =
                await aaveOracleContract.getAssetsPrices(reservesAddresses);

            let newReservesPrices: any = {};
            for (let i = 0; i < reservesAddresses.length; i++) {
                const reserveAddress = reservesAddresses[i];
                const price = currentAssetsPrices[i];
                newReservesPrices[reserveAddress] = price;
            }

            //by default we should not perform the check. If price changes are found, we do check
            let shouldPerformCheck = false;
            let reservesChangedCheck: any[] = [];
            let reservesDbUpdate: any[] = [];

            for (const reserveAddress of reservesAddresses) {
                const oldPrice = dbAssetsPrices[reserveAddress];
                const newPrice =
                    new Big(newReservesPrices[reserveAddress]).toNumber() / 1e8;
                if (!oldPrice) {
                    //mark current reserve to be updated in the DB since no previous price is defined
                    reservesDbUpdate.push({
                        address: reserveAddress,
                        price: newPrice,
                    });
                    continue;
                }
                const normalizedChange = newPrice - oldPrice;

                let check = "none";

                //if the normalized change is greater than the given treshold (for now 0.5 USD), we should perform the check
                if (Math.abs(normalizedChange) > 0.5) {
                    //mark current reserve to be updated in the DB since the change exceeds the treshold
                    reservesDbUpdate.push({
                        address: reserveAddress,
                        price: newPrice,
                    });

                    //if we come here, it means there is at least 1 changed reserve. We should perform the check
                    //later on all accounts that have the changed reserves either as collateral or as debt
                    //depending if price has gone up or down
                    shouldPerformCheck = true;

                    //add current reserve to the list of changed reserves and check if it should be checked as collateral or a debt
                    check = normalizedChange < 0 ? "collateral" : "debt";
                }

                //add the reserve to the list of changed reserves. If no price change for this reserve has happened, the check will be "none"
                reservesChangedCheck.push({
                    reserve: reserveAddress,
                    check: check,
                });
            }

            if (reservesDbUpdate.length > 0) {
                let reservesSQLList: string[] = _.map(reservesDbUpdate, (o) => {
                    return `('${o.address}', '${key}', ${o.price}, GETUTCDATE())`;
                });

                if (reservesSQLList.length > 0) {
                    const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, price, pricemodifiedon)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                    
                        pricemodifiedon = source.pricemodifiedon,    
                        price = source.price;                        
                        `;

                    await sqlManager.execQuery(sqlQuery);

                    await this.saveChanges(
                        "updatePrices",
                        key,
                        reservesDbUpdate
                    );
                } else {
                    //we should actually never come here, but just in case
                    throw new Error(
                        "reservesSQLList is empty despite reservesDbUpdate being not empty"
                    );
                }
            }
        }
    }

    /**
     * deletes old entries from the logs table older than 2 days
     * so that the table does not grow indefinitely
     *
     * @param context the InvocationContext of the function app (for Application Insights logging)
     */
    async deleteOldTablesEntries(context: InvocationContext) {
        logger.initialize(
            "function:deleteOldTablesEntries",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Started function deleteOldTablesEntries");
        const query = `
            DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -2, GETUTCDATE());
            DELETE FROM dbo.changes WHERE timestamp < DATEADD(DAY, -2, GETUTCDATE());
        `;
        await sqlManager.execQuery(query);
        await logger.log("Ended function deleteOldTablesEntries");
    }

    //#endregion Scheduled azure functions

    //#region Testing methods

    async doTest() {}
    //#endregion Testing methods
}

export default Engine.getInstance();
