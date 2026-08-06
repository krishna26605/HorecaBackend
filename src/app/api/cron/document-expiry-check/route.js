import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { sendEmail } from "@/lib/mail";
import { logger } from "@/lib/logger";

export async function GET(request) {
  try {
    const authHeader = request.headers.get("authorization");
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    await dbConnect();

    const now = new Date();
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Find verified customers whose FSSAI or License expires within 7 days from now (including today)
    const expiringCustomers = await Customer.find({
      isVerified: true,
      $or: [
        {
          fssaiExpiryDate: {
            $gte: now,
            $lte: sevenDaysFromNow
          }
        },
        {
          licenseExpiryDate: {
            $gte: now,
            $lte: sevenDaysFromNow
          }
        }
      ]
    });

    let emailsSent = 0;

    for (const customer of expiringCustomers) {
      const expiringDocs = [];
      
      if (customer.fssaiExpiryDate && customer.fssaiExpiryDate >= now && customer.fssaiExpiryDate <= sevenDaysFromNow) {
        const days = Math.ceil((customer.fssaiExpiryDate - now) / (1000 * 60 * 60 * 24));
        expiringDocs.push({ name: "FSSAI License", days });
      }

      if (customer.licenseExpiryDate && customer.licenseExpiryDate >= now && customer.licenseExpiryDate <= sevenDaysFromNow) {
        const days = Math.ceil((customer.licenseExpiryDate - now) / (1000 * 60 * 60 * 24));
        expiringDocs.push({ name: "Business License", days });
      }

      if (expiringDocs.length > 0) {
        const email = customer.email;
        if (!email) continue;

        const docListHtml = expiringDocs.map(d => `<li><strong>${d.name}</strong> expires in ${d.days} day(s)</li>`).join("");
        const docListText = expiringDocs.map(d => `${d.name} expires in ${d.days} day(s)`).join(", ");

        const mailHtml = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
            <h2 style="color: #ea580c;">Urgent: Document Expiration Notice</h2>
            <p style="color: #334155;">Dear Customer,</p>
            <p style="color: #334155;">We noticed that the following registered documents on your Unifoods account are expiring soon:</p>
            <ul style="color: #334155; line-height: 1.6;">
              ${docListHtml}
            </ul>
            <p style="color: #334155; font-weight: bold; margin-top: 20px;">Please renew your document(s) and update them in your dashboard profile page to continue receiving uninterrupted service from Unifoods. Otherwise, your services may be temporarily suspended.</p>
            <p style="color: #64748b; font-size: 12px; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 16px;">This is an automated reminder email from Unifoods.</p>
          </div>
        `;

        await sendEmail({
          to: email,
          subject: "Urgent: Unifoods Document Expiration Notice",
          html: mailHtml,
          text: `Dear Customer, the following document(s) are expiring soon: ${docListText}. Please renew and update them to continue services from Unifoods.`
        });

        await logger({
          level: "info",
          message: `Document expiry email reminder sent to ${email} for expiring documents: ${docListText}`,
          action: "CUSTOMER_DOCUMENT_EXPIRY_NOTIFICATION",
          userId: customer._id,
          userModel: "Customer",
          req: request
        });

        emailsSent++;
      }
    }

    return NextResponse.json({ success: true, message: `Document expiry cron run complete. Sent ${emailsSent} reminders.` }, { status: 200 });
  } catch (error) {
    console.error("Error in document-expiry-check cron:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST endpoint for testing/manual triggering
export async function POST(request) {
  return GET(request);
}
