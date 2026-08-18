import { NextResponse } from "next/server";
const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};

export async function GET(req) {
  try {
    const xmlPayload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>CustomGroupsCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CustomGroupsCollection">
            <TYPE>Group</TYPE>
            <FETCH>NAME,PARENT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const TALLY_ENDPOINT = process.env.TALLY_URL || "https://yummy-freebee-circular.ngrok-free.dev";
    console.log("[Tally Groups API Backend] Querying Tally Prime Groups from:", TALLY_ENDPOINT);

    const response = await fetch(TALLY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "ngrok-skip-browser-warning": "true"
      },
      body: xmlPayload,
    });

    const xmlText = await response.text();

    if (response.ok) {
      // Find all <GROUP ...> blocks in the XML response
      const groupBlocks = xmlText.match(/<GROUP[\s\S]*?<\/GROUP>/g) || [];
      console.log(`[Tally Groups API Backend] Found ${groupBlocks.length} total group blocks in Tally response.`);

      const debtorGroups = [];

      groupBlocks.forEach(block => {
        const nameMatch = block.match(/<GROUP[^>]*\sNAME="([^"]+)"/);
        const name = nameMatch ? nameMatch[1]?.trim() : null;

        if (name && !debtorGroups.includes(name)) {
          debtorGroups.push(name);
        }
      });

      // Sort alphabetically for clean display, prioritizing Sundry Debtors if present
      debtorGroups.sort((a, b) => {
        if (a === "Sundry Debtors") return -1;
        if (b === "Sundry Debtors") return 1;
        return a.localeCompare(b);
      });

      console.log("[Tally Groups API Backend] Filtered Debtor Groups for UI dropdown:", debtorGroups);
      return NextResponse.json({ success: true, data: debtorGroups });
    } else {
      console.error("[Tally Groups API Backend] Error (GET Groups):", xmlText);
      return NextResponse.json({ success: false, error: "Failed to fetch Groups from Tally" }, { status: 500 });
    }
  } catch (error) {
    console.error("[Tally Groups API Backend] Error:", error);
    return NextResponse.json({ success: false, error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
