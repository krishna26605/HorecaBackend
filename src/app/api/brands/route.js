

// /app/api/brands/route.js
import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Brand from "@/lib/db/models/brand";
import Product from "@/lib/db/models/product"; // optional if you later want to include products



// /app/api/brands/route.js (GET only root brands + populate children)
export async function GET(request) {
  await dbConnect();
  try {
    // Sync Stock Categories from Tally Prime 9 into Brand collection
    try {
      const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
      const xmlPayload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>Stock Category</ID>
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
        const matches = xmlText.match(/<STOCKCATEGORY NAME="([^"]+)"/g) || [];
        const names = matches.map(m => m.replace('<STOCKCATEGORY NAME="', '').replace('"', '').trim());

        const validNames = names.filter(n => n && n !== "Primary");
        for (const catName of validNames) {
          await Brand.findOneAndUpdate(
            { name: catName },
            { $set: { name: catName, isActive: true } },
            { upsert: true, new: true }
          );
        }
        if (validNames.length > 0) {
          await Brand.deleteMany({ name: { $nin: validNames } });
        }
      }
    } catch (tallyErr) {
      console.warn("Tally Stock Category sync error in GET /api/brands:", tallyErr.message);
    }

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
    const skip = (page - 1) * limit;

    const filter = {};
    const isActive = url.searchParams.get('isActive');
    if (isActive === 'true') filter.isActive = true;
    if (isActive === 'false') filter.isActive = false;

    const list = await Brand.find(filter)
      .sort("-createdAt")
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Brand.countDocuments(filter);

    return NextResponse.json({
      success: true,
      data: { items: list, pagination: { total, page, limit, pages: Math.ceil(total / limit) } }
    });
  } catch (err) {
    console.error("GET /api/brands error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}


// Single POST handler (subBrand-aware)
export async function POST(request) {
  await dbConnect();
  try {
    const body = await request.json();

    // Basic required check
    if (!body.name || String(body.name).trim() === "") {
      return NextResponse.json({ success: false, error: "Brand name required" }, { status: 400 });
    }

    // Normalize name
    const name = String(body.name).trim();

    // If parent provided, validate it's a valid ObjectId and exists
    let parentId = null;
    if (body.parent) {
      const maybeParent = String(body.parent).trim();
      if (!/^[0-9a-fA-F]{24}$/.test(maybeParent)) {
        return NextResponse.json({ success: false, error: "Invalid parent id" }, { status: 400 });
      }

      const parentDoc = await Brand.findById(maybeParent).lean();
      if (!parentDoc) {
        return NextResponse.json({ success: false, error: "Parent Brand not found" }, { status: 404 });
      }
      parentId = maybeParent;
    }

    // Prevent duplicate sibling name: same name under same parent
    const siblingFilter = parentId ? { parent: parentId, name } : { parent: null, name };
    const existing = await Brand.findOne(siblingFilter).lean();
    if (existing) {
      return NextResponse.json({ success: false, error: "Brand with the same name already exists under this parent" }, { status: 409 });
    }

    // Build Brand payload
    const payload = {
      name,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      parent: parentId ?? null,
      handlingFee: typeof body.handlingFee === "number" ? body.handlingFee : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      createdBy: body.createdBy ?? undefined,
    };

    const newBrand = new Brand(payload);
    await newBrand.save();

    // Optionally return parent basic info so client can update UI without another fetch
    let parentInfo = null;
    if (parentId) {
      const p = await Brand.findById(parentId).select("_id name image").lean();
      if (p) {
        parentInfo = {
          id: String(p._id),
          name: p.name,
          image: p.image?.url ?? null,
        };
      }
    }

    const result = {
      id: String(newBrand._id),
      name: newBrand.name,
      description: newBrand.description ?? "",
      image: newBrand.image ?? null,
      parent: parentInfo,
      handlingFee: newBrand.handlingFee ?? 0,
      isActive: newBrand.isActive,
      createdAt: newBrand.createdAt,
      updatedAt: newBrand.updatedAt,
    };

    // Sync to Tally Prime 9 as Stock Category
    let tallySynced = false;
    let tallyError = null;

    try {
      const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
      const parentName = parentInfo ? parentInfo.name : null;

      const escapeXML = (str) => !str ? "" : String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      const safeName = escapeXML(name);
      const safeParent = parentName ? escapeXML(parentName) : null;

      const xmlPayload = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKCATEGORY NAME="${safeName}" ACTION="Create">
            <NAME>${safeName}</NAME>
            ${safeParent ? `<PARENT>${safeParent}</PARENT>` : ''}
          </STOCKCATEGORY>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
        body: xmlPayload
      });

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        if (responseText.includes("<CREATED>1</CREATED>") || responseText.includes("<ALTERED>1</ALTERED>")) {
          tallySynced = true;
        }
      }
    } catch (tallyErr) {
      console.error("[Tally Sync] Error syncing category/brand to Tally:", tallyErr);
    }

    return NextResponse.json({ success: true, data: result, tallySynced }, { status: 201 });
  } catch (err) {
    console.error("POST /api/brands error", err);
    if (err && err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return NextResponse.json({ success: false, error: "Validation failed", details: errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: err.message || String(err) }, { status: 500 });
  }
}

