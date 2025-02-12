import * as fs from "fs/promises";

class FileUtilities {
    private static instance: FileUtilities;
    private constructor() {}

    public static getInstance(): FileUtilities {
        if (!FileUtilities.instance) {
            FileUtilities.instance = new FileUtilities();
        }
        return FileUtilities.instance;
    }

    async fileExists(filePath: string) {
        try {
            await fs.access(filePath, fs.constants.F_OK);
            return true;
        } catch (err) {
            return false;
        }
    }

    async readFromTextFile(filePath: string) {
        if (!filePath) throw new Error("File path is required");
        if (!(await this.fileExists(filePath)))
            throw new Error("File not found: " + filePath);
        const data = await fs.readFile(filePath);
        return data.toString();
    }

    // Write data to a file
    async writeToTextFile(filePath: string, data: string) {
        if (!filePath) throw new Error("File path is required");
        await this.ensureFileExists(filePath);
        await fs.writeFile(filePath, data);
    }

    // Append data to a file
    async appendToTextFile(filePath: string, data: string) {
        if (!filePath) throw new Error("File path is required");
        await this.ensureFileExists(filePath);
        await fs.appendFile(filePath, data);
    }

    async ensureDirectoryExists(dir: string) {
        if (!(await this.fileExists(dir))) {
            await fs.mkdir(dir);
        }
    }

    async ensureFileExists(filePath: string) {
        if (!filePath) throw new Error("File path is required");
        if (!(await this.fileExists(filePath)))
            await fs.writeFile(filePath, "");
    }
}

export default FileUtilities.getInstance();
