import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import dbConnect from "@/lib/db/connect";
import Setting from "@/lib/db/models/Setting";

const replacePlaceholders = (templateStr, variables) => {
  if (!templateStr) return "";
  let result = templateStr;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, "g");
    result = result.replace(regex, value || "");
  }
  return result;
};

const getTransporter = () => {
  const user = process.env.EMAIL_USER || process.env.SMTP_USER || "gaikwadsameer422@gmail.com";
  const rawPass = process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS || process.env.SMTP_PASS || "lkdj kbtb fysl gwzi";
  const pass = rawPass ? rawPass.replace(/\s+/g, "") : "";

  console.log(`[Mail Config] Initializing SMTP Transporter for user: ${user}`);

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
};

export const sendEmail = async ({ to, subject, html, text }) => {
  try {
    console.log(`📧 [Email Service] Starting mail dispatch to: "${to}" | Subject: "${subject}"`);
    const sender = process.env.EMAIL_USER || process.env.SMTP_USER || "gaikwadsameer422@gmail.com";
    const transporter = getTransporter();

    const info = await transporter.sendMail({
      from: `"Unifoods" <${sender}>`,
      to: to.trim(),
      replyTo: sender,
      subject: subject,
      text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      html: html,
    });

    console.log(`✅ [Email Service Success] Email Dispatched Successfully to ${to} | MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [Email Service Error] Email Transmission Failed to recipient: ${to}`);
    console.error("Full Error Stack:", error);
    console.error("Error Name:", error.name);
    console.error("Error Message:", error.message);
    return { success: false, error: error.message };
  }
};

