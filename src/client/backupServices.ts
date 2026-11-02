// The cloud services offered for the backup. A service whose build has no
// client ID is left out. The file on this device is always offered (see backupFile.ts).

import type { CloudBackup } from "./backup.js";
import { dropboxBackup } from "./dropbox.js";
import { googleDrive } from "./drive.js";

export const cloudBackups: CloudBackup[] = [googleDrive, dropboxBackup].filter((s): s is CloudBackup => s !== null);
