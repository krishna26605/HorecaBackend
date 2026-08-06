import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { sendCustomerWelcomeEmail } from "@/lib/mail";

// Helper to escape XML entities
const escapeXML = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Helper to format Date for Tally (YYYYMMDD)
const formatTallyDate = (dateVal) => {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

// Helper to build Customer XML for Tally
function buildCustomerXML(customer) {
  const name = escapeXML(customer.name || customer.businessName || customer.phone || "Unknown Customer");
  const mongoId = escapeXML(customer._id.toString());
  const mailingName = escapeXML(customer.businessName || customer.name || customer.phone || "Unknown Customer");
  
  const address = escapeXML(customer.address || "");
  const city = escapeXML(customer.city || "");
  const state = escapeXML(customer.state || "Maharashtra");
  const pincode = escapeXML(customer.pincode || "");
  
  const phone = escapeXML(customer.phone || "");
  const email = escapeXML(customer.email || "");
  const gstNumber = escapeXML(customer.gstNumber || ""); 

  let addressXml = "";
  if (address || city) {
    addressXml = `<ADDRESS.LIST TYPE="String">
              ${address ? `<ADDRESS>${address}</ADDRESS>` : ''}
              ${city ? `<ADDRESS>${city}</ADDRESS>` : ''}
            </ADDRESS.LIST>`;
  }

  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>${name}</NAME>
                <NAME>${mongoId}</NAME>
              </NAME.LIST>
              <LANGUAGECODE> 1033</LANGUAGECODE>
            </LANGUAGENAME.LIST>
            <PARENT>${escapeXML(customer.customerGroup || "Sundry Debtors")}</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <MAILINGNAME>${mailingName}</MAILINGNAME>
            ${addressXml}
            <STATENAME>${state}</STATENAME>
            <COUNTRYNAME>India</COUNTRYNAME>
            ${pincode ? `<PINCODE>${pincode}</PINCODE>` : ''}
            ${phone ? `<MOBILE>${phone}</MOBILE>` : ''}
            ${email ? `<EMAIL>${email}</EMAIL>` : ''}
            <GSTREGISTRATIONTYPE>${gstNumber ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>
            ${gstNumber ? `<PARTYGSTIN>${gstNumber}</PARTYGSTIN>` : ''}
            ${customer.gstEffectiveDate ? `<GSTAPPLICABLEDATE>${formatTallyDate(customer.gstEffectiveDate)}</GSTAPPLICABLEDATE>` : ''}
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to parse Tally responses
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


export async function POST(request) {
  console.log("🔥 HIT /api/customers/create");

  try {
    await dbConnect();
    console.log("🟢 MongoDB Connected");

    const body = await request.json().catch(() => ({}));
    console.log("📩 Request Body:", body);

    const { phone, name, email, address, city, state, pincode, lat, lng, customerType, department, hasMultipleOutlets, outlets, isContractBased, contract, contractType, contractDocumentUrl, contractStartDate, contractExpiryDate, contractNotes } = body;

    if (!phone) {
      console.log("❌ Missing phone");
      return NextResponse.json(
        { success: false, error: "Phone is required" },
        { status: 400 }
      );
    }

    console.log("➡️ Phone:", phone);

    // Normalize: strip non-digits
    const numericPhone = phone.replace(/\D/g, "");
    // Standardize: ensure +91 for 10-digit Indian numbers
    const standardizedPhone = (numericPhone.length === 10) ? `+91${numericPhone}` : 
                              (numericPhone.length === 12 && numericPhone.startsWith("91")) ? `+${numericPhone}` :
                              phone.trim();

    // Look for variations to match existing users
    const variations = [phone.trim(), standardizedPhone, numericPhone];
    if (numericPhone.length === 12 && numericPhone.startsWith("91")) {
        variations.push(numericPhone.slice(2)); // handle without 91
    } else if (numericPhone.length === 10) {
        variations.push("91" + numericPhone); // handle with 91
    }

    // Does customer already exist?
    let customer = await Customer.findOne({ phone: { $in: variations } });

    if (customer) {
      console.log("🟡 Existing customer found:", customer._id);

      // Update lastLoginAt
      customer.lastLoginAt = new Date();
      await customer.save();

      return NextResponse.json({
        success: true,
        message: "Customer already exists. Returning record.",
        data: customer,
      });
    }

    // Create new customer
    console.log("🆕 Creating new customer…");

    const generateSystemPassword = () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      let randomStr = "";
      for (let i = 0; i < 6; i++) {
        randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return `Unifoods@${randomStr}`;
    };

    const rawPassword = body.password ? body.password.trim() : generateSystemPassword();
    const generatedUsername = email ? email.toLowerCase().trim() : (body.username ? body.username.trim() : (name ? name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : numericPhone));

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(rawPassword, salt);

    const newCustomer = await Customer.create({
      username: generatedUsername,
      password: hashedPassword,
      phone: standardizedPhone,
      name: name ?? null,
      email: email ?? null,
      address: address ?? null,
      city: city ?? null,
      state: state ?? null,
      pincode: pincode ?? null,
      lat: lat ?? null,
      lng: lng ?? null,
      location: lat != null && lng != null ? { type: "Point", coordinates: [lng, lat] } : undefined,
      businessName: body.businessName?.trim() || name?.trim() || null,
      gstNumber: body.gstNumber?.trim() || null,
      gstEffectiveDate: body.gstEffectiveDate || null,
      gstDocUrl: body.gstDocUrl || null,
      category: body.category || "C",
      customerGroup: body.customerGroup || body.tallyGroup || "Sundry Debtors",
      advanceBalance: Number(body.advanceAmount || 0),
      advancePaymentMode: body.advancePaymentMode || null,
      advancePaymentProofUrl: body.advancePaymentProofUrl || null,
      poMandatory: Boolean(body.poMandatory),
      licenseImage: body.licenseImage || null,
      customerType: customerType ?? null,
      department: department ?? null,
      panNumber: body.panNumber ? body.panNumber.trim().toUpperCase() : null,
      assignedRoute: body.assignedRoute || null,
      routeName: body.routeName || null,
      routeCode: body.routeCode || null,
      creditTerm: Number(body.creditTerm || 0),
      creditLimit: Number(body.creditLimit || 0),
      hasMultipleOutlets: Boolean(hasMultipleOutlets),
      outlets: Array.isArray(outlets) ? outlets.map(o => ({
        outletName: o.outletName?.trim() || "",
        address: o.address?.trim() || "",
        city: o.city?.trim() || "",
        state: o.state?.trim() || "",
        pincode: o.pincode?.trim() || "",
        contactPerson: o.contactPerson?.trim() || null,
        contactPhone: o.contactPhone?.trim() || null,
        lat: o.lat != null ? o.lat : null,
        lng: o.lng != null ? o.lng : null
      })) : [],
      locations: [
        {
          outletName: "Main Branch",
          address: address?.trim() || "",
          city: city?.trim() || "",
          state: state?.trim() || "",
          pincode: pincode?.trim() || "",
          lat: lat ?? null,
          lng: lng ?? null,
          isPrimary: true
        },
        ...(Array.isArray(outlets) ? outlets.map(o => ({
          outletName: o.outletName?.trim() || "",
          address: o.address?.trim() || "",
          city: o.city?.trim() || "",
          state: o.state?.trim() || "",
          pincode: o.pincode?.trim() || "",
          contactPerson: o.contactPerson?.trim() || null,
          contactPhone: o.contactPhone?.trim() || null,
          isPrimary: false
        })) : [])
      ],
      urcDocUrl: body.urcDocUrl || null,
      hasFssai: body.hasFssai !== undefined ? Boolean(body.hasFssai) : true,
      fssaiNumber: body.fssaiNumber ? body.fssaiNumber.trim() : null,
      fssaiExpiryDate: body.fssaiExpiryDate ? new Date(body.fssaiExpiryDate) : null,
      fssaiDocUrl: body.fssaiDocUrl || null,
      fssaiUndertakingDocUrl: body.fssaiUndertakingDocUrl || null,
      licenseExpiryDate: body.licenseExpiryDate ? new Date(body.licenseExpiryDate) : null,
      isContractBased: Boolean(isContractBased),
      contract: isContractBased ? {
        contractType: contract?.contractType || contractType || null,
        documentUrl: contract?.documentUrl || contractDocumentUrl || null,
        startDate: contract?.startDate || contractStartDate ? new Date(contract?.startDate || contractStartDate) : null,
        expiryDate: contract?.expiryDate || contractExpiryDate ? new Date(contract?.expiryDate || contractExpiryDate) : null,
        notes: contract?.notes || contractNotes || null,
        uploadedAt: new Date()
      } : undefined,
      lastLoginAt: new Date(),
    });

    console.log("🟢 Customer Created:", newCustomer._id);

    // 📧 Send Automated Welcome Email to Customer
    try {
      if (newCustomer.email) {
        const isUrgCustomer = body.isUrg || body.gstNumber === "URG" || newCustomer.gstNumber === "URG";
        await sendCustomerWelcomeEmail({
          email: newCustomer.email,
          name: newCustomer.name || newCustomer.businessName,
          businessName: newCustomer.businessName || newCustomer.name || "Valued Business",
          username: newCustomer.username || newCustomer.phone,
          password: rawPassword,
          gstNumber: isUrgCustomer ? "URG" : (newCustomer.gstNumber || "URG"),
          creditTerm: newCustomer.creditTerm || 0,
          creditLimit: newCustomer.creditLimit || 0,
          customerId: newCustomer._id.toString()
        });
        console.log(`[Email Notification] Welcome email sent to ${newCustomer.email}`);
      }
    } catch (mailErr) {
      console.error("[Email Notification Error] Failed to send email:", mailErr);
    }

    // Sync Customer Ledger to Tally Prime 9
    const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
    let tallyCustomerSynced = false;
    let tallyCustomerError = null;

    try {
      const xmlPayload = buildCustomerXML(newCustomer);
      console.log(`[Tally Sync] Sending POST to Tally at URL: ${tallyUrl}`);
      console.log(`[Tally Sync] Generated XML Payload:\n${xmlPayload}`);

      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'ngrok-skip-browser-warning': 'true'
        },
        body: xmlPayload
      });

      console.log(`[Tally Sync] Received response from Tally. Status: ${tallyResponse.status} ${tallyResponse.statusText}`);

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        console.log(`[Tally Sync] Raw Tally Response Text:\n${responseText}`);

        const parsed = parseTallyResponse(responseText);
        console.log(`[Tally Sync] Parsed Response Success:`, parsed.success);

        if (parsed.success) {
          tallyCustomerSynced = true;
          console.log(`[Tally Sync] Customer synced successfully to Tally.`);
          
          // Fetch the generated GUID from Tally and store it
          try {
            const guidPayload = `<ENVELOPE>
              <HEADER>
                <VERSION>1</VERSION>
                <TALLYREQUEST>EXPORT</TALLYREQUEST>
                <TYPE>COLLECTION</TYPE>
                <ID>LedgerCollection</ID>
              </HEADER>
              <BODY>
                <DESC>
                  <STATICVARIABLES>
                    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                    <SVCURRENTCOMPANY>${escapeXML(process.env.TALLY_SALES_COMPANY || 'Unifoods')}</SVCURRENTCOMPANY>
                  </STATICVARIABLES>
                  <TDL>
                    <TDLMESSAGE>
                      <COLLECTION NAME="LedgerCollection">
                        <TYPE>Ledger</TYPE>
                        <FETCH>GUID</FETCH>
                        <FILTER>NameFilter</FILTER>
                      </COLLECTION>
                      <SYSTEM TYPE="Formulae" NAME="NameFilter">
                        $_Id = "${escapeXML(newCustomer._id.toString())}"
                      </SYSTEM>
                    </TDLMESSAGE>
                  </TDL>
                </DESC>
              </BODY>
            </ENVELOPE>`;
            
            const guidResponse = await fetch(tallyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/xml' },
              body: guidPayload
            });
            
            if (guidResponse.ok) {
              const guidXml = await guidResponse.text();
              const guidMatch = guidXml.match(/<GUID>([^<]+)<\/GUID>/);
              if (guidMatch && guidMatch[1]) {
                newCustomer.tallyId = guidMatch[1];
                await newCustomer.save();
                console.log(`[Tally Sync] Fetched and stored Tally GUID: ${newCustomer.tallyId}`);
              }
            }
          } catch (guidErr) {
            console.error(`[Tally Sync] Failed to fetch GUID for customer:`, guidErr);
          }
        } else {
          tallyCustomerError = parsed.error;
          console.error(`[Tally Sync] Tally error syncing customer:`, parsed.error);
        }
      } else {
        tallyCustomerError = `Tally server responded with status ${tallyResponse.status}`;
        console.error(`[Tally Sync] Tally server responded with status ${tallyResponse.status}`);
      }
    } catch (err) {
      tallyCustomerError = err.message || String(err);
      console.error(`[Tally Sync] Exception syncing customer:`, err);
    }

    return NextResponse.json({
      success: true,
      message: "Customer created successfully",
      data: newCustomer,
      tallyCustomerSynced,
      tallyCustomerError
    });
  } catch (err) {
    console.error("❌ ERROR in /api/customers/create:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