export const sendCustomerWelcomeEmail = async ({
  email,
  name,
  businessName,
  username,
  password,
  gstNumber,
  creditTerm,
  creditLimit,
  customerId,
  address,
  phone,
  outlets = [],
  fssaiNumber,
  departmentContacts = [],
}) => {
  console.log(`📩 [Welcome Email Request] Received welcome email request for:`, { email, name, businessName, username, gstNumber, customerId });

  if (!email || !email.trim()) {
    console.warn("⚠️ [Welcome Email Skipped] No valid email address provided.");
    return { success: false, error: "No email address provided" };
  }

  const isUrg = gstNumber === "URG" || gstNumber === "URD" || gstNumber === "Unregistered" || !gstNumber;
  const entityDisplayName = businessName || name || "Valued Customer";
  const primaryName = name || businessName || "Valued Customer";
  const gstDisplayText = isUrg ? "URD (Unregistered Dealer)" : gstNumber;

  const addressText = address || "As per registered account details";

  // Format Outlets
  let outletsText = "N/A (Single Location)";
  let outletsHtml = "<p style='margin: 4px 0; color: #475569;'>N/A (Single Location)</p>";
  if (Array.isArray(outlets) && outlets.length > 0) {
    outletsText = outlets.map((o, idx) => `${idx + 1}. ${o.outletName || 'Outlet'}: ${o.address || ''} ${o.city ? ', ' + o.city : ''} ${o.pincode ? ' - ' + o.pincode : ''}`).join('\n');
    outletsHtml = outlets.map((o, idx) => `<div style="margin-bottom: 6px; padding: 6px 10px; background-color: #f8fafc; border-left: 3px solid #d97706; border-radius: 4px;"><strong>${o.outletName || 'Outlet #' + (idx + 1)}:</strong> ${o.address || ''} ${o.city ? ', ' + o.city : ''} ${o.state ? ', ' + o.state : ''} ${o.pincode ? ' - ' + o.pincode : ''}</div>`).join('');
  }

  // Format FSSAI Details
  let fssaiDetailsText = fssaiNumber ? `Primary License: ${fssaiNumber}` : "Not Provided / Under Undertaking";
  let fssaiDetailsHtml = fssaiNumber ? `Primary License: <strong>${fssaiNumber}</strong>` : "Not Provided / Under Undertaking";
  if (Array.isArray(outlets) && outlets.length > 0) {
    const outletFssais = outlets.filter(o => o.fssaiNumber).map(o => `${o.outletName}: ${o.fssaiNumber}`);
    if (outletFssais.length > 0) {
      fssaiDetailsText += ` | Outlets: ${outletFssais.join(', ')}`;
      fssaiDetailsHtml += `<br/>Outlets: ${outletFssais.map(of => `<span>${of}</span>`).join(', ')}`;
    }
  }

  // Format Key Contacts at Customer End
  let orderContact = `${primaryName} (${phone || 'N/A'})`;
  let goodsContact = `${primaryName} (${phone || 'N/A'})`;
  let accountsContact = `${primaryName} (${phone || 'N/A'})`;
  let headAccountsContact = `${primaryName} (${phone || 'N/A'})`;

  if (Array.isArray(departmentContacts) && departmentContacts.length > 0) {
    departmentContacts.forEach(dc => {
      if (!dc.name && !dc.phone) return;
      const pos = (dc.position || "").toLowerCase();
      const contactStr = `${dc.name || primaryName} (${dc.phone || phone || 'N/A'})`;
      if (pos.includes("order") || pos.includes("purchase") || pos.includes("procurement") || pos.includes("odt")) {
        orderContact = contactStr;
      } else if (pos.includes("goods") || pos.includes("receiving") || pos.includes("dispatch") || pos.includes("store")) {
        goodsContact = contactStr;
      } else if (pos.includes("account") || pos.includes("payment") || pos.includes("art") || pos.includes("cct")) {
        accountsContact = contactStr;
      } else if (pos.includes("head") || pos.includes("finance") || pos.includes("manager")) {
        headAccountsContact = contactStr;
      }
    });
  }

  const creditSectionHtml = (creditTerm > 0 || creditLimit > 0)
    ? `<div style="background-color: #f3e5f5; border-left: 4px solid #8e24aa; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
        <strong style="color: #4a148c; font-size: 14px; display: block; margin-bottom: 6px;">Approved B2B Commercial & Credit Terms:</strong>
        <p style="margin: 3px 0; color: #4a148c; font-size: 13px;">Credit Term: <strong>${creditTerm > 0 ? `${creditTerm} Days` : 'Immediate (COD / Advance)'}</strong></p>
        <p style="margin: 3px 0; color: #4a148c; font-size: 13px;">Approved Credit Limit: <strong>₹${Number(creditLimit || 0).toLocaleString('en-IN')}</strong></p>
       </div>`
    : '';

  const JWT_SECRET = process.env.JWT_SECRET || "ae6vg43fnq6c36nx4qcn4g6rcq";
  let changePasswordSectionHtml = "";
  if (customerId) {
    try {
      const resetToken = jwt.sign({ customerId }, JWT_SECRET, { expiresIn: "7d" });
      let frontendUrl = process.env.RESET_URL_BASE || "https://horeca-user-end.vercel.app";
      if (!process.env.RESET_URL_BASE && (process.env.NODE_ENV === "development" || !process.env.VERCEL)) {
        frontendUrl = "http://localhost:3002";
      }
      const changePasswordUrl = `${frontendUrl.replace(/\/$/, "")}/change-password?token=${resetToken}`;
      
      changePasswordSectionHtml = `
        <div style="background-color: #fff3e0; border-left: 4px solid #ff9800; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
          <strong style="color: #e65100; font-size: 14px; display: block; margin-bottom: 4px;">Security Notice & Password Update:</strong>
          <p style="margin: 0 0 10px 0; color: #e65100; font-size: 13px;">
            We recommend setting a custom, secure password for your account. You can change or reset your password at any time using the button below:
          </p>
          <a href="${changePasswordUrl}" style="background-color: #ff9800; color: #ffffff; text-decoration: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; font-size: 12px; display: inline-block; box-shadow: 0 2px 5px rgba(255, 152, 0, 0.2);">Change Your Password</a>
        </div>
      `;
    } catch (jwtErr) {
      console.error("Failed to generate password change token for welcome email:", jwtErr);
    }
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Welcome to Unifoods – Customer Onboarding, Account Details & Acceptance</title>
    </head>
    <body style="font-family: Arial, Helvetica, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
      <div style="max-width: 680px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
        
        <!-- Header -->
        <div style="background-color: #d97706; padding: 25px 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">Welcome to Unifoods!</h1>
          <p style="color: #fef3c7; margin: 6px 0 0 0; font-size: 13px;">Customer Onboarding, Account Details & Acceptance</p>
        </div>

        <!-- Body -->
        <div style="padding: 30px; color: #1e293b; line-height: 1.6; font-size: 14px;">
          
          <p style="font-size: 15px; margin-top: 0;">Dear <strong>${entityDisplayName}</strong>,</p>
          <p style="color: #334155; margin-bottom: 20px;">
            Welcome to <strong>Unifoods</strong>! We are delighted to have you onboard as our customer. We look forward to building a long-term and mutually beneficial association with you.
          </p>

          <!-- Account Credentials Card (Kept Intact) -->
          <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 18px 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #0f172a; font-size: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">🔑 Your Account Login Credentials</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px;">
              <tr>
                <td style="padding: 5px 0; color: #64748b; width: 130px;">Username / Email:</td>
                <td style="padding: 5px 0; font-weight: bold; color: #0f172a;">${username}</td>
              </tr>
              ${password ? `
              <tr>
                <td style="padding: 5px 0; color: #64748b;">Password:</td>
                <td style="padding: 5px 0; font-weight: bold; color: #d97706;">${password}</td>
              </tr>
              ` : ''}
              <tr>
                <td style="padding: 5px 0; color: #64748b;">Entity Name:</td>
                <td style="padding: 5px 0; font-weight: bold; color: #0f172a;">${businessName || name}</td>
              </tr>
            </table>
          </div>

          ${creditSectionHtml}
          ${changePasswordSectionHtml}

          <!-- 1. CUSTOMER INFORMATION -->
          <div style="margin-top: 25px; border-top: 2px solid #f1f5f9; padding-top: 15px;">
            <h3 style="color: #b45309; font-size: 15px; text-transform: uppercase; margin-bottom: 12px; font-weight: bold;">1. CUSTOMER INFORMATION</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.5;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 180px; font-weight: bold;">Entity Name:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${businessName || name}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold; vertical-align: top;">Billing Address:</td>
                <td style="padding: 6px 0; color: #334155;">${addressText}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold; vertical-align: top;">Delivery Address:</td>
                <td style="padding: 6px 0; color: #334155;">${addressText}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold; vertical-align: top;">Additional Delivery Points / Outlets:</td>
                <td style="padding: 6px 0; color: #334155;">${outletsHtml}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold; vertical-align: top;">Outlet-wise FSSAI Details:</td>
                <td style="padding: 6px 0; color: #334155;">${fssaiDetailsHtml}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold;">GST Details:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${gstDisplayText}</td>
              </tr>
            </table>

            <div style="background-color: #fff8e1; border-left: 4px solid #f59e0b; padding: 12px 15px; margin-top: 12px; border-radius: 6px; font-size: 12px; color: #78350f;">
              <p style="margin: 0 0 6px 0;">If GST details have not been provided, the account will be treated as URD (Unregistered Dealer) and no GST input tax credit can be claimed on such transactions.</p>
              <p style="margin: 0;">If GST registration is obtained subsequently, please update the valid GST details with Unifoods. Applicable GST input credit, wherever eligible, will be considered from the date on which the valid GST details are updated in our system.</p>
            </div>
          </div>

          <!-- 2. KEY CONTACTS AT CUSTOMER END -->
          <div style="margin-top: 25px; border-top: 2px solid #f1f5f9; padding-top: 15px;">
            <h3 style="color: #b45309; font-size: 15px; text-transform: uppercase; margin-bottom: 12px; font-weight: bold;">2. KEY CONTACTS AT CUSTOMER END</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 220px; font-weight: bold;">Order / Purchase Contact:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${orderContact}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold;">Goods Receiving Contact:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${goodsContact}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold;">Accounts / Payment Contact:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${accountsContact}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: bold;">Head of Accounts / Finance Contact:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: bold;">${headAccountsContact}</td>
              </tr>
            </table>
          </div>

          <!-- 3. ORDERING & DELIVERY GUIDELINES -->
          <div style="margin-top: 25px; border-top: 2px solid #f1f5f9; padding-top: 15px;">
            <h3 style="color: #b45309; font-size: 15px; text-transform: uppercase; margin-bottom: 12px; font-weight: bold;">3. ORDERING & DELIVERY GUIDELINES</h3>
            <ul style="padding-left: 20px; margin: 0; color: #334155; font-size: 13px; line-height: 1.6;">
              <li style="margin-bottom: 8px;"><strong>Order Processing TAT:</strong> Unifoods follows a standard 2 working day TAT for order processing and delivery, subject to product availability, order cut-off timings and delivery schedules.</li>
              <li style="margin-bottom: 8px;"><strong>Stock Availability / Rationing:</strong> In case any ordered product is unavailable, partially available, or subject to stock rationing, an automated notification will be initiated and the customer will be informed within 24 hours of receipt of the order.</li>
              <li style="margin-bottom: 8px;"><strong>Advance Payment Orders:</strong> Where supplies are against advance payment, a Proforma Invoice (PI) will be shared. Payment must be received as per the PI before the goods are released for dispatch.</li>
              <li style="margin-bottom: 8px;"><strong>Price Revision:</strong> Any price revision communicated to Unifoods by the respective principal/vendor will be applicable to the customer accordingly.</li>
              <li style="margin-bottom: 8px;"><strong>Stock Receipt & Discrepancies:</strong> Customers are requested to verify the quantity, product, packaging and physical condition of the stock at the time of delivery and acknowledge receipt accordingly. Any shortage, damage, leakage, mismatch or other discrepancy must be reported and recorded at the time of receipt. Discrepancies reported after acceptance of the goods may not be considered for claims or adjustments.</li>
              <li style="margin-bottom: 8px;"><strong>Terms of Business:</strong> All supplies will be governed by the commercial terms, credit terms, payment terms and other conditions mutually agreed between Unifoods and the customer.</li>
            </ul>
          </div>

          <!-- 4. UNIFOODS CONTACT DETAILS -->
          <div style="margin-top: 25px; border-top: 2px solid #f1f5f9; padding-top: 15px;">
            <h3 style="color: #b45309; font-size: 15px; text-transform: uppercase; margin-bottom: 12px; font-weight: bold;">4. UNIFOODS CONTACT DETAILS</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 5px 0; color: #64748b; width: 220px; font-weight: bold;">Order Desk:</td>
                <td style="padding: 5px 0; color: #0f172a; font-weight: bold;">+91 91754 44555 / orders@unifoods.in</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #64748b; font-weight: bold;">Logistics Coordinator:</td>
                <td style="padding: 5px 0; color: #0f172a; font-weight: bold;">+91 91754 44556</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #64748b; font-weight: bold;">Accounts Receivable / Collections:</td>
                <td style="padding: 5px 0; color: #0f172a; font-weight: bold;">+91 91754 44557</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #64748b; font-weight: bold;">Accounts Department:</td>
                <td style="padding: 5px 0; color: #0f172a; font-weight: bold;">+91 91754 44558</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #64748b; font-weight: bold;">Customer Care:</td>
                <td style="padding: 5px 0; color: #0f172a; font-weight: bold;">+91 91754 44559 / support@unifoods.in</td>
              </tr>
            </table>
          </div>

          <!-- 5. CUSTOMER CONFIRMATION & ACCEPTANCE -->
          <div style="margin-top: 25px; border-top: 2px solid #f1f5f9; padding-top: 15px;">
            <h3 style="color: #b45309; font-size: 15px; text-transform: uppercase; margin-bottom: 12px; font-weight: bold;">5. CUSTOMER CONFIRMATION & ACCEPTANCE</h3>
            <p style="font-size: 13px; color: #334155; margin-bottom: 10px;">
              I/We confirm that the above customer, billing, delivery, outlet, FSSAI, GST and contact information has been provided/verified by me/us and is correct to the best of my/our knowledge.
            </p>
            <p style="font-size: 13px; color: #334155; margin-bottom: 10px;">
              I/We further confirm that I/we have read, understood and accepted the above ordering, delivery, stock receipt, discrepancy, payment, price revision and other terms and conditions applicable to our business relationship with Unifoods.
            </p>
            <p style="font-size: 13px; color: #334155; margin-bottom: 15px;">
              I/We undertake to promptly inform Unifoods of any change in the above information, including GST registration/details, delivery locations or authorised contacts.
            </p>

            <div style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 18px; font-size: 13px;">
              <strong style="color: #0f172a; font-size: 14px; display: block; margin-bottom: 10px;">Customer Acceptance:</strong>
              <table style="width: 100%; border-collapse: collapse; line-height: 1.8;">
                <tr><td style="width: 220px; color: #64748b;">Customer / Entity Name:</td><td style="color: #0f172a; font-weight: bold;">${businessName || name}</td></tr>
                <tr><td style="color: #64748b;">Authorised Person Name:</td><td style="color: #0f172a;">${name || '____________________________'}</td></tr>
                <tr><td style="color: #64748b;">Designation:</td><td style="color: #0f172a;">____________________________</td></tr>
                <tr><td style="color: #64748b;">Mobile Number:</td><td style="color: #0f172a;">${phone || '____________________________'}</td></tr>
                <tr><td style="color: #64748b;">Email ID:</td><td style="color: #0f172a;">${email}</td></tr>
                <tr><td style="color: #64748b;">Date:</td><td style="color: #0f172a;">${new Date().toLocaleDateString('en-IN')}</td></tr>
                <tr><td style="color: #64748b;">Acceptance / Authorised Signatory:</td><td style="color: #0f172a;">____________________________</td></tr>
              </table>
            </div>
          </div>

          <!-- Action Button -->
          <div style="text-align: center; margin: 30px 0 20px 0;">
            <a href="https://horeca-user-end.vercel.app/login" style="background-color: #d97706; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 25px; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 10px rgba(217, 119, 6, 0.3);">Login to Your Account</a>
          </div>

          <p style="font-size: 13px; color: #64748b; margin-top: 25px;">
            Thank you for choosing Unifoods. We look forward to serving you.
          </p>

          <div style="margin-top: 20px; font-size: 13px; color: #0f172a;">
            <strong>Regards,</strong><br/>
            <strong>Team Unifoods</strong><br/>
            Unifoods Supply Chain Private Limited<br/>
            <span style="color: #64748b; font-size: 12px;">Email: support@unifoods.in | Website: www.unifoods.in</span>
          </div>

        </div>

        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0;">© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `
Welcome to Unifoods – Customer Onboarding, Account Details & Acceptance

Dear ${entityDisplayName},

Welcome to Unifoods!

We are delighted to have you onboard as our customer. We look forward to building a long-term and mutually beneficial association with you.

YOUR ACCOUNT LOGIN CREDENTIALS:
- Username / Email: ${username}
${password ? `- Password: ${password}` : ''}
- Entity Name: ${businessName || name}

1. CUSTOMER INFORMATION
- Entity Name: ${businessName || name}
- Billing Address: ${addressText}
- Delivery Address: ${addressText}
- Additional Delivery Points / Outlets: ${outletsText}
- Outlet-wise FSSAI Details: ${fssaiDetailsText}
- GST Details: ${gstDisplayText}

If GST details have not been provided, the account will be treated as URD (Unregistered Dealer) and no GST input tax credit can be claimed on such transactions.
If GST registration is obtained subsequently, please update the valid GST details with Unifoods. Applicable GST input credit, wherever eligible, will be considered from the date on which the valid GST details are updated in our system.

2. KEY CONTACTS AT CUSTOMER END
- Order / Purchase Contact: ${orderContact}
- Goods Receiving Contact: ${goodsContact}
- Accounts / Payment Contact: ${accountsContact}
- Head of Accounts / Finance Contact: ${headAccountsContact}

3. ORDERING & DELIVERY GUIDELINES
- Order Processing TAT: Unifoods follows a standard 2 working day TAT for order processing and delivery, subject to product availability, order cut-off timings and delivery schedules.
- Stock Availability / Rationing: In case any ordered product is unavailable, partially available, or subject to stock rationing, an automated notification will be initiated and the customer will be informed within 24 hours of receipt of the order.
- Advance Payment Orders: Where supplies are against advance payment, a Proforma Invoice (PI) will be shared. Payment must be received as per the PI before the goods are released for dispatch.
- Price Revision: Any price revision communicated to Unifoods by the respective principal/vendor will be applicable to the customer accordingly.
- Stock Receipt & Discrepancies: Customers are requested to verify the quantity, product, packaging and physical condition of the stock at the time of delivery and acknowledge receipt accordingly. Any shortage, damage, leakage, mismatch or other discrepancy must be reported and recorded at the time of receipt. Discrepancies reported after acceptance of the goods may not be considered for claims or adjustments.
- Terms of Business: All supplies will be governed by the commercial terms, credit terms, payment terms and other conditions mutually agreed between Unifoods and the customer.

4. UNIFOODS CONTACT DETAILS
- Order Desk: +91 91754 44555 / orders@unifoods.in
- Logistics Coordinator: +91 91754 44556
- Accounts Receivable / Collections: +91 91754 44557
- Accounts Department: +91 91754 44558
- Customer Care: +91 91754 44559 / support@unifoods.in

5. CUSTOMER CONFIRMATION & ACCEPTANCE
I/We confirm that the above customer, billing, delivery, outlet, FSSAI, GST and contact information has been provided/verified by me/us and is correct to the best of my/our knowledge.
I/We further confirm that I/we have read, understood and accepted the above ordering, delivery, stock receipt, discrepancy, payment, price revision and other terms and conditions applicable to our business relationship with Unifoods.
I/We undertake to promptly inform Unifoods of any change in the above information, including GST registration/details, delivery locations or authorised contacts.

Customer Acceptance:
Customer / Entity Name: ${businessName || name}
Authorised Person Name: ${name || '____________________________'}
Designation: ____________________________
Mobile Number: ${phone || '____________________________'}
Email ID: ${email}
Date: ${new Date().toLocaleDateString('en-IN')}
Acceptance / Authorised Signatory: ____________________________

Thank you for choosing Unifoods. We look forward to serving you.

Regards,
Team Unifoods
Unifoods Supply Chain Private Limited
support@unifoods.in | www.unifoods.in
  `.trim();

  let finalSubject = `Welcome to Unifoods – Customer Onboarding, Account Details & Acceptance`;
  let finalHtml = html;
  let finalText = text;

  try {
    await dbConnect();
    const customTemplateSetting = await Setting.findOne({ key: "customer_welcome_email_template" });
    if (customTemplateSetting && customTemplateSetting.value) {
      const template = customTemplateSetting.value;
      const variables = {
        entityDisplayName, businessName, name, username, password, email, phone, addressText,
        outletsText, outletsHtml, fssaiDetailsText, fssaiDetailsHtml, gstDisplayText,
        orderContact, goodsContact, accountsContact, headAccountsContact,
        creditSectionHtml, changePasswordSectionHtml
      };
      
      if (template.subject) finalSubject = replacePlaceholders(template.subject, variables);
      if (template.bodyText) {
        finalText = replacePlaceholders(template.bodyText, variables);
        finalHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>${finalSubject}</title>
          </head>
          <body style="font-family: Arial, Helvetica, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
            <div style="max-width: 680px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
              
              <!-- Header -->
              <div style="background-color: #d97706; padding: 25px 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">Welcome to Unifoods!</h1>
              </div>

              <!-- Body -->
              <div style="padding: 30px; color: #1e293b; line-height: 1.6; font-size: 14px; white-space: pre-wrap;">${finalText}</div>

              <!-- Footer -->
              <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0;">© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `;
      }
    }
  } catch (err) {
    console.error("Error fetching custom customer welcome email template:", err);
  }

  return await sendEmail({
    to: email,
    subject: finalSubject,
    text: finalText,
    html: finalHtml,
  });
};

