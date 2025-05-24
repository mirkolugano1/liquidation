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
                //this will be filled up at startup from the initializeAlchemy() method with the other useful addresses
                //fetching the other addresses from the pool address provider
                poolAddressesProvider:
                    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
            },
            averageLiquidationGasUnits: 170000,
            liquidationContractAddress: "???", //TODO
            flashbotsProviderUrl: "https://arbitrum.rpc.flashbots.net",
            chainId: 42161,
            isActive: true,
        },
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
                "0x775F2CD4c2b942076988068D8B7762b430345Ed1",
            flashbotsProviderUrl: "https://arbitrum-sepolia.public.blastapi.io",
            chainId: 421614,
            isActive: false,
        },
    ];
    CHUNK_SIZE = 500;
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
        ],

        TOKEN_ABI: ["function balanceOf(address) view returns (uint256)"],

        POOL_ABI: [
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
            "event LiquidationCall(address indexed collateral, address indexed reserve, address indexed user, uint256 purchaseAmount, uint256 debtToCover, bool receiveAToken)",
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
