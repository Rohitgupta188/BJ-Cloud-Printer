
import { google } from "googleapis";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function getAuth() {
  const oauthClientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const oauth2Client = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    oauth2Client.setCredentials({ refresh_token: oauthRefreshToken });
    return oauth2Client;
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error(
      "[drive/client] Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY in environment."
    );
  }

  return new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: SCOPES,
  });
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getDriveFolderId(): string {
  const id = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!id) {
    throw new Error(
      "[drive/client] Missing GOOGLE_DRIVE_FOLDER_ID in environment."
    );
  }
  return id;
}


// Folder ID for the Excel export destination ("EXHIBITION EXCEL" folder).

export function getExcelFolderId(): string {
  const id =
    process.env.GOOGLE_DRIVE_EXCEL_FOLDER_ID
  if (!id) {
    throw new Error(
      "[drive/client] Missing GOOGLE_DRIVE_EXCEL_FOLDER_ID in environment."
    );
  }
  return id;
}