export const sendSupplierWelcomeEmail = async ({
  email,
  name,
  businessName,
  password,
  gstNumber,
  supplierId,
}) => {
  console.log(`📩 [Welcome Email Request] Received welcome email request for supplier:`, { email, name, businessName, gstNumber, supplierId });

  if (!email || !email.trim()) {
    console.warn("⚠️ [Welcome Email Skipped] No valid email address provided.");
    return { success: false, error: "No email address provided" };
  }

  const isUrg = gstNumber === "URG" || gstNumber === "Unregistered" || !gstNumber;
  console.log(`📋 [Welcome Email Details] Supplier URG Status: ${isUrg ? "Unregistered (URG)" : "GST Registered (" + gstNumber + ")"}`);

  const gstSectionHtml = isUrg
    ? `<div style="background-color: #fff8e1; border-left: 4px solid #ffa000; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
        <strong style="color: #b78103; font-size: 14px; display: block; margin-bottom: 4px;">GST Registration Notice:</strong>
        <p style="margin: 0; color: #5d4037; font-size: 13px; font-weight: bold;">
          You are registered as an unregistered supplier (URG).
        </p>
       </div>`
    : `<div style="background-color: #f1f8e9; border-left: 4px solid #7cb342; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
        <strong style="color: #33691e; font-size: 14px; display: block; margin-bottom: 4px;">GST Registration Details:</strong>
        <p style="margin: 0; color: #2e7d32; font-size: 13px;">
          GSTIN: <strong>${gstNumber}</strong>
        </p>
       </div>`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Welcome to Unifoods Supplier Network</title>
    </head>
    <body style="font-family: Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #e0e0e0;">
        
        <!-- Header -->
        <div style="background-color: #d97706; padding: 25px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">Welcome to Unifoods!</h1>
          <p style="color: #fef3c7; margin: 6px 0 0 0; font-size: 14px;">Your B2B Food & Supply Partner</p>
        </div>

        <!-- Body -->
        <div style="padding: 30px; color: #333333; line-height: 1.6;">
          <p style="font-size: 16px; margin-top: 0;">Dear <strong>${name || businessName || "Valued Supplier"}</strong>,</p>
          <p style="font-size: 14px; color: #555555;">
            Thank you for registering with <strong>Unifoods</strong> as a supplier. Your account has been successfully created.
          </p>

          <!-- Account Credentials Card -->
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #1e293b; font-size: 15px; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px;">Your Account Login Credentials</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 110px;">Email/Username:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${email}</td>
              </tr>
              ${password ? `
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Password:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #d97706;">${password}</td>
              </tr>
              ` : ''}
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Business:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${businessName}</td>
              </tr>
            </table>
          </div>

          ${gstSectionHtml}

          <div style="text-align: center; margin: 30px 0 20px 0;">
            <a href="${process.env.SCM_URL || "https://horeca-scm.vercel.app"}/login" style="background-color: #d97706; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 25px; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 10px rgba(217, 119, 6, 0.3);">Login to Your Account</a>
          </div>

          <p style="font-size: 13px; color: #777777; margin-top: 25px;">
            If you have any questions or need assistance, please feel free to reply to this email or contact our support team.
          </p>
        </div>

        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0;">© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `
Welcome to Unifoods!

Dear ${name || businessName || "Valued Supplier"},

Thank you for registering with Unifoods as a supplier. Your account has been successfully created.

YOUR ACCOUNT LOGIN CREDENTIALS:
- Email/Username: ${email}
${password ? `- Password: ${password}` : ''}
- Business Name: ${businessName}

${isUrg ? "GST NOTICE: You are registered as an unregistered supplier (URG)." : `GSTIN: ${gstNumber}`}

Login to your account: ${process.env.SCM_URL || "https://horeca-scm.vercel.app"}/login

If you have any questions or need assistance, please feel free to reply to this email.

© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.
  `.trim();

  let finalSubject = `Welcome to Unifoods - Your Supplier Account Credentials`;
  let finalHtml = html;
  let finalText = text;

  try {
    await dbConnect();
    const customTemplateSetting = await Setting.findOne({ key: "supplier_welcome_email_template" });
    if (customTemplateSetting && customTemplateSetting.value) {
      const template = customTemplateSetting.value;
      const variables = {
        name, businessName, email, password, gstNumber, gstSectionHtml, isUrg
      };
      
      if (template.subject) finalSubject = replacePlaceholders(template.subject, variables);
      if (template.bodyText) {
        finalText = replacePlaceholders(template.bodyText, variables);
        finalHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>${finalSubject}</title>
          </head>
          <body style="font-family: Arial, Helvetica, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
            <div style="max-width: 680px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
              
              <!-- Header -->
              <div style="background-color: #d97706; padding: 25px 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">Welcome to Unifoods!</h1>
              </div>

              <!-- Body -->
              <div style="padding: 30px; color: #1e293b; line-height: 1.6; font-size: 14px; white-space: pre-wrap;">${finalText}</div>

              <!-- Footer -->
              <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0;">© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `;
      }
    }
  } catch (err) {
    console.error("Error fetching custom supplier welcome email template:", err);
  }

  return await sendEmail({
    to: email,
    subject: finalSubject,
    text: finalText,
    html: finalHtml,
  });
};

