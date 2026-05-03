import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * proper-lockfile can only lock an existing file. Seed a missing target with
 * valid throw-away JSON before the caller takes the lock and atomically writes.
 */
export async function ensureSeedFile(
	filePath: string,
	seedData: unknown,
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	try {
		await fs.access(filePath);
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code !== "ENOENT"
		) {
			throw err;
		}
		await fs.writeFile(
			filePath,
			`${JSON.stringify(seedData, null, 2)}\n`,
			"utf8",
		);
	}
}
