import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  generateDrawioXml,
  DiagramNode,
  DiagramEdge,
} from "./drawio_generator.ts";
import {
  hasGoogleCredentials,
  uploadDrawioToDrive,
  listDriveDrawioFiles,
  readDriveDrawioFile,
} from "./google_drive.ts";

export function registerDrawioTools(server: McpServer) {
  // ─────────────────────────────────────────────────────────────
  // Tool 1: create_drawio_diagram
  // ─────────────────────────────────────────────────────────────
  server.tool(
    "create_drawio_diagram",
    "Creates a draw.io diagram (flowchart, system architecture, sequence diagram) and uploads it directly to your Google Drive 'openBrain' folder.",
    {
      title: z.string().describe("Title/filename of the diagram"),
      nodes: z
        .array(
          z.object({
            id: z.string().describe("Unique node ID, e.g. node_1"),
            label: z.string().describe("Text label inside the node"),
            shape: z
              .enum(["rounded", "rectangle", "ellipse", "rhombus", "cylinder"])
              .optional()
              .describe("Visual shape of the node"),
            fillColor: z.string().optional().describe("HEX background color e.g. #dae8fc"),
            strokeColor: z.string().optional().describe("HEX border color e.g. #6c8ebf"),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
          })
        )
        .describe("List of nodes in the diagram"),
      edges: z
        .array(
          z.object({
            id: z.string().optional(),
            source: z.string().describe("Source node ID"),
            target: z.string().describe("Target node ID"),
            label: z.string().optional().describe("Label on the connection arrow"),
          })
        )
        .optional()
        .describe("List of connecting arrows/edges"),
    },
    async ({ title, nodes, edges }) => {
      try {
        const xml = generateDrawioXml(title, nodes as DiagramNode[], (edges || []) as DiagramEdge[]);

        if (hasGoogleCredentials()) {
          const driveResult = await uploadDrawioToDrive(title, xml);
          return {
            content: [
              {
                type: "text",
                text: `✅ Diagram '${title}' successfully created and saved to Google Drive ('openBrain' folder)!\n` +
                  `📄 Google Drive File ID: ${driveResult.fileId}\n` +
                  `🔗 Google Drive Link: ${driveResult.webViewLink}\n` +
                  `✏️ Open in draw.io Editor: ${driveResult.drawioAppUrl}\n\n` +
                  `XML Content:\n\`\`\`xml\n${xml}\n\`\`\``,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ Diagram '${title}' created successfully, but Google Drive credentials are not yet set in .env.\n` +
                  `Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env to auto-sync with Google Drive.\n\n` +
                  `Diagram XML Content (can be pasted into app.diagrams.net):\n\`\`\`xml\n${xml}\n\`\`\``,
              },
            ],
          };
        }
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error creating draw.io diagram: ${err.message}` }],
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // Tool 2: list_drawio_diagrams
  // ─────────────────────────────────────────────────────────────
  server.tool(
    "list_drawio_diagrams",
    "Lists all .drawio files stored inside your Google Drive 'openBrain' folder.",
    {},
    async () => {
      try {
        if (!hasGoogleCredentials()) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Google Credentials missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.",
              },
            ],
          };
        }

        const files = await listDriveDrawioFiles();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list diagrams: ${err.message}` }],
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // Tool 3: read_drawio_diagram
  // ─────────────────────────────────────────────────────────────
  server.tool(
    "read_drawio_diagram",
    "Reads the XML content of a .drawio file from your Google Drive 'openBrain' folder using its file ID.",
    {
      fileId: z.string().describe("Google Drive File ID of the .drawio file"),
    },
    async ({ fileId }) => {
      try {
        if (!hasGoogleCredentials()) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Google Credentials missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.",
              },
            ],
          };
        }

        const xml = await readDriveDrawioFile(fileId);
        return {
          content: [{ type: "text", text: xml }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to read diagram file: ${err.message}` }],
        };
      }
    }
  );
}
