import { Network } from "alchemy-sdk";

class Constants {
    private static instance: Constants;

    public static getInstance(): Constants {
        if (!Constants.instance) {
            Constants.instance = new Constants();
        }
        return Constants.instance;
    }

    private constructor() {}

    AAVE_NETWORKS_INFOS: any[] = [
        {
            network: Network.ARB_MAINNET,
            aaveAddresses: {
                poolAddressesProvider:
                    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb", //no longer used since poolDataProvider must be used from perihpery instead of core
                aaveOracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
                pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
                poolDataProvider: "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654", //from aave-v3-periphery
            },
            webSocketParameters: [
                {
                    addresses: ["0x794a61358D6845594F94dc1DB02A252b5b4814aD"], //pool
                    topics: [
                        [
                            "0xea368a40e9570069bb8e6511d668293ad2e1f03b0d982431fd223de9f3b70ca6",
                            "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051",
                            "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b",
                            "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7",
                            "0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951",
                            "0x9f439ae0c81e41a04d3fdfe07aed54e6a179fb0db15be7702eb66fa8ef6f5300",
                            "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2",
                            "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd",
                            "0x9a2f48d3aa6146e0a0f4e8622b5ff4b9d90a3c4f5e9a3b69c8523e213f775bfe",
                            "0x9c369e2bdbd7c7a5b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f",
                            "0xd3d8717c9c7a8b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f8f9",
                            "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
                            "0xe6cd5d3f2cfd1bf39c09a4afc6cfbfbce2a3c2c5c9d64e7464b3a8b5c2eecb1e",
                            "0x9bf0c5e4a0c4f3f430a20d9a8f1f3a1f0dd5a4f84d90e5c5f5db6aa3c4e6e7a8",
                        ],
                    ],
                },
                {
                    //reserves addresses
                    addresses: [
                        "0xFc06bB03a9e1D8033f87eA6A682cbd65477A43b9",
                        "0x9b8DdcF800a7BfCdEbaD6D65514dE59160a2C9CC",
                        "0x2946220288DbBF77dF0030fCecc2a8348CbBE32C",
                        "0x942d00008D658dbB40745BBEc89A93c253f9B882",
                        "0x3607e46698d218B3a5Cae44bF381475C0a5e2ca7",
                        "0xCb35fE6E53e71b30301Ec4a3948Da4Ad3c65ACe4",
                        "0x3c6AbdA21358c15601A3175D8dd66D0c572cc904",
                        "0x7AAeE6aD40a947A162DEAb5aFD0A1e12BE6FF871",
                        "0xc339c4c7c58cb1d964b7B66f846572D5C355441a",
                        "0x20CD97619A51d1a6f1910ce62d98Aceb9a13d5e6",
                        "0x2946220288DbBF77dF0030fCecc2a8348CbBE32C",
                        "0x5D041081725468Aa43e72ff0445Fde2Ad1aDE775",
                        "0x46de66F10343b59BAcc37dF9b3F67cD0CcC121A3",
                    ],
                    topics: [
                        [
                            "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f",
                        ],
                    ],
                },
            ],
            averageLiquidationGasUnits: 170000,
            liquidationContractAddress: "???", //TODO
            flashbotsProviderUrl: "https://arbitrum.rpc.flashbots.net",
            chainId: 42161,
            isActive: true,
        },
        /*
        {
            network: Network.ARB_SEPOLIA,
            aaveAddresses: {
                //this will be filled up at startup from the initializeAlchemy() method with the other useful addresses
                //fetching the other addresses from the pool address provider
                poolAddressesProvider:
                    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
            },
            averageLiquidationGasUnits: 170000,
            liquidationContractAddress:
                "0x775F2CD4c2b942076988068D8B7762b430345Ed1", //presently this is just a simple storage contract
            flashbotsProviderUrl: "https://arbitrum-sepolia.public.blastapi.io",
            chainId: 421614,
            isActive: false,
        },
        */
    ];
    CHUNK_SIZE = 300;
    METAMASK_ADDRESS = "0x2FD3A8F9E52b113E51016755B61AC9d3d9EA6567"; //liquidation metamask address
    MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"; //same across all EVM chains
    ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    ABIS: any = {
        LIQUIDATION_ABI: [
            "function retrieve() view returns (uint256)",
            "function store(uint256)",
        ],

        MULTICALL3_ABI: [
            // Minimal ABI for aggregate function
            {
                inputs: [
                    {
                        components: [
                            {
                                internalType: "address",
                                name: "target",
                                type: "address",
                            },
                            {
                                internalType: "bytes",
                                name: "callData",
                                type: "bytes",
                            },
                        ],
                        internalType: "struct Multicall3.Call[]",
                        name: "calls",
                        type: "tuple[]",
                    },
                ],
                name: "aggregate",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "blockNumber",
                        type: "uint256",
                    },
                    {
                        internalType: "bytes[]",
                        name: "returnData",
                        type: "bytes[]",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
        ],

        AAVE_ORACLE_ABI: [
            "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
            "function getSourceOfAsset(address asset) external view returns (address)",
        ],

        TOKEN_ABI: ["function balanceOf(address) view returns (uint256)"],

        POOL_ABI: [
            "function getEModeCategoryData(uint8) view returns (tuple(uint16,uint16,uint16,address,string,uint128,uint128))",
            "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
            "function getUserEMode(address user) external view returns (uint256)",
            "function liquidationCall(bytes32 args1, bytes32 args2) external",
            "function getReservesList() external view returns (address[] memory)",
            "function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)",
            "function getUserConfiguration(address user) external view returns (uint256 configuration)",
            "function getConfiguration(address asset) external view returns (uint256 data)",
        ],

        ADDRESSES_PROVIDER_ABI: [
            "function getPoolDataProvider() external view returns (address)",
            "function getPool() external view returns (address)",
            "function getPriceOracle() external view returns (address)",
            "function getFallbackOracle() external view returns (address)",
        ],

        PRICE_FEED_ABI: [
            "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
        ],

        BORROW_EVENT_ABI: [
            "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)",
        ],

        DEPOSIT_EVENT_ABI: [
            "event Deposit(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referral)",
        ],

        WITHDRAW_EVENT_ABI: [
            "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
        ],

        REDEEM_EVENT_ABI: [
            "event Redeem(address indexed reserve, address user, address indexed to, uint256 amount, uint256 index)",
        ],

        LIQUIDATION_CALL_EVENT_ABI: [
            "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
        ],

        SUPPLY_EVENT_ABI: [
            "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 index, uint16 indexed referral)",
        ],

        REPAY_EVENT_ABI: [
            "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens);",
        ],

        FLASHLOAN_EVENT_ABI: [
            "event FlashLoan(address indexed target, address indexed initiator, address indexed asset, uint256 amount, uint256 interestRateMode, uint256 premium, uint16 referralCode)",
        ],

        AGGREGATOR_ABI: [
            "function decimals() view returns (uint8)",
            "function aggregator() external view returns (address)",
            "function BASE_TO_USD_AGGREGATOR() view returns (address)",
            "function ASSET_TO_USD_AGGREGATOR() view returns (address)",
        ],

        AGGREGATOR_V3_INTERFACE_ABI: [
            // Function to get the latest price data
            {
                inputs: [],
                name: "latestRoundData",
                outputs: [
                    { internalType: "uint80", name: "roundId", type: "uint80" },
                    { internalType: "int256", name: "answer", type: "int256" },
                    {
                        internalType: "uint256",
                        name: "startedAt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "updatedAt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint80",
                        name: "answeredInRound",
                        type: "uint80",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            // Function to get the decimals (useful for formatting price)
            {
                inputs: [],
                name: "decimals",
                outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
                stateMutability: "view",
                type: "function",
            },
            // Function to get the underlying aggregator address
            {
                inputs: [],
                name: "aggregator",
                outputs: [
                    { internalType: "address", name: "", type: "address" },
                ],
                stateMutability: "view",
                type: "function",
            },
            // Event emitted when a new answer is accepted
            {
                anonymous: false,
                inputs: [
                    { indexed: true, name: "roundId", type: "uint256" },
                    { indexed: true, name: "answeredInRound", type: "uint256" },
                    { indexed: false, name: "answer", type: "int256" },
                    { indexed: false, name: "timestamp", type: "uint256" },
                    { indexed: false, name: "startedAt", type: "uint256" },
                ],
                name: "AnswerUpdated",
                type: "event",
            },
        ],

        // Detailed ABI with exact component structure
        POOL_DATA_PROVIDER_ABI: [
            {
                inputs: [
                    {
                        internalType: "contract IPoolAddressesProvider",
                        name: "addressesProvider",
                        type: "address",
                    },
                ],
                stateMutability: "nonpayable",
                type: "constructor",
            },
            {
                inputs: [],
                name: "ADDRESSES_PROVIDER",
                outputs: [
                    {
                        internalType: "contract IPoolAddressesProvider",
                        name: "",
                        type: "address",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [],
                name: "getAllATokens",
                outputs: [
                    {
                        components: [
                            {
                                internalType: "string",
                                name: "symbol",
                                type: "string",
                            },
                            {
                                internalType: "address",
                                name: "tokenAddress",
                                type: "address",
                            },
                        ],
                        internalType: "struct IPoolDataProvider.TokenData[]",
                        name: "",
                        type: "tuple[]",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [],
                name: "getAllReservesTokens",
                outputs: [
                    {
                        components: [
                            {
                                internalType: "string",
                                name: "symbol",
                                type: "string",
                            },
                            {
                                internalType: "address",
                                name: "tokenAddress",
                                type: "address",
                            },
                        ],
                        internalType: "struct IPoolDataProvider.TokenData[]",
                        name: "",
                        type: "tuple[]",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getDebtCeiling",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "",
                        type: "uint256",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getInterestRateStrategyAddress",
                outputs: [
                    {
                        internalType: "address",
                        name: "irStrategyAddress",
                        type: "address",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getLiquidationProtocolFee",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "",
                        type: "uint256",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getPaused",
                outputs: [
                    {
                        internalType: "bool",
                        name: "isPaused",
                        type: "bool",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getReserveCaps",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "borrowCap",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "supplyCap",
                        type: "uint256",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getReserveConfigurationData",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "decimals",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "ltv",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "liquidationThreshold",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "liquidationBonus",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "reserveFactor",
                        type: "uint256",
                    },
                    {
                        internalType: "bool",
                        name: "usageAsCollateralEnabled",
                        type: "bool",
                    },
                    {
                        internalType: "bool",
                        name: "borrowingEnabled",
                        type: "bool",
                    },
                    {
                        internalType: "bool",
                        name: "stableBorrowRateEnabled",
                        type: "bool",
                    },
                    {
                        internalType: "bool",
                        name: "isActive",
                        type: "bool",
                    },
                    {
                        internalType: "bool",
                        name: "isFrozen",
                        type: "bool",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getReserveData",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "unbacked",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "accruedToTreasuryScaled",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "totalAToken",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "totalStableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "totalVariableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "liquidityRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "variableBorrowRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "stableBorrowRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "averageStableBorrowRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "liquidityIndex",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "variableBorrowIndex",
                        type: "uint256",
                    },
                    {
                        internalType: "uint40",
                        name: "lastUpdateTimestamp",
                        type: "uint40",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getReserveEModeCategory",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "",
                        type: "uint256",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                ],
                name: "getReserveTokensAddresses",
                outputs: [
                    {
                        internalType: "address",
                        name: "aTokenAddress",
                        type: "address",
                    },
                    {
                        internalType: "address",
                        name: "stableDebtTokenAddress",
                        type: "address",
                    },
                    {
                        internalType: "address",
                        name: "variableDebtTokenAddress",
                        type: "address",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "asset",
                        type: "address",
                    },
                    {
                        internalType: "address",
                        name: "user",
                        type: "address",
                    },
                ],
                name: "getUserReserveData",
                outputs: [
                    {
                        internalType: "uint256",
                        name: "currentATokenBalance",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "currentStableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "currentVariableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "principalStableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "scaledVariableDebt",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "stableBorrowRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "liquidityRate",
                        type: "uint256",
                    },
                    {
                        internalType: "uint40",
                        name: "stableRateLastUpdated",
                        type: "uint40",
                    },
                    {
                        internalType: "bool",
                        name: "usageAsCollateralEnabled",
                        type: "bool",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
            {
                inputs: [],
                name: "getReservesList",
                outputs: [
                    {
                        internalType: "address[]",
                        name: "",
                        type: "address[]",
                    },
                ],
                stateMutability: "view",
                type: "function",
            },
        ],
    };
}
export default Constants.getInstance();
