export enum LogLevel {
    Debug = "Debug",
    Trace = "Trace",
    Info = "Info",
    Warning = "Warning",
    Error = "Error",
}

export enum LoggingFramework {
    Table,
    ApplicationInsights,
}

export enum OutputType {
    Console,
    HTML,
}

export enum UserReserveType {
    Collateral = "Collateral",
    StableDebt = "StableDebt",
    VariableDebt = "VariableDebt",
}