export const sendCustomerPasswordResetEmail = async ({
  email,
  name,
  businessName,
  resetToken,
}) => {
  console.log(`📩 [Password Reset Email] Received password reset request for:`, { email, name, businessName });

  if (!email || !email.trim()) {
    return { success: false, error: "No email address provided" };
  }

  let frontendUrl = process.env.RESET_URL_BASE || "https://horeca-user-end.vercel.app";
  if (process.env.NODE_ENV === "development") {
    frontendUrl = "http://localhost:3000"; // Fallback for local web frontend
  }
  const resetPasswordUrl = `${frontendUrl.replace(/\/$/, "")}/change-password?token=${resetToken}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Password Reset - Unifoods</title>
    </head>
    <body style="font-family: Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #e0e0e0;">
        
        <!-- Header -->
        <div style="background-color: #d97706; padding: 25px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">Password Reset</h1>
          <p style="color: #fef3c7; margin: 6px 0 0 0; font-size: 14px;">Unifoods Security</p>
        </div>

        <!-- Body -->
        <div style="padding: 30px; color: #333333; line-height: 1.6;">
          <p style="font-size: 16px; margin-top: 0;">Dear <strong>${name || businessName || "Valued Customer"}</strong>,</p>
          <p style="font-size: 14px; color: #555555;">
            We received a request to reset the password for your Unifoods account associated with <strong>${email}</strong>.
          </p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetPasswordUrl}" style="background-color: #d97706; color: #ffffff; text-decoration: none; padding: 14px 35px; border-radius: 25px; font-weight: bold; font-size: 15px; display: inline-block; box-shadow: 0 4px 10px rgba(217, 119, 6, 0.3);">Reset My Password</a>
          </div>

          <div style="background-color: #fff3e0; border-left: 4px solid #ff9800; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
            <strong style="color: #e65100; font-size: 14px; display: block; margin-bottom: 4px;">Security Notice:</strong>
            <p style="margin: 0; color: #e65100; font-size: 13px;">
              This link will expire in 7 days. If you did not request a password reset, you can safely ignore this email.
            </p>
          </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0;">© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `
Password Reset Request

Dear ${name || businessName || "Valued Customer"},

We received a request to reset the password for your Unifoods account.
Please click the link below to securely reset your password:

${resetPasswordUrl}

This link will expire in 7 days. If you did not request a password reset, you can safely ignore this email.

© ${new Date().getFullYear()} Unifoods Supply Chain. All rights reserved.
  `.trim();

  return await sendEmail({
    to: email,
    subject: "Reset Your Unifoods Password",
    text,
    html,
  });
};
