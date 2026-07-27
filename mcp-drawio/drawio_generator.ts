/**
 * Utility to build valid draw.io (mxGraphModel) XML strings
 */

export interface DiagramNode {
  id: string;
  label: string;
  shape?: string; // rectangle, rounded, ellipse, rhombus, cylinder, etc.
  fillColor?: string;
  strokeColor?: string;
  fontColor?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: string;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateDrawioXml(
  title: string,
  nodes: DiagramNode[],
  edges: DiagramEdge[] = []
): string {
  let xml = `<mxfile host="Electron" agent="openBrain Agent-X draw.io MCP" type="device">
  <diagram id="diagram_1" name="${escapeXml(title)}">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" background="#ffffff">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />\n`;

  // Layout positioning algorithm if coordinates not specified
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const startX = 100;
  const startY = 100;
  const stepX = 220;
  const stepY = 140;

  nodes.forEach((node, index) => {
    const r = Math.floor(index / cols);
    const c = index % cols;
    const x = node.x ?? startX + c * stepX;
    const y = node.y ?? startY + r * stepY;
    const w = node.width ?? 140;
    const h = node.height ?? 60;

    let shapeStyle = "rounded=1;whiteSpace=wrap;html=1;";
    if (node.shape === "ellipse") {
      shapeStyle = "ellipse;whiteSpace=wrap;html=1;";
    } else if (node.shape === "rhombus") {
      shapeStyle = "rhombus;whiteSpace=wrap;html=1;";
    } else if (node.shape === "cylinder") {
      shapeStyle = "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;";
    } else if (node.shape === "rectangle") {
      shapeStyle = "rounded=0;whiteSpace=wrap;html=1;";
    }

    const fill = node.fillColor ? `fillColor=${node.fillColor};` : "fillColor=#dae8fc;";
    const stroke = node.strokeColor ? `strokeColor=${node.strokeColor};` : "strokeColor=#6c8ebf;";
    const font = node.fontColor ? `fontColor=${node.fontColor};` : "fontColor=#000000;";
    const style = `${shapeStyle}${fill}${stroke}${font}`;

    xml += `        <mxCell id="${escapeXml(node.id)}" value="${escapeXml(node.label)}" style="${style}" vertex="1" parent="1">
          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />
        </mxCell>\n`;
  });

  edges.forEach((edge, index) => {
    const edgeId = edge.id || `edge_${index + 1}`;
    const label = edge.label ? `value="${escapeXml(edge.label)}"` : "";
    const customStyle = edge.style || "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";

    xml += `        <mxCell id="${escapeXml(edgeId)}" ${label} style="${customStyle}" edge="1" parent="1" source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>\n`;
  });

  xml += `      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  return xml;
}
