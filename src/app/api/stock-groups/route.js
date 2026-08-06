import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import StockGroup from "@/lib/db/models/StockGroup";

// Helper to build the Tally XML Request for Stock Group creation
function buildTallyXML(name, parentName) {
  const escapeXML = (str) => {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  const safeName = escapeXML(name);
  const safeParent = parentName ? escapeXML(parentName) : null;

  const tallyMessage = safeParent
    ? `<STOCKGROUP NAME="${safeName}" ACTION="Create">
        <NAME>${safeName}</NAME>
        <PARENT>${safeParent}</PARENT>
      </STOCKGROUP>`
    : `<STOCKGROUP NAME="${safeName}" ACTION="Create">
        <NAME>${safeName}</NAME>
      </STOCKGROUP>`;

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          ${tallyMessage}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to parse the XML response from Tally
function parseTallyResponse(xmlString) {
  if (!xmlString) return { success: false, error: "Empty response from Tally" };

  const createdMatch = xmlString.match(/<CREATED>(\d+)<\/CREATED>/);
  const alteredMatch = xmlString.match(/<ALTERED>(\d+)<\/ALTERED>/);

  const createdCount = createdMatch ? parseInt(createdMatch[1], 10) : 0;
  const alteredCount = alteredMatch ? parseInt(alteredMatch[1], 10) : 0;

  if (createdCount > 0 || alteredCount > 0) {
    return { success: true };
  }

  const errorMatch = xmlString.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (errorMatch && errorMatch[1]) {
    return { success: false, error: errorMatch[1].trim() };
  }

  return { success: false, error: "Failed to parse Tally response", raw: xmlString };
}

export async function GET(request) {
  await dbConnect();
  try {
    // 1. Sync all Stock Groups from Tally Prime 9 into MongoDB
    try {
      const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
      const xmlPayload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>Stock Group</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <FETCH>NAME,PARENT</FETCH>
    </DESC>
  </BODY>
</ENVELOPE>`;

      const tallyRes = await fetch(tallyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/xml", "ngrok-skip-browser-warning": "true" },
        body: xmlPayload
      });

      if (tallyRes.ok) {
        const xmlText = await tallyRes.text();
        const matches = xmlText.match(/<STOCKGROUP NAME="([^"]+)"/g) || [];
        const names = matches.map(m => m.replace('<STOCKGROUP NAME="', '').replace('"', '').trim());

        const validNames = names.filter(n => n && n !== "Primary");
        for (const groupName of validNames) {
          await StockGroup.findOneAndUpdate(
            { name: groupName },
            { $set: { name: groupName, isActive: true } },
            { upsert: true, new: true }
          );
        }
        if (validNames.length > 0) {
          await StockGroup.deleteMany({ name: { $nin: validNames } });
        }
      }
    } catch (tallyErr) {
      console.warn("Tally Stock Group sync error in GET /api/stock-groups:", tallyErr.message);
    }

    const list = await StockGroup.find().sort("-createdAt").populate("parent").lean();
    return NextResponse.json({ success: true, data: { items: list } });
  } catch (err) {
    console.error("GET /api/stock-groups error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  await dbConnect();
  try {
    const body = await request.json();

    if (!body.name || String(body.name).trim() === "") {
      return NextResponse.json({ success: false, error: "Stock group name required" }, { status: 400 });
    }

    const name = String(body.name).trim();
    let parentId = null;
    let parentDoc = null;

    if (body.parent) {
      parentId = String(body.parent).trim();
      parentDoc = await StockGroup.findById(parentId).lean();
      if (!parentDoc) {
        return NextResponse.json({ success: false, error: "Parent stock group not found" }, { status: 404 });
      }
    }

    const existing = await StockGroup.findOne({ name }).lean();
    if (existing) {
      return NextResponse.json({ success: false, error: "Stock group with the same name already exists" }, { status: 409 });
    }

    const stockGroup = new StockGroup({
      name,
      parent: parentId ?? null,
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
    });
    await stockGroup.save();

    let tallySynced = false;
    let tallyError = null;

    try {
      const tallyUrl = 'https://yummy-freebee-circular.ngrok-free.dev';
      const xmlPayload = buildTallyXML(name, parentDoc ? parentDoc.name : null);

      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
        body: xmlPayload
      });

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        const parsed = parseTallyResponse(responseText);
        if (parsed.success) {
          tallySynced = true;
        } else {
          tallyError = parsed.error;
        }
      } else {
        tallyError = `Tally server responded with status ${tallyResponse.status}`;
      }
    } catch (err) {
      tallyError = err.message || String(err);
    }

    return NextResponse.json({
      success: true,
      data: stockGroup,
      tallySynced,
      tallyError
    }, { status: 201 });
  } catch (err) {
    console.error("POST /api/stock-groups error", err);
    return NextResponse.json({ success: false, error: err.message || String(err) }, { status: 500 });
  }
}
