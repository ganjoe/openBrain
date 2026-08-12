import { google } from "googleapis";

function getCredentials() {
  let clientId = "";
  let clientSecret = "";
  let refreshToken = "";
  let accessToken = "";

  try {
    const envText = Deno.readTextFileSync("/home/daniel/openBrain/.env");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("GOOGLE_CLIENT_ID=")) clientId = trimmed.slice("GOOGLE_CLIENT_ID=".length).trim();
      if (trimmed.startsWith("GOOGLE_CLIENT_SECRET=")) clientSecret = trimmed.slice("GOOGLE_CLIENT_SECRET=".length).trim();
      if (trimmed.startsWith("GOOGLE_REFRESH_TOKEN=")) refreshToken = trimmed.slice("GOOGLE_REFRESH_TOKEN=".length).trim();
      if (trimmed.startsWith("GOOGLE_ACCESS_TOKEN=")) accessToken = trimmed.slice("GOOGLE_ACCESS_TOKEN=".length).trim();
    }
  } catch (_) {
    // ignore if file read fails
  }

  if (!clientId) clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  if (!clientSecret) clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  if (!refreshToken) refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN") || "";
  if (!accessToken) accessToken = Deno.env.get("GOOGLE_ACCESS_TOKEN") || "";

  return { clientId, clientSecret, refreshToken, accessToken };
}

export function hasGoogleCredentials(): boolean {
  const { clientId, clientSecret, refreshToken, accessToken } = getCredentials();
  return Boolean(accessToken || (clientId && clientSecret && refreshToken));
}

export function getOAuth2Client() {
  const { clientId, clientSecret, refreshToken, accessToken } = getCredentials();
  if (!accessToken && (!clientId || !clientSecret || !refreshToken)) {
    throw new Error(
      "Google OAuth Credentials missing. Please set GOOGLE_ACCESS_TOKEN or GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env"
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId || undefined,
    clientSecret || undefined,
    "https://developers.google.com/oauthplayground"
  );

  const creds: Record<string, string> = {};
  if (accessToken) creds.access_token = accessToken;
  if (refreshToken) creds.refresh_token = refreshToken;

  oauth2Client.setCredentials(creds);

  return oauth2Client;
}

export function getDriveService() {
  const auth = getOAuth2Client();
  return google.drive({ version: "v3", auth });
}

/**
 * Gets or creates the mandatory 'openBrain' root folder ID in Google Drive.
 * All file operations are strictly restricted to this folder.
 */
export async function getOpenBrainFolderId(): Promise<string> {
  const drive = getDriveService();
  const folderName = "openBrain";
  const q = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  // Create openBrain folder if it does not exist yet
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  return createRes.data.id!;
}

/**
 * Creates or updates a .drawio XML file strictly inside the Google Drive 'openBrain' folder
 */
export async function uploadDrawioToDrive(
  filename: string,
  xmlContent: string
): Promise<{ fileId: string; folderId: string; webViewLink: string; drawioAppUrl: string }> {
  const drive = getDriveService();
  const folderId = await getOpenBrainFolderId();
  const name = filename.endsWith(".drawio") ? filename : `${filename}.drawio`;

  // Search if file with same name already exists inside the 'openBrain' folder
  const q = `name = '${name}' and '${folderId}' in parents and trashed = false`;
  const existingFiles = await drive.files.list({
    q,
    fields: "files(id, name)",
  });

  const media = {
    mimeType: "text/xml",
    body: xmlContent,
  };

  let fileId = "";

  if (existingFiles.data.files && existingFiles.data.files.length > 0) {
    fileId = existingFiles.data.files[0].id!;
    await drive.files.update({
      fileId,
      media,
      fields: "id, name, webViewLink",
    });
  } else {
    const fileMetadata = {
      name,
      mimeType: "application/vnd.jgraph.mxfile",
      parents: [folderId],
    };

    const res = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, name, webViewLink",
    });
    fileId = res.data.id!;
  }

  const drawioAppUrl = `https://app.diagrams.net/#G${fileId}`;
  const webViewLink = `https://drive.google.com/file/d/${fileId}/view`;

  return {
    fileId,
    folderId,
    webViewLink,
    drawioAppUrl,
  };
}

/**
 * Lists .drawio files stored strictly inside the Google Drive 'openBrain' folder
 */
export async function listDriveDrawioFiles(): Promise<
  Array<{ id: string; name: string; drawioAppUrl: string }>
> {
  const drive = getDriveService();
  const folderId = await getOpenBrainFolderId();

  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.jgraph.mxfile' or name contains 'drawio')`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name, webViewLink)",
  });

  return (res.data.files || []).map((f: any) => ({
    id: f.id!,
    name: f.name!,
    drawioAppUrl: `https://app.diagrams.net/#G${f.id}`,
  }));
}

/**
 * Downloads XML content of a .drawio file strictly if it resides in the 'openBrain' folder
 */
export async function readDriveDrawioFile(fileId: string): Promise<string> {
  const drive = getDriveService();
  const folderId = await getOpenBrainFolderId();

  // Verify parent folder restriction before reading file
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, parents",
  });

  const parents = meta.data.parents || [];
  if (!parents.includes(folderId)) {
    throw new Error(
      `Access denied: File '${meta.data.name}' (${fileId}) is outside the restricted 'openBrain' folder.`
    );
  }

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );

  return res.data as unknown as string;
}
