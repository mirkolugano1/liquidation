const { ethers } = require("ethers");

class Keccak {
    private static instance: Keccak;
    private constructor() {}

    public static getInstance(): Keccak {
        if (!Keccak.instance) {
            Keccak.instance = new Keccak();
        }
        return Keccak.instance;
    }

    async hash(stringToHash: string) {
        let bytesLike = ethers.toUtf8Bytes(stringToHash);
        return ethers.keccak256(bytesLike);
    }
}

export default Keccak.getInstance();
