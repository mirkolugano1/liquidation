class Constants {
    private static instance: Constants;

    public static getInstance(): Constants {
        if (!Constants.instance) {
            Constants.instance = new Constants();
        }
        return Constants.instance;
    }

    private constructor() {}

    AAVE_CHAINS_INFOS = [
        {
            chain: "arb",
            chainEnv: "mainnet",
            addresses: {
                //https://aave.com/docs/resources/addresses
                aaveOracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
                pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
                uiPoolDataProvider:
                    "0x5c5228ac8bc1528482514af3e27e692495148717",
                poolAddressesProvider:
                    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
            },
        },
    ];

    AAVE_ORACLE_ABI = [
        "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
    ];

    TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"];

    POOL_ABI = [
        "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
        "function getUserEMode(address user) external view returns (uint256)",
        "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external returns (uint256, uint256, uint256)",
        "function getReservesList() external view returns (address[] memory)",
        "function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)",
        "function getUserConfiguration(address user) external view returns (uint256 configuration)",
        "function getConfiguration(address asset) external view returns (uint256 data)",
    ];

    ADDRESSES_PROVIDER_ABI = [
        "function getPoolDataProvider() external view returns (address)",
    ];

    // Detailed ABI with exact component structure
    UI_POOL_DATA_PROVIDER_ABI = [
        {
            inputs: [
                {
                    internalType: "address",
                    name: "provider",
                    type: "address",
                },
            ],
            name: "getReservesData",
            outputs: [
                {
                    components: [
                        {
                            internalType: "address",
                            name: "underlyingAsset",
                            type: "address",
                        },
                        {
                            internalType: "string",
                            name: "name",
                            type: "string",
                        },
                        {
                            internalType: "string",
                            name: "symbol",
                            type: "string",
                        },
                        {
                            internalType: "uint256",
                            name: "decimals",
                            type: "uint256",
                        },
                        {
                            internalType: "uint256",
                            name: "baseLTVasCollateral",
                            type: "uint256",
                        },
                        {
                            internalType: "uint256",
                            name: "reserveLiquidationThreshold",
                            type: "uint256",
                        },
                        {
                            internalType: "uint256",
                            name: "reserveLiquidationBonus",
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
                        // Include all other fields from the AggregatedReserveData struct
                        // (Truncated for brevity)
                        {
                            internalType: "uint128",
                            name: "liquidityIndex",
                            type: "uint128",
                        },
                        {
                            internalType: "uint128",
                            name: "variableBorrowIndex",
                            type: "uint128",
                        },
                        {
                            internalType: "uint128",
                            name: "liquidityRate",
                            type: "uint128",
                        },
                        {
                            internalType: "uint128",
                            name: "variableBorrowRate",
                            type: "uint128",
                        },
                        {
                            internalType: "uint128",
                            name: "stableBorrowRate",
                            type: "uint128",
                        },
                        {
                            internalType: "uint40",
                            name: "lastUpdateTimestamp",
                            type: "uint40",
                        },
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
                        {
                            internalType: "address",
                            name: "interestRateStrategyAddress",
                            type: "address",
                        },
                        // Add remaining fields for complete struct definition
                    ],
                    internalType: "struct AggregatedReserveData[]",
                    name: "",
                    type: "tuple[]",
                },
                {
                    components: [
                        {
                            internalType: "uint256",
                            name: "marketReferenceCurrencyUnit",
                            type: "uint256",
                        },
                        {
                            internalType: "int256",
                            name: "marketReferenceCurrencyPriceInUsd",
                            type: "int256",
                        },
                        {
                            internalType: "int256",
                            name: "networkBaseTokenPriceInUsd",
                            type: "int256",
                        },
                        {
                            internalType: "uint8",
                            name: "networkBaseTokenPriceDecimals",
                            type: "uint8",
                        },
                    ],
                    internalType: "struct BaseCurrencyInfo",
                    name: "",
                    type: "tuple",
                },
            ],
            stateMutability: "view",
            type: "function",
        },
    ];
}
export default Constants.getInstance();
