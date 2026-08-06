import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Brand from "@/lib/db/models/brand";
import Category from "@/lib/db/models/category";

export async function GET(request) {
  await dbConnect();
  try {
    // 1. Sync Stock Categories from Tally Prime 9 into MongoDB
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
          await Category.findOneAndUpdate(
            { name: catName },
            { $set: { name: catName, isActive: true } },
            { upsert: true, new: true }
          );
          await Brand.findOneAndUpdate(
            { name: catName },
            { $set: { name: catName, isActive: true } },
            { upsert: true, new: true }
          );
        }
        if (validNames.length > 0) {
          await Category.deleteMany({ name: { $nin: validNames } });
          await Brand.deleteMany({ name: { $nin: validNames } });
        }
      }
    } catch (tallyErr) {
      console.warn("Tally Stock Category sync error in GET /api/categories:", tallyErr.message);
    }

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
    const skip = (page - 1) * limit;

    // if caller explicitly asks for all categories, return all
    const includeAll = url.searchParams.get('all') === 'true' || url.searchParams.get('includeAll') === 'true';

    // base filter: either all OR only top-level (parent === null)
    const filter = includeAll ? {} : { parent: null };

    // optional isActive filter
    const isActive = url.searchParams.get('isActive');
    if (isActive === 'true') filter.isActive = true;
    if (isActive === 'false') filter.isActive = false;

    const list = await Category.find(filter)
      .sort("-createdAt")
      .skip(skip)
      .limit(limit)
      .populate("subcategories") // immediate children
      .lean();

    const total = await Category.countDocuments(filter);

    return NextResponse.json({
      success: true,
      data: { items: list, pagination: { total, page, limit, pages: Math.ceil(total / limit) } }
    });
  } catch (err) {
    console.error("GET /api/categories error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}


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
    ? `<STOCKCATEGORY NAME="${safeName}" ACTION="Create">
        <NAME>${safeName}</NAME>
        <PARENT>${safeParent}</PARENT>
      </STOCKCATEGORY>`
    : `<STOCKCATEGORY NAME="${safeName}" ACTION="Create">
        <NAME>${safeName}</NAME>
      </STOCKCATEGORY>`;

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

// Single POST handler (subcategory-aware)
export async function POST(request) {
  await dbConnect();
  try {
    const body = await request.json();

    // Basic required check
    if (!body.name || String(body.name).trim() === "") {
      return NextResponse.json({ success: false, error: "Category name required" }, { status: 400 });
    }

    // Normalize name
    const name = String(body.name).trim();

    // If parent provided, validate it's a valid ObjectId and exists
    let parentId = null;
    let parentDoc = null;
    if (body.parent) {
      const maybeParent = String(body.parent).trim();
      if (!/^[0-9a-fA-F]{24}$/.test(maybeParent)) {
        return NextResponse.json({ success: false, error: "Invalid parent id" }, { status: 400 });
      }

      parentDoc = await Category.findById(maybeParent).lean();
      if (!parentDoc) {
        return NextResponse.json({ success: false, error: "Parent category not found" }, { status: 404 });
      }
      parentId = maybeParent;
    }

    // Prevent duplicate sibling name: same name under same parent
    const siblingFilter = parentId ? { parent: parentId, name } : { parent: null, name };
    const existing = await Category.findOne(siblingFilter).lean();
    if (existing) {
      return NextResponse.json({ success: false, error: "Category with the same name already exists under this parent" }, { status: 409 });
    }

    // Build category payload
    const payload = {
      name,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      parent: parentId ?? null,
      handlingFee: typeof body.handlingFee === "number" ? body.handlingFee : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      createdBy: body.createdBy ?? undefined,
    };

    const category = new Category(payload);
    await category.save();

    // Sync to Tally Prime 9
    let tallySynced = false;
    let tallyError = null;

    try {
      const tallyUrl = 'https://yummy-freebee-circular.ngrok-free.dev';
      const xmlPayload = buildTallyXML(name, parentDoc ? parentDoc.name : null);

      console.log(`[Tally Sync] Syncing category "${name}" to Tally at ${tallyUrl}`);
      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'ngrok-skip-browser-warning': 'true'
        },
        body: xmlPayload
      });

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        const parsed = parseTallyResponse(responseText);
        if (parsed.success) {
          tallySynced = true;
          console.log(`[Tally Sync] Category "${name}" synced successfully to Tally.`);
        } else {
          tallyError = parsed.error;
          console.error(`[Tally Sync] Tally error syncing "${name}":`, tallyError);
        }
      } else {
        tallyError = `Tally server responded with status ${tallyResponse.status}`;
        console.error(`[Tally Sync] HTTP error syncing "${name}":`, tallyError);
      }
    } catch (err) {
      tallyError = err.message || String(err);
      console.error(`[Tally Sync] Exception syncing "${name}":`, err);
    }

    // Optionally return parent basic info so client can update UI without another fetch
    let parentInfo = null;
    if (parentId) {
      const p = await Category.findById(parentId).select("_id name image").lean();
      if (p) {
        parentInfo = {
          id: String(p._id),
          name: p.name,
          image: p.image?.url ?? null,
        };
      }
    }

    const result = {
      id: String(category._id),
      name: category.name,
      description: category.description ?? "",
      image: category.image ?? null,
      parent: parentInfo,
      handlingFee: category.handlingFee ?? 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    };

    return NextResponse.json({
      success: true,
      data: result,
      tallySynced,
      tallyError
    }, { status: 201 });
  } catch (err) {
    console.error("POST /api/categories error", err);
    if (err && err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return NextResponse.json({ success: false, error: "Validation failed", details: errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: err.message || String(err) }, { status: 500 });
  }
}
