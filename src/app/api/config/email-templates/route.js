import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Setting from "@/lib/db/models/Setting";
import { getUserFromRequest } from "@/lib/serverAuth";

export async function GET(req) {
  try {
    await dbConnect();
    const user = await getUserFromRequest(req);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const settings = await Setting.find({
      key: { $in: ["customer_welcome_email_template", "supplier_welcome_email_template"] }
    });

    const data = {};
    settings.forEach((s) => {
      data[s.key] = s.value;
    });

    const availableVariables = {
      customer: [
        "{{entityDisplayName}}", "{{businessName}}", "{{name}}", "{{username}}", "{{password}}", "{{email}}", "{{phone}}",
        "{{addressText}}", "{{outletsText}}", "{{outletsHtml}}", "{{fssaiDetailsText}}", 
        "{{fssaiDetailsHtml}}", "{{gstDisplayText}}", "{{orderContact}}", "{{goodsContact}}", 
        "{{accountsContact}}", "{{headAccountsContact}}", "{{creditSectionHtml}}", "{{changePasswordSectionHtml}}"
      ],
      supplier: [
        "{{name}}", "{{businessName}}", "{{email}}", "{{password}}", "{{gstNumber}}", "{{gstSectionHtml}}", "{{isUrg}}"
      ]
    };

    return NextResponse.json({ success: true, data, availableVariables });
  } catch (error) {
    console.error("Error fetching email templates:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PUT(req) {
  try {
    await dbConnect();
    const user = await getUserFromRequest(req);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { customer_welcome_email_template, supplier_welcome_email_template } = body;

    if (customer_welcome_email_template) {
      await Setting.findOneAndUpdate(
        { key: "customer_welcome_email_template" },
        {
          key: "customer_welcome_email_template",
          value: customer_welcome_email_template,
          description: "Customer Welcome Email Template"
        },
        { upsert: true, new: true }
      );
    }

    if (supplier_welcome_email_template) {
      await Setting.findOneAndUpdate(
        { key: "supplier_welcome_email_template" },
        {
          key: "supplier_welcome_email_template",
          value: supplier_welcome_email_template,
          description: "Supplier Welcome Email Template"
        },
        { upsert: true, new: true }
      );
    }

    return NextResponse.json({ success: true, message: "Email templates updated successfully." });
  } catch (error) {
    console.error("Error updating email templates:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
