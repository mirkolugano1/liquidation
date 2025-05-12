class Repo {
    private static instance: Repo;

    public static getInstance(): Repo {
        if (!Repo.instance) {
            Repo.instance = new Repo();
        }
        return Repo.instance;
    }

    private constructor() {}

    public aave: any;
    public contractInterfaces: any = {};
    public isWebServerInitialized: boolean = false;
    public batchAddressesTreshold: number = 25;
    public ifaceBorrow: any;
    public ifaceDeposit: any;
    public ifaceSupply: any;
    public ifaceWithdraw: any;
    public ifaceLiquidationCall: any;
    public ifaceRepay: any;
    public ifaceFlashLoan: any;
    public isUsersReservesSynced: boolean = false;
    public isUsersReservesSyncInProgress: boolean = false;
    public temporaryBlocks: any[] = [];
    public updateUsersReservesOnStart: boolean = false;
}
export default Repo.getInstance();
