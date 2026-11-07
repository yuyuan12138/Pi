/** Shared types for the memory index extension. */

export interface InsertStats {
	inserted: number;
	duplicates: number;
	credentialsSkipped: number;
}

export interface KbRefreshStats extends InsertStats {
	filesScanned: number;
}

export interface BackfillReport {
	inserted: number;
	duplicates: number;
	credentialsSkipped: number;
	parseErrors: number;
	filesScanned: number;
	kbInserted: number;
	kbFilesScanned: number;
}
